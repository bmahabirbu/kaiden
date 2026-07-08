#!/usr/bin/env python3
"""
Pure CLI E2E for Claude Code running through OpenShell Vertex AI inference.
"""

import pytest

from openshell_testkit import assert_success, fail_with_result, shell_join
from vertex_cli_testkit import load_vertex_cli_config, vertex_agent_sandbox


CLAUDE_SETTINGS_PATH = '.claude/settings.json'
CLAUDE_VERTEX_MODEL_ENDPOINT = 'https://inference.local'
SMOKE_PROMPT = '2+2=? Reply with just the number.'


@pytest.fixture(scope='module')
def vertex_cli_config():
    return load_vertex_cli_config()


@pytest.fixture(scope='module')
def claude_vertex_sandbox(vertex_cli_config, gateway_ready, tmp_path_factory):
    with vertex_agent_sandbox(
        vertex_cli_config=vertex_cli_config,
        tmp_path_factory=tmp_path_factory,
        agent='claude',
        settings_path=CLAUDE_SETTINGS_PATH,
        model_endpoint=CLAUDE_VERTEX_MODEL_ENDPOINT,
        sandbox_name='kdn-e2e-claude-vertex',
        description='Claude',
    ) as sandbox:
        yield sandbox


def test_claude_print_responds_with_vertex_ai(claude_vertex_sandbox):
    help_result = claude_vertex_sandbox.exec(['claude', '--help'], timeout=30, label='checking claude CLI')
    assert_success(help_result, 'claude CLI is not available in the sandbox', claude_vertex_sandbox.history)

    print_cmd = ['claude', '-p', SMOKE_PROMPT]
    print_result = claude_vertex_sandbox.exec(
        print_cmd,
        timeout=180,
        label=f'running: {shell_join(print_cmd)}',
    )
    assert_success(print_result, 'claude -p failed with Vertex AI inference', claude_vertex_sandbox.history)

    combined = '\n'.join(part for part in [print_result.stdout, print_result.stderr] if part).strip()
    if '4' not in combined:
        fail_with_result(
            'expected claude -p to answer 2+2 with 4',
            print_result,
            claude_vertex_sandbox.history,
        )
