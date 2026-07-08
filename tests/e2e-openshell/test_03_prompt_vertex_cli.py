#!/usr/bin/env python3
"""
Pure CLI E2E for prompt-capable agents running through OpenShell Vertex AI inference.
"""

import pytest

from agent_cases import AGENT_PROMPT_CASES, agent_case_id, agent_prompt_command
from openshell_testkit import assert_success, fail_with_result, shell_join
from vertex_cli_testkit import load_vertex_cli_config, vertex_agent_sandbox


VERTEX_MODEL_ENDPOINT = 'https://inference.local/v1'
VERTEX_COMMAND_PROVIDER = 'anthropic'
SMOKE_PROMPT = '2+2=? Reply with just the number.'


@pytest.fixture(scope='module')
def vertex_cli_config():
    return load_vertex_cli_config()


@pytest.fixture(scope='module', params=AGENT_PROMPT_CASES, ids=agent_case_id)
def agent_prompt_case(request):
    return request.param


@pytest.fixture(scope='module')
def vertex_prompt_sandbox(agent_prompt_case, vertex_cli_config, gateway_ready, tmp_path_factory):
    with vertex_agent_sandbox(
        vertex_cli_config=vertex_cli_config,
        tmp_path_factory=tmp_path_factory,
        agent=agent_prompt_case['agent'],
        model_endpoint=VERTEX_MODEL_ENDPOINT,
        sandbox_name=f'kdn-e2e-{agent_prompt_case["agent"]}-vertex',
        description=f'{agent_prompt_case["agent"]} Vertex',
        config={'agent': agent_prompt_case['agent']},
    ) as sandbox:
        yield sandbox


def test_agent_prompt_responds_with_vertex_ai(vertex_prompt_sandbox):
    agent = vertex_prompt_sandbox.config['agent']
    vertex_model = vertex_prompt_sandbox.config['vertexModel']
    run_cmd = agent_prompt_command(
        agent,
        SMOKE_PROMPT,
        provider=VERTEX_COMMAND_PROVIDER,
        model=vertex_model,
    )

    help_result = vertex_prompt_sandbox.exec([run_cmd[0], '--help'], timeout=30, label=f'checking {run_cmd[0]} CLI')
    assert_success(help_result, f'{run_cmd[0]} CLI is not available in the sandbox', vertex_prompt_sandbox.history)

    run_result = vertex_prompt_sandbox.exec(
        run_cmd,
        timeout=180,
        label=f'running: {shell_join(run_cmd)}',
    )
    assert_success(run_result, f'{agent} prompt command failed with Vertex AI inference', vertex_prompt_sandbox.history)

    combined = '\n'.join(part for part in [run_result.stdout, run_result.stderr] if part).strip()
    if '4' not in combined:
        fail_with_result(
            f'expected {agent} prompt command to answer 2+2 with 4',
            run_result,
            vertex_prompt_sandbox.history,
        )
