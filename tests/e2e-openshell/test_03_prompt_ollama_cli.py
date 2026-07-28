#!/usr/bin/env python3
"""
Pure CLI E2E for OpenCode running against a local Ollama endpoint.

Mirrors test_03_prompt_openai_local_cli.py but targets Ollama's
OpenAI-compatible API at http://localhost:11434/v1 instead of ramalama.

Gate: OLLAMA_ENABLED=true  (set by .github/actions/setup-ollama)
Model: INFERENCE_MODEL     (e.g. granite3.2:2b, set by the same action)
"""

import json
import os
import re
import urllib.error
import urllib.request

import pytest

from agent_cases import (
    BRIAN_FOOD_SKILL_NAME,
    BRIAN_FOOD_SKILL_OUTPUT,
    BRIAN_FOOD_SKILL_PATH,
    BRIAN_FOOD_SKILL_PROMPT,
    agent_prompt_command,
)
from openshell_testkit import (
    SandboxCase,
    assert_success,
    cleanup_sandbox,
    fail_with_history,
    fail_with_result,
    generate_configs,
    generated_upload_args,
    render_transcript,
    run_command,
    sandbox_base_image_args,
    shell_join,
    write_generated_config,
)


OPENAI_PROVIDER_ID = 'openai'
SMOKE_PROMPT = '2+2=? Reply with just the number.'
DEFAULT_OLLAMA_PORT = 11434


def _env_flag(name):
    return os.environ.get(name, '').strip().lower() in {'1', 'true', 'yes', 'on'}


def _ollama_base_url():
    return os.environ.get(
        'KAIDEN_E2E_OLLAMA_BASE_URL',
        f'http://localhost:{DEFAULT_OLLAMA_PORT}/v1',
    )


def _read_ollama_models(base_url, *, skip_on_failure=True):
    request = urllib.request.Request(f'{base_url.rstrip("/")}/models')
    request.add_header('Authorization', 'Bearer unused')
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode('utf-8')
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        message = f'Ollama endpoint is not reachable at {base_url}: {exc}'
        if skip_on_failure:
            pytest.skip(message)
        raise RuntimeError(message) from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        message = f'Ollama /models response is not valid JSON: {exc}'
        if skip_on_failure:
            pytest.skip(message)
        raise RuntimeError(message) from exc

    models = parsed.get('data')
    if not isinstance(models, list):
        message = 'Ollama /models response did not include a data array'
        if skip_on_failure:
            pytest.skip(message)
        raise RuntimeError(message)

    return [entry.get('id') for entry in models if isinstance(entry, dict) and entry.get('id')]


@pytest.fixture(scope='module')
def ollama_cli_config(gateway_ready):
    if not _env_flag('OLLAMA_ENABLED'):
        pytest.skip('Ollama not enabled; set OLLAMA_ENABLED=true')

    base_url = _ollama_base_url()
    models = _read_ollama_models(base_url)

    configured_model = os.environ.get('INFERENCE_MODEL')
    model = configured_model or (models[0] if models else None)
    if not model:
        pytest.skip('Ollama model not configured and /models returned no model IDs')

    if configured_model and configured_model not in models:
        pytest.skip(f'Configured Ollama model {configured_model} was not returned by /models')

    yield {
        'base_url': base_url,
        'model': model,
        'provider_id': OPENAI_PROVIDER_ID,
    }


