import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { stringify } from 'yaml';

import { buildOpenshellSkillUploads } from '../../packages/main/src/plugin/agent-workspace/openshell-upload-utils.js';
import { buildPolicyObject } from '../../packages/main/src/plugin/openshell-cli/openshell-network-policy.js';
import { registeredAgents, resetRegisteredAgents } from './openkaiden-api-runtime.mjs';

const openkaidenApiRuntimeUrl = new URL('./openkaiden-api-runtime.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@openkaiden/api') {
      return { url: openkaidenApiRuntimeUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

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
  skills?: string[];
  modelEndpoint?: string;
}

const input: Input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));

const policy = buildPolicyObject(input.network, input.modelEndpoint);

interface AgentConfigurationFile {
  path: string;
  read(): Promise<string>;
}

interface AgentRegistration {
  id: string;
  configurationFiles: AgentConfigurationFile[];
  destinationSkillsFolder: string;
  preWorkspaceStart(context: {
    model: {
      model: { label: string };
      llmMetadata?: { name: string };
      endpoint?: string;
    };
    configurationFiles: AgentConfigurationFile[];
    workspace: { mcp?: { commands?: McpCommand[] } };
  }): Promise<void>;
}

interface OpenCodeExtensionModule {
  activate(context: { subscriptions: unknown[] }): Promise<void>;
}

async function loadAgentRegistration(agent: string): Promise<AgentRegistration> {
  if (agent === 'opencode') {
    resetRegisteredAgents();

    const extensionModule = await import('../../extensions/opencode/src/extension.ts');
    const extension = resolveCommonJsModule<OpenCodeExtensionModule>(extensionModule);
    await extension.activate({ subscriptions: [] });

    const registration = registeredAgents.find((entry: AgentRegistration) => entry.id === agent);
    if (registration) {
      return registration;
    }
  }

  throw new Error(`Unsupported OpenShell E2E agent: ${agent}`);
}

function resolveCommonJsModule<T>(module: unknown): T {
  const record = module as Record<string, unknown>;
  return (record.default ?? record['module.exports'] ?? module) as T;
}

async function buildAgentConfig(registration: AgentRegistration): Promise<{ uploadPath: string; contents: string }> {
  const baseConfigFile = registration.configurationFiles[0];
  if (!baseConfigFile) {
    throw new Error(`Agent ${registration.id} did not register a configuration file`);
  }

  let contents = await baseConfigFile.read();
  const writableConfigFile = {
    path: baseConfigFile.path,
    read: async () => contents,
    update: async (updated: string) => {
      contents = updated;
    },
  };

  await registration.preWorkspaceStart({
    model: {
      model: { label: 'gpt-4o' },
    },
    configurationFiles: [writableConfigFile],
    workspace: {
      ...(input.mcpCommands?.length ? { mcp: { commands: input.mcpCommands } } : {}),
    },
  });

  return {
    uploadPath: writableConfigFile.path,
    contents,
  };
}

function buildSkillUploads(
  registration: AgentRegistration,
  skills: string[] | undefined,
): { local: string; remote: string }[] {
  return buildOpenshellSkillUploads(skills, registration.destinationSkillsFolder);
}

const agentRegistration = await loadAgentRegistration(input.agent);
const agentConfig = await buildAgentConfig(agentRegistration);

const output = {
  policy: policy ? stringify(policy) : null,
  agentConfig,
  skillUploads: buildSkillUploads(agentRegistration, input.skills),
};

process.stdout.write(JSON.stringify(output));
