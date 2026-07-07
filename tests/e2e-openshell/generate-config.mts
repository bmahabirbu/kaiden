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

const opencodeConfig = {
  $schema: 'https://opencode.ai/config.json',
  mcp,
};

const output = {
  policy: policy ? stringify(policy) : null,
  opencodeConfig: JSON.stringify(opencodeConfig, undefined, 2),
};

process.stdout.write(JSON.stringify(output));
