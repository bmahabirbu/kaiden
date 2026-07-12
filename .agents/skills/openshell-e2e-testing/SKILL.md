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
├── test_00_openshell_preflight.py # Generic OpenShell availability checks
├── test_01_openshell_github_credentials.py # Generic GitHub credential upload assertions
├── test_01_openshell_uploads.py # Generic OpenShell source upload assertions
├── test_02_sandbox_npm_mcp_skill.py # npm MCP plus skill upload pytest assertions
├── test_03_prompt_openai_local_cli.py # Local OpenAI-compatible prompt smoke test
├── test_03_prompt_vertex_cli.py # Vertex prompt smoke tests
├── test_sandbox_skills.py  # Optional skill-list CLI assertions
└── vertex_cli_testkit.py
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

Pytest or Python syntax checks may create `__pycache__/` directories while validating these tests. Do not spend time deleting those cache files during normal work; leave them untracked and do not include them in commits.

## Current assertions

`test_00_openshell_preflight.py` checks:

1. OpenShell version satisfies the pinned requirement.
2. The OpenShell gateway is reachable.

`test_01_openshell_uploads.py` covers generic OpenShell upload behavior that Kaiden relies on: uploading a source directory so it is accessible from the sandbox working directory, and uploading a `$SOURCES` subdirectory so it appears at the matching sandbox subdirectory.

`test_01_openshell_github_credentials.py` covers generic provider credential behavior for GitHub: creating a GitHub provider from existing host credentials, attaching it to a sandbox, and verifying the sandbox can use the uploaded `GITHUB_TOKEN` with GitHub's REST API.

`test_02_sandbox_npm_mcp_skill.py` currently checks:

1. Kaiden can generate a non-empty network policy and at least one generated agent config containing the expected MCP command.
2. A sandbox can be created and listed.
3. `node --version` works inside the sandbox.
4. `which npx` works inside the sandbox.
5. `test_network_policy_allows_npm_scoped_package_metadata` uses `openshell sandbox exec` and `curl` to verify the policy allows the scoped npm registry metadata URL.
6. `test_agent_settings_contains_mcp_config` reads the uploaded agent settings file and verifies the MCP entry.
7. `test_agent_skill_file_uploaded` reads the uploaded skill `SKILL.md` from the Kaiden-generated agent skills destination.
8. `test_verify_local_npm_mcp_spawned` runs the configured local npm MCP command and checks expected output.
9. `test_agent_mcp_list_sees_spawned_mcp` runs the agent's MCP list command and verifies the agent sees the MCP as spawned/connected, not merely present in config.

`test_sandbox_skills.py` adds extra skill-list assertions only for registry entries with `commands.skillList`. Most agents do not expose a skill-list CLI, so the MCP sandbox's skill upload/location assertion remains the baseline skill regression.

`test_03_prompt_vertex_cli.py` runs Vertex prompt smoke tests for registry entries with `commands.prompt`, using the real agent registration to decide provider support. It covers default prompt behavior and a skill-backed prompt in the same sandbox.

`test_03_prompt_openai_local_cli.py` runs the local OpenAI-compatible OpenCode prompt smoke test when explicitly enabled by environment. It covers default prompt behavior and a skill-backed prompt in the same sandbox.

## How config generation works

`openshell_testkit.generate_configs()` runs:

```bash
node --import tsx tests/e2e-openshell/generate-config.mts
```

Do not switch this back to `npx tsx`: the `tsx` CLI can open an IPC socket under `/tmp`, which is fragile in restricted test environments.

The TypeScript shim imports or executes production behavior so the E2E test follows Kaiden's runtime behavior:

- `buildPolicyObject()` from `packages/main/src/plugin/openshell-cli/openshell-network-policy.ts`
- the real extension registration from `extensions/<agent>/src/extension.ts`

`generate-config.mts` redirects `@openkaiden/api` to `openkaiden-api-runtime.mjs`, captures the registered agent, checks model-type support when applicable, runs that agent's `preWorkspaceStart()` hook, and builds only the minimal upload descriptors needed by the OpenShell tests. This avoids duplicating agent config generation in the tests.

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
KAIDEN_E2E_KEEP_SANDBOXES=true pytest tests/e2e-openshell -k sandbox -v -s
KAIDEN_E2E_GITHUB_TOKEN=... pytest tests/e2e-openshell/test_01_openshell_github_credentials.py -q
KAIDEN_E2E_RAMALAMA=true pytest tests/e2e-openshell/test_03_prompt_openai_local_cli.py -q
```

Set `KAIDEN_E2E_KEEP_SANDBOXES=true` to skip sandbox cleanup after tests, which is useful when inspecting a sandbox manually after a failure. The tests still delete an existing sandbox with the same deterministic name before creating a new one.

When interrupting a run with Ctrl-C, pytest should still run fixture teardown for any sandbox that reached creation. The harness prints a short interruption message and then follows the normal cleanup behavior, including `KAIDEN_E2E_KEEP_SANDBOXES=true` when set.

Set `KAIDEN_E2E_GITHUB_TOKEN` to run the GitHub credential upload test. The test exposes that value as `GITHUB_TOKEN` only for `openshell provider create --from-existing`, matching the documented GitHub provider flow without putting the secret in command transcripts. Use `gh api /user` for this regression; avoid `gh auth status` because it can require GitHub GraphQL access beyond the default REST policy.

`KAIDEN_E2E_RAMALAMA=true` is a manual local-only OpenCode inference smoke test. When RamaLama is available,
the test validates `ramalama --version`, starts `ramalama serve` for the default local model, waits for
`/v1/models`, uses the exact returned model id, and lets Kaiden's OpenCode shim generate the config.
The local RamaLama launcher uses `--ctx-size 16384` by default because OpenCode's initial agent context
can exceed 4096 tokens; override with `KAIDEN_E2E_RAMALAMA_CTX_SIZE` when needed.

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
- Keep generic OpenShell upload regressions outside the agent matrix unless they require agent-specific config.
- Keep skill upload assertions in the same sandbox as MCP assertions. The goal is one agent workspace shape with multiple checks, not separate sandboxes.
- Skills do not always have a documented CLI list command. If the skill is uploaded to the agent's registered destination, assume the agent can discover it unless the agent also has `commands.skillList`, in which case assert the CLI sees it too.
- Keep policy probes, MCP spawn tests, and agent integration tests separate: a registry URL being allowed, a local npm MCP package running in the sandbox, and an agent listing that MCP from its settings are three different behaviors.
