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

    def test_gateway_ready(self, gateway_ready):
        assert gateway_ready.returncode == 0

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
        assert generated.agent_config_upload_path == agent_case['settingsPath']
        assert json.loads(generated.agent_config_contents).get('mcp'), (
            f'Expected MCP entries in generated config for {agent_case["agent"]}'
        )
        assert generated.skill_uploads == [
            {'local': skill, 'remote': agent_case['skillDestination']} for skill in agent_case.get('skills', [])
        ]


class TestMcpServerRuns:
    def test_sandbox_created(self, sandbox_case):
        assert sandbox_case.name

    def test_node_available(self, sandbox_case):
        result = sandbox_case.exec(['node', '--version'], label='checking node')
        assert_success(result, 'node not available in sandbox', sandbox_case.history)

    def test_npx_available(self, sandbox_case):
        result = sandbox_case.exec(['which', 'npx'], label='checking npx')
        assert_success(result, 'npx not available in sandbox', sandbox_case.history)

    def test_network_policy_allows_npm_scoped_package_metadata(self, sandbox_case):
        probe_cmd = sandbox_case.config['registryProbeCommand']

        result = sandbox_case.exec(
            probe_cmd,
            timeout=30,
            label=f'running: {shell_join(probe_cmd)}',
        )
        combined = '\n'.join(part for part in [result.stdout, result.stderr] if part)
        if 'policy_denied' in combined:
            fail_with_result('OpenShell policy denied npm registry metadata request', result, sandbox_case.history)
        if 'HTTP code 403 from proxy' in combined or 'Received HTTP code 403' in combined:
            fail_with_result('OpenShell proxy rejected npm registry metadata request', result, sandbox_case.history)
        assert_success(result, 'npm scoped package metadata request failed in sandbox', sandbox_case.history)

        if sandbox_case.config['registryProbeOutput'] not in result.stdout:
            fail_with_result(
                f'Expected "{sandbox_case.config["registryProbeOutput"]}" in npm registry response',
                result,
                sandbox_case.history,
            )

    def test_opencode_settings_contains_mcp_config(self, sandbox_case):
        settings_path = sandbox_case.generated_config.agent_config_upload_path
        result = sandbox_case.exec(
            ['sh', '-lc', f'cat "$HOME/{settings_path}"'],
            label=f'reading OpenCode settings: {settings_path}',
        )
        assert_success(result, 'OpenCode settings file was not readable', sandbox_case.history)

        try:
            settings = json.loads(result.stdout)
        except json.JSONDecodeError:
            fail_with_result('OpenCode settings file was not valid JSON', result, sandbox_case.history)

        expected_entry = {
            'type': 'local',
            'command': sandbox_case.config['mcpCommands'][0]['command'],
            'args': sandbox_case.config['mcpCommands'][0].get('args', []),
            'enabled': True,
        }
        mcp_name = sandbox_case.config['mcpName']
        mcp_config = settings.get('mcp', {})
        if mcp_name not in mcp_config:
            fail_with_result(
                f'Expected OpenCode settings to include MCP entry "{mcp_name}"',
                result,
                sandbox_case.history,
            )

        actual_entry = mcp_config[mcp_name]
        expected_command = [expected_entry['command'], *expected_entry['args']]
        if actual_entry.get('type') != expected_entry['type']:
            fail_with_result(f'Expected "{mcp_name}" to be a local MCP entry', result, sandbox_case.history)
        if actual_entry.get('enabled') is not expected_entry['enabled']:
            fail_with_result(f'Expected "{mcp_name}" MCP entry to be enabled', result, sandbox_case.history)
        if actual_entry.get('command') != expected_command:
            fail_with_result(
                f'Expected "{mcp_name}" command to be {expected_command}',
                result,
                sandbox_case.history,
            )

    def test_opencode_skill_file_uploaded(self, sandbox_case):
        read_cmd = sandbox_case.config['skillReadCommand']
        result = sandbox_case.exec(
            read_cmd,
            label=f'running: {shell_join(read_cmd)}',
        )
        assert_success(result, 'OpenCode skill file was not readable', sandbox_case.history)

        if sandbox_case.config['skillReadOutput'] not in result.stdout:
            fail_with_result(
                f'Expected "{sandbox_case.config["skillReadOutput"]}" in uploaded skill file',
                result,
                sandbox_case.history,
            )

    def test_verify_local_npm_mcp_spawned(self, sandbox_case):
        verify_cmd = sandbox_case.config['spawnCommand']

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
        if sandbox_case.config['spawnOutput'] not in result.stdout:
            fail_with_result(
                f'Expected "{sandbox_case.config["spawnOutput"]}" in output',
                result,
                sandbox_case.history,
            )

    def test_opencode_mcp_list_sees_spawned_mcp(self, sandbox_case):
        list_cmd = sandbox_case.config['agentMcpListCommand']

        result = sandbox_case.exec(
            list_cmd,
            timeout=60,
            label=f'running: {shell_join(list_cmd)}',
        )
        assert_success(result, 'OpenCode MCP list command failed', sandbox_case.history)

        combined = '\n'.join(part for part in [result.stdout, result.stderr] if part)
        if sandbox_case.config['agentMcpListNameOutput'] not in combined:
            fail_with_result(
                f'Expected "{sandbox_case.config["agentMcpListNameOutput"]}" in OpenCode MCP list output',
                result,
                sandbox_case.history,
            )
        if sandbox_case.config['agentMcpListSpawnedOutput'] not in combined.lower():
            fail_with_result(
                f'Expected "{sandbox_case.config["agentMcpListSpawnedOutput"]}" in OpenCode MCP list output',
                result,
                sandbox_case.history,
            )
