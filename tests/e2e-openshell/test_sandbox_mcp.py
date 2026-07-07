#!/usr/bin/env python3
"""
E2E regression tests for Kaiden sandbox MCP configurations.

Requires:
  - openshell CLI in PATH (>= pinned version in extensions/openshell/package.json)
  - A configured openshell gateway
  - npx/tsx available for config generation
  - pytest: pip install pytest

Run:
  pytest
  pytest -x

Pytest shows an OpenShell session header before collection. Command transcripts
are included only when a test or fixture fails.

Adding a new agent test:
  1. Add an entry to AGENT_CONFIGS below
  2. That's it - parametrized tests are generated automatically

  Each entry needs:
    - agent:        agent CLI name (used in sandbox name)
    - network:      network policy config passed to buildPolicyObject()
    - mcpCommands:  MCP commands written to the agent's config
    - mcpVerifyCmd: command to run inside the sandbox to verify MCP works
    - mcpVerifyOut: string expected in stdout of the verify command
"""

import json
import os
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import dataclass

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
GENERATE_SCRIPT = os.path.join(os.path.dirname(__file__), 'generate-config.mts')
OPENSHELL_PKG = os.path.join(REPO_ROOT, 'extensions', 'openshell', 'package.json')
TEST_FILE_NAME = os.path.splitext(os.path.basename(__file__))[0]

# -- Agent configs -------------------------------------------------
# Add new agents here. Each dict becomes a parametrized test automatically.

AGENT_CONFIGS = [
    {
        'agent': 'opencode',
        'description': 'npm scoped MCP package (@playwright/mcp) via OpenCode',
        'network': {'mode': 'deny', 'hosts': ['registry.npmjs.org']},
        'mcpCommands': [
            {
                'name': 'ai.openkaiden.registry/playwright',
                'command': 'npx',
                'args': ['@playwright/mcp@0.0.73'],
            },
        ],
        'mcpVerifyCmd': ['npx', '@playwright/mcp@0.0.73', '--help'],
        'mcpVerifyOut': 'Playwright MCP',
    },
    # -- Add more agents below -------------------------------------
    # {
    #     'agent': 'openclaw',
    #     'description': 'MCP show via OpenClaw',
    #     'network': {'mode': 'deny', 'hosts': ['registry.npmjs.org']},
    #     'mcpCommands': [
    #         {
    #             'name': 'ai.openkaiden.registry/playwright',
    #             'command': 'npx',
    #             'args': ['@playwright/mcp@0.0.73'],
    #         },
    #     ],
    #     'mcpVerifyCmd': ['openclaw', 'mcp', 'show'],
    #     'mcpVerifyOut': 'playwright',
    # },
]


# -- Helpers -------------------------------------------------------

@dataclass
class CommandResult:
    cmd: list[str]
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False


@dataclass
class CommandRecord:
    label: str | None
    result: CommandResult


def get_pinned_openshell_version():
    with open(OPENSHELL_PKG) as f:
        pkg = json.load(f)
    version_str = pkg.get('openshellVersion', '')
    if not version_str:
        raise RuntimeError(f'missing "openshellVersion" in {OPENSHELL_PKG}')
    return tuple(int(x) for x in version_str.split('.'))


def shell_join(cmd):
    return ' '.join(shlex.quote(part) for part in cmd)


def normalize_output(value):
    if value is None:
        return ''
    if isinstance(value, bytes):
        return value.decode(errors='replace')
    return value


def indent_block(text, prefix='  '):
    if not text:
        return f'{prefix}<empty>'
    return '\n'.join(f'{prefix}{line}' for line in text.splitlines())


def render_transcript(result, *, label=None):
    lines = []
    if label:
        lines.append(f'[{label}]')
    lines.append(f'$ {shell_join(result.cmd)}')
    lines.append(f'exit_code: {result.returncode}')
    if result.timed_out:
        lines.append('timed_out: true')
    lines.append('stdout:')
    lines.append(indent_block(result.stdout))
    if result.stderr:
        lines.append('stderr:')
        lines.append(indent_block(result.stderr))
    return '\n'.join(lines)


