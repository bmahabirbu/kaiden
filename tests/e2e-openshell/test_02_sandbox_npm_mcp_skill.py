#!/usr/bin/env python3
"""
E2E regression tests for OpenShell MCP sandbox behavior.

Add agents in agent-command-registry.json. Shared OpenShell setup and command
transcript reporting live in conftest.py and openshell_testkit.py.
"""

import json

from openshell_testkit import (
    assert_success,
    fail_with_history,
    fail_with_result,
    generate_configs,
    shell_join,
)


def _mcp_entry_matches(entry, expected_command):
    if not isinstance(entry, dict):
        return False

    command = expected_command['command']
    args = expected_command.get('args', [])
    actual_command = entry.get('command')

    if isinstance(actual_command, list):
        return actual_command == [command, *args]

    return actual_command == command and entry.get('args', []) == args


def _contains_mcp_entry(value, mcp_name, expected_command):
    if isinstance(value, dict):
        if mcp_name in value and _mcp_entry_matches(value[mcp_name], expected_command):
            return True
        return any(_contains_mcp_entry(child, mcp_name, expected_command) for child in value.values())

    if isinstance(value, list):
        return any(_contains_mcp_entry(child, mcp_name, expected_command) for child in value)

    return False


def _find_mcp_config_file(config_files, case):
    expected_command = case['mcpCommands'][0]
    for config_file in config_files:
        try:
            contents = json.loads(config_file['contents'])
        except json.JSONDecodeError:
            continue

        if _contains_mcp_entry(contents, case['mcpName'], expected_command):
            return config_file

    return None


def _skill_read_command(generated, case):
    skill_path = case['skills'][0]
    upload = next(upload for upload in generated.skill_uploads if upload['local'] == skill_path)
    remote = upload['remote'].rstrip('/')
    skill_file = f'{remote}/{case["skillName"]}/SKILL.md' if remote else f'{case["skillName"]}/SKILL.md'
    return ['sh', '-lc', f'cat "$HOME/{skill_file}"']


class TestAgentConfigGeneration:
    def test_config_generation_ready(self, agent_case, tmp_path):
        history = []
        try:
            generated = generate_configs(agent_case, source_path=tmp_path / 'workspace', history=history)
        except RuntimeError as exc:
            fail_with_history(
                f'failed to generate Kaiden config files for {agent_case["agent"]}: {exc}',
                history,
            )

        assert generated.policy, f'Expected non-empty policy for {agent_case["agent"]}'
        assert generated.workspace_config['network']['hosts'] == ['registry.npmjs.org']
        assert generated.workspace_config['features']['ghcr.io/devcontainers/features/node:1'] == {'version': '22'}
        assert generated.agent_config_files
        assert _find_mcp_config_file(generated.agent_config_files, agent_case), (
            f'Expected MCP entries in generated config for {agent_case["agent"]}'
        )
        assert [upload['local'] for upload in generated.skill_uploads] == agent_case.get('skills', [])


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

    def test_agent_settings_contains_mcp_config(self, sandbox_case):
        config_file = _find_mcp_config_file(sandbox_case.generated_config.agent_config_files, sandbox_case.config)
        if not config_file:
            fail_with_history(
                f'Expected generated config for {sandbox_case.config["agent"]} to include MCP entry '
                f'"{sandbox_case.config["mcpName"]}"',
                sandbox_case.history,
            )

        settings_path = config_file['uploadPath']
        result = sandbox_case.exec(
            ['sh', '-lc', f'cat "$HOME/{settings_path}"'],
            label=f'reading {sandbox_case.config["agent"]} settings: {settings_path}',
        )
        assert_success(result, f'{sandbox_case.config["agent"]} settings file was not readable', sandbox_case.history)

        try:
            settings = json.loads(result.stdout)
        except json.JSONDecodeError:
            fail_with_result(
                f'{sandbox_case.config["agent"]} settings file was not valid JSON',
                result,
                sandbox_case.history,
            )

        if not _contains_mcp_entry(settings, sandbox_case.config['mcpName'], sandbox_case.config['mcpCommands'][0]):
            fail_with_result(
                f'Expected {sandbox_case.config["agent"]} settings to include MCP entry '
                f'"{sandbox_case.config["mcpName"]}"',
                result,
                sandbox_case.history,
            )

    def test_agent_skill_file_uploaded(self, sandbox_case):
        read_cmd = _skill_read_command(sandbox_case.generated_config, sandbox_case.config)
        result = sandbox_case.exec(
            read_cmd,
            label=f'running: {shell_join(read_cmd)}',
        )
        assert_success(result, f'{sandbox_case.config["agent"]} skill file was not readable', sandbox_case.history)

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

    def test_agent_mcp_list_sees_spawned_mcp(self, sandbox_case):
        list_cmd = sandbox_case.config['agentMcpListCommand']

        result = sandbox_case.exec(
            list_cmd,
            timeout=60,
            label=f'running: {shell_join(list_cmd)}',
        )
        assert_success(result, f'{sandbox_case.config["agent"]} MCP list command failed', sandbox_case.history)

        combined = '\n'.join(part for part in [result.stdout, result.stderr] if part)
        if sandbox_case.config['agentMcpListNameOutput'] not in combined:
            fail_with_result(
                f'Expected "{sandbox_case.config["agentMcpListNameOutput"]}" in '
                f'{sandbox_case.config["agent"]} MCP list output',
                result,
                sandbox_case.history,
            )
        if sandbox_case.config['agentMcpListSpawnedOutput'] not in combined.lower():
            fail_with_result(
                f'Expected "{sandbox_case.config["agentMcpListSpawnedOutput"]}" in '
                f'{sandbox_case.config["agent"]} MCP list output',
                result,
                sandbox_case.history,
            )
