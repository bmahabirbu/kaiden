---
name: openshell-e2e-testing
description: Guide for maintaining OpenShell pytest regression tests that verify MCP server configs, npm package access, and sandbox behavior
---

# OpenShell E2E Regression Tests

## What these tests do

The tests in `tests/e2e-openshell/` create real OpenShell sandboxes using the same network policy generation code Kaiden uses in production, then assert that MCP config generation, sandbox provisioning, Node.js, npx, and npm-based MCP commands work inside the sandbox.

They are intentionally pytest-native. Avoid adding custom test runners or step-state machines.

## Project structure

```
tests/e2e-openshell/
├── agent_cases.py          # Add agent cases here
├── conftest.py             # Pytest fixtures: preflight, gateway, agent_case, sandbox_case
├── generate-config.mts     # Node shim importing Kaiden buildPolicyObject()
├── openshell_testkit.py    # Command helpers, transcripts, config generation, sandbox model
└── test_sandbox_mcp.py     # Readable pytest assertions
```

## How to add an agent case

Open `tests/e2e-openshell/agent_cases.py` and add a dict to `AGENT_CASES`:

```python
{
    'agent': 'myagent',
    'description': 'npm scoped MCP package via MyAgent',
    'network': {'mode': 'deny', 'hosts': ['registry.npmjs.org']},
    'mcpCommands': [
        {
            'name': 'ai.openkaiden.registry/playwright',
            'command': 'npx',
            'args': ['@playwright/mcp@0.0.73'],
        },
    ],
    'verifyCommand': ['npx', '@playwright/mcp@0.0.73', '--help'],
    'verifyOutput': 'Playwright MCP',
}
```

If the new agent stores MCP config somewhere other than OpenCode's config file, add that agent to `buildAgentConfig()` in `tests/e2e-openshell/generate-config.mts`. That function returns the sandbox upload path and config file contents for each supported agent.

## Fixture flow

- `openshell_preflight`: skips if `openshell` is missing, fails if the installed version is older than `extensions/openshell/package.json`.
- `gateway_ready`: skips sandbox tests when the local OpenShell gateway is unreachable.
- `agent_case`: parametrizes tests from `AGENT_CASES`.
- `sandbox_case`: deletes any leftover sandbox, generates policy and agent config, creates the sandbox, verifies it appears in `openshell sandbox list`, yields a `SandboxCase`, then deletes the sandbox.

Command transcripts are captured in `openshell_testkit.py` and included only on failures.

## Current assertions

`test_sandbox_mcp.py` currently checks:

1. OpenShell version satisfies the pinned requirement.
2. Kaiden can generate a non-empty network policy and agent MCP config.
3. The OpenShell gateway is reachable.
4. A sandbox can be created and listed.
5. `node --version` works inside the sandbox.
6. `which npx` works inside the sandbox.
7. `test_verify_local_npm_mcp_installed` runs the configured local npm MCP command and checks expected output.

## How config generation works

`openshell_testkit.generate_configs()` runs:

```bash
node --import tsx tests/e2e-openshell/generate-config.mts
```

Do not switch this back to `npx tsx`: the `tsx` CLI can open an IPC socket under `/tmp`, which is fragile in restricted test environments.

The TypeScript shim imports `buildPolicyObject()` from `packages/main/src/plugin/openshell-cli/openshell-network-policy.ts`, so the E2E test uses Kaiden's production policy generation logic.

## How to run

```bash
pytest tests/e2e-openshell
pytest tests/e2e-openshell --collect-only
pytest tests/e2e-openshell -k verify_local_npm_mcp_installed -v -s
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
- `test_verify_local_npm_mcp_installed` is intentionally named after the user-visible behavior: a local npm MCP package can be installed and executed inside the OpenShell sandbox.