def add_history(history, result, *, label=None):
    if history is not None:
        history.append(CommandRecord(label=label, result=result))


def render_history(history):
    if not history:
        return 'No command transcripts captured.'
    return 'Command transcripts:\n\n' + '\n\n'.join(
        render_transcript(record.result, label=record.label) for record in history
    )


def render_history_summary(history):
    if not history:
        return 'No setup commands captured.'

    lines = []
    for record in history:
        name = record.label or shell_join(record.result.cmd)
        status = 'timed out' if record.result.timed_out else f'exit {record.result.returncode}'
        lines.append(f'- {name}: {status}')
    return '\n'.join(lines)


def fail_with_history(message, history=None):
    details = f'{message}\n\n{render_history(history)}' if history is not None else message
    pytest.fail(details, pytrace=False)


def fail_with_result(message, result, history=None, *, include_setup_summary=True):
    sections = [message]

    if include_setup_summary and history:
        setup_history = history[:-1]
        if setup_history:
            sections.extend(['', 'Setup summary:', render_history_summary(setup_history)])

    sections.extend(
        [
            '',
            'Failing command:',
            render_transcript(result, label=history[-1].label if history else None),
        ]
    )
    pytest.fail('\n'.join(sections), pytrace=False)


def step_result(ok, message, *, result=None, blocked=False):
    return {
        'ok': ok,
        'message': message,
        'result': result,
        'blocked': blocked,
    }


def record_step(state, step_name, result, *, phase, detail=''):
    state['steps'][step_name] = result
    return result


def skip_if_blocked(state, step_name, current_test_name):
    step = state['steps'][step_name]
    if step['blocked']:
        pytest.skip(f'{current_test_name} blocked: {step["message"]}')


def assert_step_passed(state, step_name):
    step = state['steps'][step_name]
    if step['blocked']:
        pytest.skip(step['message'])
    if step['ok']:
        return
    if step['result'] is not None:
        fail_with_result(step['message'], step['result'], state['history'])
    fail_with_history(step['message'], state['history'])


def run_command(cmd, *, timeout=120, input_data=None, label=None, history=None):
    """Run a command, capturing output for failure reporting."""
    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            input=input_data,
            cwd=REPO_ROOT,
        )
        result = CommandResult(
            cmd=cmd,
            returncode=completed.returncode,
            stdout=normalize_output(completed.stdout),
            stderr=normalize_output(completed.stderr),
        )
    except subprocess.TimeoutExpired as exc:
        result = CommandResult(
            cmd=cmd,
            returncode=124,
            stdout=normalize_output(exc.stdout),
            stderr=normalize_output(exc.stderr),
            timed_out=True,
        )

    add_history(history, result, label=label)

    return result


def sandbox_exec(name, command, *, timeout=60, label=None, history=None):
    """Execute a command inside a sandbox."""
    cmd = ['openshell', 'sandbox', 'exec', '-n', name, '--timeout', str(timeout), '--'] + command
    return run_command(cmd, timeout=timeout + 15, label=label, history=history)


def parse_version(version_str):
    parts = version_str.strip().split()[-1]
    return tuple(int(x) for x in parts.split('.'))


def generate_configs(input_config, *, history=None):
    result = run_command(
        ['npx', 'tsx', GENERATE_SCRIPT],
        input_data=json.dumps(input_config),
        timeout=30,
        label='generating configs from buildPolicyObject()',
        history=history,
    )
    if result.timed_out or result.returncode != 0:
        raise RuntimeError(
            'generate-config.mts failed:\n\n'
            + render_transcript(result, label='generate-config')
        )

    lines = result.stdout.strip().split('\n')
    # Last line is the JSON output, prior lines are npm warnings.
    for line in reversed(lines):
        line = line.strip()
        if line.startswith('{'):
            return json.loads(line)

    raise RuntimeError(
        'generate-config.mts produced no JSON output:\n\n'
        + render_transcript(result, label='generate-config')
    )


