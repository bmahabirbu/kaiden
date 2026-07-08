---
name: openshell-e2e-testing
description: Guide for maintaining OpenShell pytest regression tests that verify MCP server configs, npm package access, and sandbox behavior
---

# OpenShell E2E Regression Tests

## What these tests do

The tests in `tests/e2e-openshell/` create real OpenShell sandboxes using the same network policy generation code Kaiden uses in production, then assert that MCP config generation, sandbox provisioning, Node.js, npx, and npm-based MCP commands work inside the sandbox.

They are intentionally pytest-native. Avoid adding custom test runners or step-state machines.

## Design rationale

Use pytest as the harness because these tests are primarily CLI and sandbox orchestration: preflight checks, temp files, subprocess transcripts, sandbox lifecycle, skips, and parametrized agent cases. Keep Kaiden behavior in TypeScript by using `generate-config.mts` as a small Node/TS helper that generates config artifacts from production helpers and real agent registrations.

The language split is intentional:

- Python owns orchestration and readable failure reporting.
- The Node/TS helper owns Kaiden config generation, policy generation, agent `preWorkspaceStart()` behavior, and skill upload normalization.
- OpenShell owns the integration boundary through real `openshell sandbox create/exec/delete` commands.

Keep Python out of Kaiden config semantics. The pytest layer should pass JSON into the Node/TS helper, receive JSON back, and then handle OpenShell uploads and assertions. Do not reimplement agent config writers in Python. If `generate-config.mts` grows beyond a narrow adapter, prefer extracting a first-class Kaiden test helper or small Node CLI over duplicating production behavior in pytest.

## Project structure

```
tests/e2e-openshell/
├── agent_cases.py          # Add agent cases here
├── conftest.py             # Pytest fixtures: preflight, gateway, agent_case, sandbox_case
├── claude-extension-runtime.mjs # Test runtime stubs for Claude activation dependencies
├── generate-config.mts     # Node shim importing Kaiden buildPolicyObject()
├── openkaiden-api-runtime.mjs # Test runtime shim for loading real agent registrations
├── openshell_testkit.py    # Command helpers, transcripts, config generation, sandbox model
└── test_sandbox_mcp.py     # Readable pytest assertions
```

## How to add an agent case

Open `tests/e2e-openshell/agent_cases.py` and add a dict to `AGENT_CASES`:

```python
{
    'agent': 'myagent',
    'description': 'npm scoped MCP package via MyAgent',
    'settingsPath': '.config/opencode/opencode.json',
    'mcpName': 'ai.openkaiden.registry/playwright',
    'mcpSettingsKey': 'mcp',
    'mcpEntryType': 'local',
    'mcpCommandStyle': 'array',
    'skills': ['.agents/skills/svelte-code-writer'],
    'skillName': 'svelte-code-writer',
    'skillDestination': '.opencode/skills',
    'skillReadCommand': ['sh', '-lc', 'cat "$HOME/.opencode/skills/svelte-code-writer/SKILL.md"'],
    'skillReadOutput': 'name: svelte-code-writer',
    'network': {'mode': 'deny', 'hosts': ['registry.npmjs.org']},
    'mcpCommands': [
        {
            'name': 'ai.openkaiden.registry/playwright',
            'command': 'npx',
            'args': ['@playwright/mcp@0.0.73'],
        },
    ],
    'spawnCommand': ['npx', '@playwright/mcp@0.0.73', '--help'],
    'spawnOutput': 'Playwright MCP',
    'registryProbeCommand': ['curl', '-fsS', 'https://registry.npmjs.org/@playwright%2fmcp'],
    'registryProbeOutput': '"name":"@playwright/mcp"',
    'agentMcpListCommand': ['opencode', 'mcp', 'list'],
    'agentMcpListNameOutput': 'playwright',
    'agentMcpListSpawnedOutput': 'connected',
}
```

If the new agent stores MCP config somewhere other than OpenCode's config file, add that agent to `loadAgentRegistration()` in `tests/e2e-openshell/generate-config.mts`. Prefer loading the real agent extension and running its registered `preWorkspaceStart()` hook so the test follows production behavior.

