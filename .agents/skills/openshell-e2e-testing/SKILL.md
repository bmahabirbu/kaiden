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
├── agent-command-registry.json # Add agent command capabilities here
├── agent_cases.py          # Expands registry entries into pytest cases
├── conftest.py             # Pytest fixtures: preflight, gateway, agent_case, sandbox_case
├── claude-extension-runtime.mjs # Test runtime stubs for Claude activation dependencies
├── generate-config.mts     # Node shim importing Kaiden buildPolicyObject()
├── openkaiden-api-runtime.mjs # Test runtime shim for loading real agent registrations
├── openshell_testkit.py    # Command helpers, transcripts, config generation, sandbox model
├── test_opencode_local_openai_cli.py # OpenCode smoke test against a local OpenAI-compatible endpoint
├── test_sandbox_mcp.py     # MCP plus skill upload pytest assertions
├── test_sandbox_skills.py  # Optional skill-list CLI assertions
└── test_vertex_cli.py      # Prompt-capable agent Vertex smoke tests
```

## How to add an agent

Open `tests/e2e-openshell/agent-command-registry.json` and add the agent's CLI capabilities:

```json
{
  "agent": "myagent",
  "enabled": true,
  "commands": {
    "mcpList": ["myagent", "mcp", "list"],
    "prompt": ["myagent", "run", "{prompt}", "--model", "{provider}/{model}"],
    "skillList": ["myagent", "skill", "list"]
  }
}
```

Only include commands the agent actually supports:

- `enabled`: optional, defaults to `true`. Set `false` to keep an agent in the registry without generating tests for it.
- `mcpList`: generates the MCP regression sandbox. That sandbox also uploads the standard skill and asserts the skill file exists at the destination generated from the registered Kaiden agent.
- `prompt`: generates prompt smoke tests. The command can use `{prompt}`, `{provider}`, and `{model}` placeholders.
- `skillList`: generates an additional skill discovery test for agents that can list skills from the CLI.

The agent entry is ignored unless `extensions/<agent>/src/extension.ts` exists. Do not put settings paths, MCP config keys, skill destinations, or extension paths in the JSON. `generate-config.mts` loads the real extension by convention, captures the registered agent, uses its `configurationFiles` and `destinationSkillsFolder`, and runs `preWorkspaceStart()` so the tests follow production behavior.

Provider compatibility should come from the registered Kaiden agent. For prompt tests, `generate-config.mts` checks `agent.isSupportedModelType()` when present; unsupported provider/model types should skip or fail setup instead of being duplicated in JSON.

## Fixture flow

- `openshell_preflight`: skips if `openshell` is missing, fails if the installed version is older than `extensions/openshell/package.json`.
- `gateway_ready`: skips sandbox tests when the local OpenShell gateway is unreachable.
- `agent_case`: parametrizes MCP tests from registry entries with `commands.mcpList`.
- `sandbox_case`: deletes any leftover sandbox, generates policy, agent config files, and skill uploads, creates the sandbox, verifies it appears in `openshell sandbox list`, yields a `SandboxCase`, then deletes the sandbox.
- `agent_prompt_case`: parametrizes prompt tests from registry entries with `commands.prompt`.
- `agent_skill_case`: parametrizes optional skill discovery tests from registry entries with `commands.skillList`.

Command transcripts are captured in `openshell_testkit.py` and included only on failures.

## Current assertions

`test_sandbox_mcp.py` currently checks:

1. OpenShell version satisfies the pinned requirement.
2. The OpenShell gateway is reachable.
3. Kaiden can generate a non-empty network policy and at least one generated agent config containing the expected MCP command.
4. A sandbox can be created and listed.
5. `node --version` works inside the sandbox.
6. `which npx` works inside the sandbox.
7. `test_network_policy_allows_npm_scoped_package_metadata` uses `openshell sandbox exec` and `curl` to verify the policy allows the scoped npm registry metadata URL.
8. `test_agent_settings_contains_mcp_config` reads the uploaded agent settings file and verifies the MCP entry.
9. `test_agent_skill_file_uploaded` reads the uploaded skill `SKILL.md` from the Kaiden-generated agent skills destination.
10. `test_verify_local_npm_mcp_spawned` runs the configured local npm MCP command and checks expected output.
11. `test_agent_mcp_list_sees_spawned_mcp` runs the agent's MCP list command and verifies the agent sees the MCP as spawned/connected, not merely present in config.

`test_sandbox_skills.py` adds extra skill-list assertions only for registry entries with `commands.skillList`. Most agents do not expose a skill-list CLI, so the MCP sandbox's skill upload/location assertion remains the baseline skill regression.

`test_vertex_cli.py` runs prompt smoke tests for registry entries with `commands.prompt`, using the real agent registration to decide provider support.

## How config generation works

`openshell_testkit.generate_configs()` runs:

```bash
node --import tsx tests/e2e-openshell/generate-config.mts
```

Do not switch this back to `npx tsx`: the `tsx` CLI can open an IPC socket under `/tmp`, which is fragile in restricted test environments.

The TypeScript shim imports or executes production behavior so the E2E test follows Kaiden's runtime behavior:

- `buildPolicyObject()` from `packages/main/src/plugin/openshell-cli/openshell-network-policy.ts`
- `buildOpenshellSkillUploads()` from `packages/main/src/plugin/agent-workspace/openshell-upload-utils.ts`
- the real extension registration from `extensions/<agent>/src/extension.ts`

`generate-config.mts` redirects `@openkaiden/api` to `openkaiden-api-runtime.mjs`, captures the registered agent, checks model-type support when applicable, and runs that agent's `preWorkspaceStart()` hook. This avoids duplicating agent config generation in the tests.

Claude activation also needs light test stubs for provider/manager dependencies. Keep those in `claude-extension-runtime.mjs`; do not duplicate Claude's `.claude.json` writer in Python.

The local OpenAI-compatible OpenCode smoke test intentionally follows the same OpenCode config path Kaiden uses.
Pytest may discover or start a local endpoint, but it still passes `modelLabel`, `llmMetadataName: "openai"`,
and `modelEndpoint` into `generate-config.mts`; the real OpenCode `preWorkspaceStart()` hook writes
`provider.openai` with `@ai-sdk/openai-compatible` and the rewritten sandbox base URL. Do not inject
`OPENAI_API_KEY` or hand-write an OpenCode provider block in Python for this case, because that can change
OpenCode provider loading behavior.

## How to run

```bash
pytest tests/e2e-openshell
pytest tests/e2e-openshell --collect-only
pytest tests/e2e-openshell -k verify_local_npm_mcp_spawned -v -s
KAIDEN_E2E_LOCAL=true pytest tests/e2e-openshell/test_opencode_local_openai_cli.py -q
```

`KAIDEN_E2E_LOCAL=true` is a manual local-only OpenCode inference smoke test. When RamaLama is available,
the test validates `ramalama --version`, starts `ramalama serve` for the default local model, waits for
`/v1/models`, uses the exact returned model id, and lets Kaiden's OpenCode shim generate the config.
The local RamaLama launcher uses `--ctx-size 16384` by default because OpenCode's initial agent context
can exceed 4096 tokens; override with `KAIDEN_E2E_LOCAL_CTX_SIZE` or `KAIDEN_E2E_RAMALAMA_CTX_SIZE` when needed.

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
- Skills do not always have a documented CLI list command. If the skill is uploaded to the agent's registered destination, assume the agent can discover it unless the agent also has `commands.skillList`, in which case assert the CLI sees it too.
- Keep policy probes, MCP spawn tests, and agent integration tests separate: a registry URL being allowed, a local npm MCP package running in the sandbox, and an agent listing that MCP from its settings are three different behaviors.