# -- Preflight -----------------------------------------------------

def run_preflight_or_fail():
    history = []
    openshell_path = shutil.which('openshell')
    if not openshell_path:
        fail_with_history('openshell not found in PATH')

    result = run_command(
        ['openshell', '--version'],
        label='checking openshell version',
        history=history,
    )
    if result.timed_out or result.returncode != 0:
        fail_with_history(
            'openshell --version failed',
            history,
        )

    version = parse_version(result.stdout)
    min_version = get_pinned_openshell_version()
    installed = result.stdout.strip()
    pinned = '.'.join(map(str, min_version))

    if version < min_version:
        fail_with_history(f'{installed} < pinned {pinned}')

    temp_dir = tempfile.mkdtemp(prefix='kdn-e2e-preflight-')
    generated = []
    try:
        for config in AGENT_CONFIGS:
            gen_input = {
                'network': config['network'],
                'mcpCommands': config['mcpCommands'],
            }
            try:
                configs = generate_configs(gen_input, history=history)
            except RuntimeError as exc:
                fail_with_history(
                    f'failed to generate Kaiden config files for {config["agent"]}: {exc}',
                    history,
                )

            policy_path = os.path.join(temp_dir, f'{config["agent"]}-policy.yaml')
            config_path = os.path.join(temp_dir, f'{config["agent"]}-opencode.json')

            with open(policy_path, 'w') as f:
                f.write(configs['policy'])
            with open(config_path, 'w') as f:
                f.write(configs['opencodeConfig'])

            if not configs['policy']:
                fail_with_history(f'generated empty policy for {config["agent"]}', history)

            try:
                parsed_config = json.loads(configs['opencodeConfig'])
            except json.JSONDecodeError as exc:
                fail_with_history(
                    f'invalid opencode config JSON for {config["agent"]}: {exc}',
                    history,
                )

            generated.append(
                {
                    'agent': config['agent'],
                    'policy_path': policy_path,
                    'config_path': config_path,
                    'mcp_count': len(parsed_config.get('mcp', {})),
                }
            )
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return {
        'openshell_path': openshell_path,
        'installed': installed,
        'pinned': pinned,
        'generated': generated,
    }


# -- Fixtures ------------------------------------------------------


