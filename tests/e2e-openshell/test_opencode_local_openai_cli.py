#!/usr/bin/env python3
"""
Pure CLI E2E for OpenCode running against a local OpenAI-compatible endpoint.
"""

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass

import pytest

from openshell_testkit import (
    SandboxCase,
    assert_success,
    fail_with_history,
    fail_with_result,
    generate_configs,
    render_transcript,
    run_command,
    shell_join,
    write_generated_config,
)


OPENCODE_SETTINGS_PATH = '.config/opencode/opencode.json'
OPENAI_PROVIDER_ID = 'openai'
SMOKE_PROMPT = '2+2=? Reply with just the number.'
DEFAULT_LOCAL_OPENAI_MODEL = 'qwen3.5:9b'
DEFAULT_LOCAL_OPENAI_PORT = 8134
DEFAULT_LOCAL_OPENAI_CTX_SIZE = 16384
RAMALAMA_CONTAINER_NAME = 'kaiden-e2e-openai'


@dataclass(frozen=True)
class LocalOpenAIConfig:
    base_url: str
    model: str
    provider_id: str


def _first_env(names):
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def _env_flag(name):
    return os.environ.get(name, '').strip().lower() in {'1', 'true', 'yes', 'on'}


def _wait_for_models(base_url, process=None, timeout=180):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            break
        try:
            models = _read_models(base_url, skip_on_failure=False)
            if models:
                return models
        except RuntimeError as exc:
            last_error = exc
        time.sleep(1)

    if process is not None and process.poll() is not None:
        pytest.skip(f'ramalama serve exited before {base_url} was ready')
    pytest.skip(f'OpenAI-compatible endpoint did not become ready at {base_url}: {last_error}')


def _run_ramalama(args, *, timeout=180):
    try:
        return subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def _read_models(base_url, *, skip_on_failure=True):
    request = urllib.request.Request(f'{base_url.rstrip("/")}/models')
    request.add_header('Authorization', 'Bearer unused')
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode('utf-8')
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        message = f'OpenAI-compatible endpoint is not reachable at {base_url}: {exc}'
        if skip_on_failure:
            pytest.skip(message)
        raise RuntimeError(message) from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        message = f'OpenAI-compatible /models response is not valid JSON: {exc}'
        if skip_on_failure:
            pytest.skip(message)
        raise RuntimeError(message) from exc

    models = parsed.get('data')
    if not isinstance(models, list):
        message = 'OpenAI-compatible /models response did not include a data array'
        if skip_on_failure:
            pytest.skip(message)
        raise RuntimeError(message)

    return [entry.get('id') for entry in models if isinstance(entry, dict) and entry.get('id')]


def _require_ramalama():
    result = _run_ramalama(['ramalama', '--version'], timeout=15)
    if result is None:
        pytest.skip('KAIDEN_E2E_LOCAL=true but ramalama --version did not run')
    if result.returncode != 0:
        pytest.skip(f'KAIDEN_E2E_LOCAL=true but ramalama --version failed: {result.stderr.strip()}')

    version_output = (result.stdout + result.stderr).strip()
    if not version_output:
        pytest.skip('KAIDEN_E2E_LOCAL=true but ramalama --version returned no output')
    return version_output


def _ramalama_serve_args(model, port, ctx_size, *, detach=False, name=None):
    args = ['ramalama', 'serve']
    if detach:
        args.extend(['--detach', '--name', name])
    args.extend(['--port', str(port), '--ctx-size', str(ctx_size), model])
    return args


@contextmanager
def _detached_ramalama_server(model, port, ctx_size, base_url):
    name = os.environ.get('KAIDEN_E2E_RAMALAMA_NAME', RAMALAMA_CONTAINER_NAME)
    _run_ramalama(['ramalama', 'stop', '--ignore', name], timeout=30)

    result = _run_ramalama(
        _ramalama_serve_args(model, port, ctx_size, detach=True, name=name),
        timeout=180,
    )
    if result is None or result.returncode != 0:
        yield False
        return

    try:
        _wait_for_models(base_url, timeout=180)
        yield True
    finally:
        _run_ramalama(['ramalama', 'stop', '--ignore', name], timeout=30)


@contextmanager
def _foreground_ramalama_server(model, port, ctx_size, base_url):
    process = subprocess.Popen(
        _ramalama_serve_args(model, port, ctx_size),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        _wait_for_models(base_url, process=process)
        yield base_url
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=15)


@contextmanager
def _detected_local_openai_server():
    if not _env_flag('KAIDEN_E2E_LOCAL'):
        yield None
        return

    _require_ramalama()

    model = _first_env(['KAIDEN_E2E_LOCAL_MODEL', 'KAIDEN_E2E_RAMALAMA_MODEL']) or DEFAULT_LOCAL_OPENAI_MODEL
    port = int(_first_env(['KAIDEN_E2E_LOCAL_PORT', 'KAIDEN_E2E_RAMALAMA_PORT']) or DEFAULT_LOCAL_OPENAI_PORT)
    ctx_size = int(
        _first_env(['KAIDEN_E2E_LOCAL_CTX_SIZE', 'KAIDEN_E2E_RAMALAMA_CTX_SIZE'])
        or DEFAULT_LOCAL_OPENAI_CTX_SIZE
    )
    base_url = f'http://localhost:{port}/v1'

    with _detached_ramalama_server(model, port, ctx_size, base_url) as detached:
        if detached:
            yield base_url
            return

    with _foreground_ramalama_server(model, port, ctx_size, base_url):
        yield base_url