@pytest.fixture(scope='module')
def opencode_ollama_sandbox(ollama_cli_config, gateway_ready, tmp_path_factory):
    sandbox_name = 'ke-oc-ollama'
    temp_dir = tmp_path_factory.mktemp('ke-oc-ollama')
    history = []
    sandbox_created = False

    run_command(['openshell', 'sandbox', 'delete', sandbox_name], timeout=30)

    try:
        input_config = {
            'agent': 'opencode',
            'modelLabel': ollama_cli_config['model'],
            'llmMetadataName': ollama_cli_config['provider_id'],
            'modelEndpoint': ollama_cli_config['base_url'],
            'skills': [BRIAN_FOOD_SKILL_PATH],
        }

        generated = generate_configs(
            input_config,
            source_path=temp_dir / 'workspace',
            history=history,
        )
    except RuntimeError as exc:
        fail_with_history(f'failed to generate OpenCode Ollama config: {exc}', history)

    if not generated.policy:
        fail_with_history('expected Kaiden to generate an OpenShell policy for the Ollama endpoint', history)
    policy_path, agent_config_paths = write_generated_config(generated, temp_dir)
    upload_args = generated_upload_args(generated, agent_config_paths)
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
            *sandbox_base_image_args(generated),
            *env_args,
            *upload_args,
            '--no-tty',
            '--policy',
            policy_path,
            '--',
            'true',
        ],
        timeout=180,
        label='creating OpenCode Ollama sandbox',
        history=history,
    )
    assert_success(create_sandbox_result, 'OpenCode Ollama sandbox creation failed', history)
    sandbox_created = True

    try:
        yield SandboxCase(
            name=sandbox_name,
            config={
                'ollamaModel': ollama_cli_config['model'],
                'ollamaProvider': ollama_cli_config['provider_id'],
                'opencodeModel': f'{ollama_cli_config["provider_id"]}/{ollama_cli_config["model"]}',
            },
            generated_config=generated,
            history=history,
        )
    finally:
        if sandbox_created:
            delete_result = cleanup_sandbox(sandbox_name, label=f'deleting sandbox {sandbox_name}')
            if delete_result and delete_result.returncode != 0:
                print(render_transcript(delete_result, label='sandbox delete'), flush=True)


def test_opencode_run_responds_with_ollama(opencode_ollama_sandbox):
    help_result = opencode_ollama_sandbox.exec(['opencode', '--help'], timeout=30, label='checking opencode CLI')
    assert_success(help_result, 'opencode CLI is not available in the sandbox', opencode_ollama_sandbox.history)

    if not re.search(r'\brun\b', help_result.stdout + help_result.stderr):
        fail_with_result(
            'opencode CLI does not advertise the run command',
            help_result,
            opencode_ollama_sandbox.history,
        )

    ollama_model = opencode_ollama_sandbox.config['ollamaModel']
    ollama_provider = opencode_ollama_sandbox.config['ollamaProvider']
    opencode_model = opencode_ollama_sandbox.config['opencodeModel']
    assert opencode_model == f'{ollama_provider}/{ollama_model}'

    run_cmd = agent_prompt_command('opencode', SMOKE_PROMPT, provider=ollama_provider, model=ollama_model)
    assert run_cmd == ['opencode', 'run', SMOKE_PROMPT, '--model', opencode_model]
    run_result = opencode_ollama_sandbox.exec(
        run_cmd,
        timeout=240,
        label=f'running: {shell_join(run_cmd)}',
    )
    assert_success(run_result, 'opencode run failed with Ollama inference', opencode_ollama_sandbox.history)

    combined = '\n'.join(part for part in [run_result.stdout, run_result.stderr] if part).strip()
    if re.search(r'(^|\n)\s*Error:', combined):
        fail_with_result(
            'opencode run reported an error with Ollama inference',
            run_result,
            opencode_ollama_sandbox.history,
        )

    if '4' not in combined:
        fail_with_result(
            'expected opencode run to answer 2+2 with 4',
            run_result,
            opencode_ollama_sandbox.history,
        )


def test_opencode_run_uses_uploaded_skill_with_ollama(opencode_ollama_sandbox):
    ollama_model = opencode_ollama_sandbox.config['ollamaModel']
    ollama_provider = opencode_ollama_sandbox.config['ollamaProvider']
    run_cmd = agent_prompt_command(
        'opencode',
        BRIAN_FOOD_SKILL_PROMPT,
        provider=ollama_provider,
        model=ollama_model,
    )

    run_result = opencode_ollama_sandbox.exec(
        run_cmd,
        timeout=240,
        label=f'running: {shell_join(run_cmd)}',
    )
    assert_success(run_result, 'opencode run failed while answering from uploaded skill', opencode_ollama_sandbox.history)

    combined = '\n'.join(part for part in [run_result.stdout, run_result.stderr] if part).strip()
    if BRIAN_FOOD_SKILL_OUTPUT not in combined.lower():
        fail_with_result(
            f'expected opencode run to answer from {BRIAN_FOOD_SKILL_NAME} skill with {BRIAN_FOOD_SKILL_OUTPUT}',
            run_result,
            opencode_ollama_sandbox.history,
        )