@pytest.fixture(scope='module', params=AGENT_CONFIGS, ids=[c['agent'] for c in AGENT_CONFIGS])
def sandbox_case(request):
    """Provision one sandbox case per agent and record each setup step."""
    config = request.param
    agent = config['agent']
    sandbox_name = f'kdn-e2e-{TEST_FILE_NAME}-{agent}'
    temp_dir = tempfile.mkdtemp(prefix=f'kdn-e2e-{agent}-')
    history = []
    steps = {}
    state = {'steps': steps, 'history': history}
    sandbox_created = False
    phase = f'mcp:{agent}'

    run_command(
        ['openshell', 'sandbox', 'delete', sandbox_name],
        timeout=30,
    )

    gen_input = {
        'network': config['network'],
        'mcpCommands': config['mcpCommands'],
    }
    policy_path = os.path.join(temp_dir, 'policy.yaml')
    config_path = os.path.join(temp_dir, 'opencode.json')

    try:
        configs = generate_configs(gen_input, history=history)
    except RuntimeError as exc:
        record_step(state, 'config_generated', step_result(False, str(exc)), phase=phase)
        record_step(
            state,
            'gateway_ready',
            step_result(
                False,
                'gateway check not run because config generation failed',
                blocked=True,
            ),
            phase=phase,
        )
        record_step(
            state,
            'sandbox_created',
            step_result(
                False,
                'sandbox creation not run because config generation failed',
                blocked=True,
            ),
            phase=phase,
        )
        record_step(
            state,
            'node_available',
            step_result(
                False,
                'node check not run because sandbox was not created',
                blocked=True,
            ),
            phase=phase,
        )
        record_step(
            state,
            'npx_available',
            step_result(
                False,
                'npx check not run because sandbox was not created',
                blocked=True,
            ),
            phase=phase,
        )
    else:
        with open(policy_path, 'w') as f:
            f.write(configs['policy'])
        with open(config_path, 'w') as f:
            f.write(configs['opencodeConfig'])
        record_step(
            state,
            'config_generated',
            step_result(
                True,
                f'generated policy and MCP config for {agent}',
            ),
            phase=phase,
        )

        gateway_result = run_command(
            ['openshell', 'status'],
            timeout=15,
            label='checking gateway',
            history=history,
        )
        if gateway_result.returncode != 0:
            record_step(
                state,
                'gateway_ready',
                step_result(
                    False,
                    'openshell gateway not reachable before sandbox creation',
                    result=gateway_result,
                ),
                phase=phase,
            )
            record_step(
                state,
                'sandbox_created',
                step_result(
                    False,
                    'sandbox creation not run because gateway is unavailable',
                    blocked=True,
                ),
                phase=phase,
            )
            record_step(
                state,
                'node_available',
                step_result(
                    False,
                    'node check not run because sandbox was not created',
                    blocked=True,
                ),
                phase=phase,
            )
            record_step(
                state,
                'npx_available',
                step_result(
                    False,
                    'npx check not run because sandbox was not created',
                    blocked=True,
                ),
                phase=phase,
            )
        else:
            record_step(
                state,
                'gateway_ready',
                step_result(True, 'openshell gateway reachable'),
                phase=phase,
            )

            create_result = run_command(
                [
                    'openshell',
                    'sandbox',
                    'create',
                    '--name',
                    sandbox_name,
                    '--upload',
                    f'{config_path}:.config/opencode/opencode.json',
                    '--no-tty',
                    '--policy',
                    policy_path,
                    '--',
                    'true',
                ],
                timeout=180,
                label='creating sandbox',
                history=history,
            )
            if create_result.returncode != 0:
                record_step(
                    state,
                    'sandbox_created',
                    step_result(
                        False,
                        f'Sandbox creation failed (exit {create_result.returncode})',
                        result=create_result,
                    ),
                    phase=phase,
                )
                record_step(
                    state,
                    'node_available',
                    step_result(
                        False,
                        'node check not run because sandbox was not created',
                        blocked=True,
                    ),
                    phase=phase,
                )
                record_step(
                    state,
                    'npx_available',
                    step_result(
                        False,
                        'npx check not run because sandbox was not created',
                        blocked=True,
                    ),
                    phase=phase,
                )
            else:
                list_result = run_command(
                    ['openshell', 'sandbox', 'list'],
                    timeout=30,
                    label='listing sandboxes',
                    history=history,
                )
                if sandbox_name not in list_result.stdout:
                    record_step(
                        state,
                        'sandbox_created',
                        step_result(
                            False,
                            f'Sandbox {sandbox_name} not found after creation',
                            result=list_result,
                        ),
                        phase=phase,
                    )
                    record_step(
                        state,
                        'node_available',
                        step_result(
                            False,
                            'node check not run because sandbox was not ready',
                            blocked=True,
                        ),
                        phase=phase,
                    )
                    record_step(
                        state,
                        'npx_available',
                        step_result(
                            False,
                            'npx check not run because sandbox was not ready',
                            blocked=True,
                        ),
                        phase=phase,
                    )
                else:
                    sandbox_created = True
                    record_step(
                        state,
                        'sandbox_created',
                        step_result(
                            True,
                            f'sandbox {sandbox_name} created and listed',
                        ),
                        phase=phase,
                    )

                    node_result = sandbox_exec(
                        sandbox_name,
                        ['node', '--version'],
                        label='checking node',
                        history=history,
                    )
                    record_step(
                        state,
                        'node_available',
                        step_result(
                            node_result.returncode == 0,
                            'node available in sandbox'
                            if node_result.returncode == 0
                            else 'node not available in sandbox',
                            result=node_result if node_result.returncode != 0 else None,
                        ),
                        phase=phase,
                    )

                    npx_result = sandbox_exec(
                        sandbox_name,
                        ['which', 'npx'],
                        label='checking npx',
                        history=history,
                    )
                    record_step(
                        state,
                        'npx_available',
                        step_result(
                            npx_result.returncode == 0,
                            'npx available in sandbox'
                            if npx_result.returncode == 0
                            else 'npx not available in sandbox',
                            result=npx_result if npx_result.returncode != 0 else None,
                        ),
                        phase=phase,
                    )

    yield {
        'name': sandbox_name,
        'config': config,
        'history': history,
        'steps': steps,
    }

    if sandbox_created:
        delete_result = run_command(
            ['openshell', 'sandbox', 'delete', sandbox_name],
            timeout=30,
            label=f'deleting sandbox {sandbox_name}',
        )
        if delete_result.returncode != 0:
            print(render_transcript(delete_result, label='sandbox delete'), flush=True)
    shutil.rmtree(temp_dir, ignore_errors=True)


