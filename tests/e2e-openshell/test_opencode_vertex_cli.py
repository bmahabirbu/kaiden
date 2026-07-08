#!/usr/bin/env python3
"""
Pure CLI E2E for OpenCode running through OpenShell Vertex AI inference.
"""

import re

import pytest

from openshell_testkit import assert_success, fail_with_result, shell_join
from vertex_cli_testkit import load_vertex_cli_config, vertex_agent_sandbox


OPENCODE_SETTINGS_PATH = '.config/opencode/opencode.json'
OPENCODE_VERTEX_MODEL_ENDPOINT = 'https://inference.local/v1'
SMOKE_PROMPT = '2+2=? Reply with just the number.'


@pytest.fixture(scope='module')
def vertex_cli_config():
    return load_vertex_cli_config()


@pytest.fixture(scope='module')
def opencode_vertex_sandbox(vertex_cli_config, gateway_ready, tmp_path_factory):
    with vertex_agent_sandbox(
        vertex_cli_config=vertex_cli_config,
        tmp_path_factory=tmp_path_factory,
        agent='opencode',
        settings_path=OPENCODE_SETTINGS_PATH,
        model_endpoint=OPENCODE_VERTEX_MODEL_ENDPOINT,
        sandbox_name='kdn-e2e-opencode-vertex',
        description='OpenCode',
        config={'opencodeModel': f'anthropic/{vertex_cli_config.model}'},
    ) as sandbox:
        yield sandbox


def test_opencode_run_responds_with_vertex_ai(opencode_vertex_sandbox):
    help_result = opencode_vertex_sandbox.exec(['opencode', '--help'], timeout=30, label='checking opencode CLI')
    assert_success(help_result, 'opencode CLI is not available in the sandbox', opencode_vertex_sandbox.history)

    if not re.search(r'\brun\b', help_result.stdout + help_result.stderr):
        fail_with_result(
            'opencode CLI does not advertise the run command',
            help_result,
            opencode_vertex_sandbox.history,
        )

    vertex_model = opencode_vertex_sandbox.config['vertexModel']
    opencode_model = opencode_vertex_sandbox.config['opencodeModel']
    assert opencode_model == f'anthropic/{vertex_model}'

    run_cmd = ['opencode', 'run', SMOKE_PROMPT, '--model', opencode_model]
    run_result = opencode_vertex_sandbox.exec(
        run_cmd,
        timeout=180,
        label=f'running: {shell_join(run_cmd)}',
    )
    assert_success(run_result, 'opencode run failed with Vertex AI inference', opencode_vertex_sandbox.history)

    combined = '\n'.join(part for part in [run_result.stdout, run_result.stderr] if part).strip()
    if '4' not in combined:
        fail_with_result(
            'expected opencode run to answer 2+2 with 4',
            run_result,
            opencode_vertex_sandbox.history,
        )
