#!/usr/bin/env python3
"""
E2E regression tests for OpenShell MCP sandbox behavior.

Add agent cases in agent_cases.py. Shared OpenShell setup and command transcript
reporting live in conftest.py and openshell_testkit.py.
"""

import json

from openshell_testkit import (
    assert_success,
    fail_with_history,
    fail_with_result,
    generate_configs,
    shell_join,
)


class TestPreflight:
    def test_openshell_version_ready(self, openshell_preflight):
        assert openshell_preflight['installed']

    def test_config_generation_ready(self, agent_case):
        history = []
        try:
            generated = generate_configs(agent_case, history=history)
        except RuntimeError as exc:
            fail_with_history(
                f'failed to generate Kaiden config files for {agent_case["agent"]}: {exc}',
                history,
            )

        assert generated.policy, f'Expected non-empty policy for {agent_case["agent"]}'
        assert json.loads(generated.agent_config_contents).get('mcp'), (
            f'Expected MCP entries in generated config for {agent_case["agent"]}'
        )


class TestMcpServerRuns:
    def test_gateway_ready(self, gateway_ready):
        assert gateway_ready.returncode == 0

    def test_sandbox_created(self, sandbox_case):
        assert sandbox_case.name

    def test_node_available(self, sandbox_case):
        result = sandbox_case.exec(['node', '--version'], label='checking node')
        assert_success(result, 'node not available in sandbox', sandbox_case.history)

    def test_npx_available(self, sandbox_case):
        result = sandbox_case.exec(['which', 'npx'], label='checking npx')
        assert_success(result, 'npx not available in sandbox', sandbox_case.history)

    def test_verify_local_npm_mcp_installed(self, sandbox_case):
        verify_cmd = sandbox_case.config['verifyCommand']

        result = sandbox_case.exec(
            verify_cmd,
            timeout=90,
            label=f'running: {shell_join(verify_cmd)}',
        )
        combined = '\n'.join(part for part in [result.stdout, result.stderr] if part)
        if 'ECONNRESET' in combined:
            fail_with_result(
                'ECONNRESET - scoped package likely blocked by proxy',
                result,
                sandbox_case.history,
            )
        if 'Operation timed out' in combined:
            fail_with_result(
                'timed out - proxy may be blocking requests',
                result,
                sandbox_case.history,
            )
        if result.returncode != 0:
            fail_with_result(
                f'MCP verify command failed (exit {result.returncode})',
                result,
                sandbox_case.history,
            )
        if sandbox_case.config['verifyOutput'] not in result.stdout:
            fail_with_result(
                f'Expected "{sandbox_case.config["verifyOutput"]}" in output',
                result,
                sandbox_case.history,
            )