## Fixture flow

- `openshell_preflight`: skips if `openshell` is missing, fails if the installed version is older than `extensions/openshell/package.json`.
- `gateway_ready`: skips sandbox tests when the local OpenShell gateway is unreachable.
- `agent_case`: parametrizes tests from `AGENT_CASES`.
- `sandbox_case`: deletes any leftover sandbox, generates policy, agent config files, and skill uploads, creates the sandbox, verifies it appears in `openshell sandbox list`, yields a `SandboxCase`, then deletes the sandbox.

Command transcripts are captured in `openshell_testkit.py` and included only on failures.

## Current assertions

`test_sandbox_mcp.py` currently checks:

1. OpenShell version satisfies the pinned requirement.
2. The OpenShell gateway is reachable.
3. Kaiden can generate a non-empty network policy and agent MCP config at the expected settings path.
4. A sandbox can be created and listed.
5. `node --version` works inside the sandbox.
6. `which npx` works inside the sandbox.
7. `test_network_policy_allows_npm_scoped_package_metadata` uses `openshell sandbox exec` and `curl` to verify the policy allows the scoped npm registry metadata URL.
8. `test_agent_settings_contains_mcp_config` reads the uploaded agent settings file and verifies the MCP entry.
9. `test_agent_skill_file_uploaded` reads the uploaded skill `SKILL.md` from the agent's skills directory.
10. `test_verify_local_npm_mcp_spawned` runs the configured local npm MCP command and checks expected output.
11. `test_agent_mcp_list_sees_spawned_mcp` runs the agent's MCP list command and verifies the agent sees the MCP as spawned/connected, not merely present in config.

## How config generation works

`openshell_testkit.generate_configs()` runs:

```bash
node --import tsx tests/e2e-openshell/generate-config.mts
```

Do not switch this back to `npx tsx`: the `tsx` CLI can open an IPC socket under `/tmp`, which is fragile in restricted test environments.

The TypeScript shim imports or executes production behavior so the E2E test follows Kaiden's runtime behavior:

- `buildPolicyObject()` from `packages/main/src/plugin/openshell-cli/openshell-network-policy.ts`
- `buildOpenshellSkillUploads()` from `packages/main/src/plugin/agent-workspace/openshell-upload-utils.ts`
- OpenCode's real extension registration from `extensions/opencode/src/extension.ts`
- Claude's real extension registration from `extensions/claude/src/extension.ts`

`generate-config.mts` redirects `@openkaiden/api` to `openkaiden-api-runtime.mjs`, captures the registered agent, and runs that agent's `preWorkspaceStart()` hook. This avoids duplicating agent MCP config generation in the tests.

Claude activation also needs light test stubs for provider/manager dependencies. Keep those in `claude-extension-runtime.mjs`; do not duplicate Claude's `.claude.json` writer in Python.

## How to run

```bash
pytest tests/e2e-openshell
pytest tests/e2e-openshell --collect-only
pytest tests/e2e-openshell -k verify_local_npm_mcp_spawned -v -s
```

Requirements:

- `pytest`
- `openshell` CLI in `PATH` at least as new as the pinned version
- configured and reachable OpenShell gateway for sandbox-backed tests
- Node.js with the repo dependencies installed

When the gateway is unreachable, sandbox-backed tests should skip, while host/config generation tests can still pass.

## Key regression behavior

- npm-based MCP servers need `registry.npmjs.org` in the allowed hosts.
- Scoped npm packages use encoded slashes in registry URLs, so the generated policy must continue allowing those requests.
- Delegate sandbox behavior checks to OpenShell commands such as `openshell sandbox exec ... curl ...`.
- Keep skill upload assertions in the same sandbox as MCP assertions. The goal is one agent workspace shape with multiple checks, not separate sandboxes.
- Skills do not have an MCP-style spawn or documented OpenCode CLI list command. If the skill is uploaded to the agent's documented discovery location, assume OpenCode can discover it.
- Keep policy probes, MCP spawn tests, and agent integration tests separate: a registry URL being allowed, a local npm MCP package running in the sandbox, and an agent listing that MCP from its settings are three different behaviors.