# -- Tests ---------------------------------------------------------


class TestPreflight:
    def test_openshell_version_ready(self):
        """OpenShell version should satisfy the pinned requirement."""
        preflight = run_preflight_or_fail()
        assert preflight['installed']

    @pytest.mark.parametrize('agent_config', AGENT_CONFIGS, ids=[c['agent'] for c in AGENT_CONFIGS])
    def test_config_generation_ready(self, agent_config):
        """Kaiden should generate policy and MCP config files for each agent."""
        history = []
        gen_input = {
            'network': agent_config['network'],
            'mcpCommands': agent_config['mcpCommands'],
        }
        try:
            configs = generate_configs(gen_input, history=history)
        except RuntimeError as exc:
            fail_with_history(
                f'failed to generate Kaiden config files for {agent_config["agent"]}: {exc}',
                history,
            )

        assert configs['policy'], f'Expected non-empty policy for {agent_config["agent"]}'
        assert json.loads(configs['opencodeConfig']).get('mcp'), (
            f'Expected MCP entries in generated config for {agent_config["agent"]}'
        )


class TestMcpServerRuns:
    def test_gateway_ready(self, sandbox_case):
        """Gateway should be reachable before sandbox creation."""
        assert_step_passed(sandbox_case, 'gateway_ready')

    def test_sandbox_created(self, sandbox_case):
        """Sandbox should be created and listed."""
        assert_step_passed(sandbox_case, 'sandbox_created')

    def test_node_available(self, sandbox_case):
        """Node.js should be available inside the sandbox."""
        skip_if_blocked(sandbox_case, 'node_available', 'node check')
        assert_step_passed(sandbox_case, 'node_available')

    def test_npx_available(self, sandbox_case):
        """npx should be available inside the sandbox."""
        skip_if_blocked(sandbox_case, 'npx_available', 'npx check')
        assert_step_passed(sandbox_case, 'npx_available')

    def test_verify_command(self, sandbox_case):
        """Configured MCP verify command should run successfully."""
        skip_if_blocked(sandbox_case, 'npx_available', 'MCP verify')
        assert_step_passed(sandbox_case, 'npx_available')

        config = sandbox_case['config']
        history = sandbox_case['history']
        name = sandbox_case['name']
        verify_cmd = config['mcpVerifyCmd']

        result = sandbox_exec(
            name,
            verify_cmd,
            timeout=90,
            label=f'running: {shell_join(verify_cmd)}',
            history=history,
        )
        combined = '\n'.join(part for part in [result.stdout, result.stderr] if part)
        if 'ECONNRESET' in combined:
            fail_with_result('ECONNRESET - scoped package likely blocked by proxy', result, history)
        if 'Operation timed out' in combined:
            fail_with_result('timed out - proxy may be blocking requests', result, history)
        if result.returncode != 0:
            fail_with_result(f'MCP verify command failed (exit {result.returncode})', result, history)
        if config['mcpVerifyOut'] not in result.stdout:
            fail_with_result(
                f'Expected "{config["mcpVerifyOut"]}" in output',
                result,
                history,
            )
