import { readFileSync } from 'node:fs';
import { stringify } from 'yaml';

import { buildPolicyObject } from '../../packages/main/src/plugin/openshell-cli/openshell-network-policy.js';

interface McpCommand {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface Input {
  agent: string;
  network?: { mode: 'allow' | 'deny'; hosts?: string[] };
  mcpCommands?: McpCommand[];
  modelEndpoint?: string;
}

const input: Input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));

const policy = buildPolicyObject(input.network, input.modelEndpoint);

const mcp: Record<string, object> = {};
for (const cmd of input.mcpCommands ?? []) {
  mcp[cmd.name] = {
    type: 'local',
    command: [cmd.command, ...(cmd.args ?? [])],
    enabled: true,
    ...(cmd.env && Object.keys(cmd.env).length > 0 ? { environment: cmd.env } : {}),
  };
}

function buildAgentConfig(agent: string, mcpConfig: Record<string, object>): { uploadPath: string; contents: string } {
  if (agent === 'opencode') {
    return {
      uploadPath: '.config/opencode/opencode.json',
      contents: JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: mcpConfig,
        },
        undefined,
        2,
      ),
    };
  }

  throw new Error(`Unsupported OpenShell E2E agent: ${agent}`);
}

const agentConfig = buildAgentConfig(input.agent, mcp);

const output = {
  policy: policy ? stringify(policy) : null,
  agentConfig,
};

process.stdout.write(JSON.stringify(output));