@pytest.fixture(scope='module')
def local_openai_cli_config(request, gateway_ready):
    with _detected_local_openai_server() as local_base_url:
        base_url = local_base_url or _first_env(
            [
                'KAIDEN_E2E_OPENAI_BASE_URL',
                'KAIDEN_E2E_LOCAL_OPENAI_BASE_URL',
                'OPENAI_BASE_URL',
                'KAIDEN_E2E_RAMALAMA_BASE_URL',
                'RAMALAMA_OPENAI_BASE_URL',
            ]
        )
        if not base_url:
            pytest.skip(
                'OpenAI-compatible endpoint not configured; set KAIDEN_E2E_OPENAI_BASE_URL or KAIDEN_E2E_LOCAL=true'
            )

        models = _read_models(base_url)
        configured_model = _first_env(['KAIDEN_E2E_OPENAI_MODEL', 'OPENAI_MODEL', 'KAIDEN_E2E_RAMALAMA_MODEL'])
        model = configured_model or (models[0] if models else None)
        if not model:
            pytest.skip('OpenAI-compatible model not configured and /models returned no model IDs')

        if configured_model and configured_model not in models:
            pytest.skip(f'Configured OpenAI-compatible model {configured_model} was not returned by /models')

        yield LocalOpenAIConfig(base_url=base_url, model=model, provider_id=OPENAI_PROVIDER_ID)


@pytest.fixture(scope='module')
def opencode_local_openai_sandbox(local_openai_cli_config, gateway_ready, tmp_path_factory):
    sandbox_name = 'kdn-e2e-opencode-local-openai'
    temp_dir = tmp_path_factory.mktemp('kdn-e2e-opencode-local-openai')
    history = []
    sandbox_created = False

    run_command(['openshell', 'sandbox', 'delete', sandbox_name], timeout=30)

    try:
        generated = generate_configs(
            {
                'agent': 'opencode',
                'settingsPath': OPENCODE_SETTINGS_PATH,
                'modelLabel': local_openai_cli_config.model,
                'llmMetadataName': local_openai_cli_config.provider_id,
                'modelEndpoint': local_openai_cli_config.base_url,
            },
            history=history,
        )
    except RuntimeError as exc:
        fail_with_history(f'failed to generate OpenCode local OpenAI config: {exc}', history)

    if not generated.policy:
        fail_with_history('expected Kaiden to generate an OpenShell policy for the local OpenAI endpoint', history)
    policy_path, agent_config_paths = write_generated_config(generated, temp_dir)
    upload_args = [
        arg
        for config_file in agent_config_paths
        for arg in ['--upload', f'{config_file["local"]}:{config_file["remote"]}']
    ]
    env_args = [
        arg
        for entry in generated.workspace_environment
        for arg in ['--env', f'{entry["name"]}={entry["value"]}']
    ]

    create_sandbox_result = run_command(
        [
            'openshell',
            'sandbox',
            'create',
            '--name',
            sandbox_name,
            *env_args,
            *upload_args,
            '--no-tty',
            '--policy',
            policy_path,
            '--',
            'true',
        ],
        timeout=180,
        label='creating OpenCode local OpenAI sandbox',
        history=history,
    )
    assert_success(create_sandbox_result, 'OpenCode local OpenAI sandbox creation failed', history)
    sandbox_created = True

    yield SandboxCase(
        name=sandbox_name,
        config={
            'localOpenAIModel': local_openai_cli_config.model,
            'localOpenAIProvider': local_openai_cli_config.provider_id,
            'opencodeModel': f'{local_openai_cli_config.provider_id}/{local_openai_cli_config.model}',
        },
        generated_config=generated,
        history=history,
    )

    if sandbox_created:
        delete_result = run_command(
            ['openshell', 'sandbox', 'delete', sandbox_name],
            timeout=30,
            label=f'deleting sandbox {sandbox_name}',
        )
        if delete_result.returncode != 0:
            print(render_transcript(delete_result, label='sandbox delete'), flush=True)


def test_opencode_run_responds_with_local_openai(opencode_local_openai_sandbox):
    help_result = opencode_local_openai_sandbox.exec(['opencode', '--help'], timeout=30, label='checking opencode CLI')
    assert_success(help_result, 'opencode CLI is not available in the sandbox', opencode_local_openai_sandbox.history)

    if not re.search(r'\brun\b', help_result.stdout + help_result.stderr):
        fail_with_result(
            'opencode CLI does not advertise the run command',
            help_result,
            opencode_local_openai_sandbox.history,
        )

    local_openai_model = opencode_local_openai_sandbox.config['localOpenAIModel']
    local_openai_provider = opencode_local_openai_sandbox.config['localOpenAIProvider']
    opencode_model = opencode_local_openai_sandbox.config['opencodeModel']
    assert opencode_model == f'{local_openai_provider}/{local_openai_model}'

    run_cmd = ['opencode', 'run', SMOKE_PROMPT, '--model', opencode_model]
    run_result = opencode_local_openai_sandbox.exec(
        run_cmd,
        timeout=240,
        label=f'running: {shell_join(run_cmd)}',
    )
    assert_success(run_result, 'opencode run failed with local OpenAI inference', opencode_local_openai_sandbox.history)

    combined = '\n'.join(part for part in [run_result.stdout, run_result.stderr] if part).strip()
    if re.search(r'(^|\n)\s*Error:', combined):
        fail_with_result(
            'opencode run reported an error with local OpenAI inference',
            run_result,
            opencode_local_openai_sandbox.history,
        )

    if '4' not in combined:
        fail_with_result(
            'expected opencode run to answer 2+2 with 4',
            run_result,
            opencode_local_openai_sandbox.history,
        )
