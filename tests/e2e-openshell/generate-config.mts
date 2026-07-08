import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { stringify } from 'yaml';

import { buildOpenshellSkillUploads } from '../../packages/main/src/plugin/agent-workspace/openshell-upload-utils.js';
import {
  buildPolicyObject,
  rewriteLocalhostUrl,
} from '../../packages/main/src/plugin/openshell-cli/openshell-network-policy.js';
import { registeredAgents, resetRegisteredAgents } from './openkaiden-api-runtime.mjs';

const openkaidenApiRuntimeUrl = new URL('./openkaiden-api-runtime.mjs', import.meta.url).href;
const claudeExtensionRuntimeUrl = new URL('./claude-extension-runtime.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@openkaiden/api') {
      return { url: openkaidenApiRuntimeUrl, shortCircuit: true };
    }
    if (
      [
        '/@/inject/inversify-binding',
        '/@/manager/claude-inference-manager',
        '/@/manager/claude-skills-manager',
      ].includes(specifier)
    ) {
      return { url: claudeExtensionRuntimeUrl, shortCircuit: true };
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
  settingsPath?: string;
  network?: { mode: 'allow' | 'deny'; hosts?: string[] };
  mcpCommands?: McpCommand[];
  skills?: string[];
  modelLabel?: string;
  llmMetadataName?: string;
  modelEndpoint?: string;
}

const input: Input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
const modelEndpoint = input.modelEndpoint ? rewriteLocalhostUrl(input.modelEndpoint) : undefined;

const policy = buildPolicyObject(input.network, modelEndpoint);

interface AgentConfigurationFile {
  path: string;
  read(): Promise<string>;
}

interface AgentRegistration {
  id: string;
  configurationFiles: AgentConfigurationFile[];
  destinationSkillsFolder: string;
  isSupportedModelType?(type: { name: string }): boolean | Promise<boolean>;
  preWorkspaceStart(context: {
    model: {
      model: { label: string };
      llmMetadata?: { name: string };
      endpoint?: string;
    };
    configurationFiles: AgentConfigurationFile[];
    workspace: {
      environment?: { name: string; value: string }[];
      mcp?: { commands?: McpCommand[] };
    };
  }): Promise<void>;
}

interface OpenCodeExtensionModule {
  activate(context: { subscriptions: unknown[] }): Promise<void>;
}

async function loadAgentRegistration(agent: string): Promise<AgentRegistration> {
  resetRegisteredAgents();

  if (!/^[a-z0-9-]+$/u.test(agent)) {
    throw new Error(`Invalid OpenShell E2E agent id: ${agent}`);
  }
  const extensionUrl = new URL(`../../extensions/${agent}/src/extension.ts`, import.meta.url);
  if (!existsSync(extensionUrl)) {
    throw new Error(`Unsupported OpenShell E2E agent: ${agent}; expected ${extensionUrl.pathname}`);
  }

  await activateExtension(extensionUrl.href);

  const registration = registeredAgents.find((entry: AgentRegistration) => entry.id === agent);
  if (registration) {
    return registration;
  }

  throw new Error(`Unsupported OpenShell E2E agent: ${agent}`);
}

async function activateExtension(url: string): Promise<void> {
  const extensionModule = await import(url);
  const extension = resolveCommonJsModule<OpenCodeExtensionModule>(extensionModule);
  await extension.activate({ subscriptions: [] });
}

function resolveCommonJsModule<T>(module: unknown): T {
  const record = module as Record<string, unknown>;
  return (record.default ?? record['module.exports'] ?? module) as T;
}

async function buildAgentConfigs(registration: AgentRegistration): Promise<{
  configs: { uploadPath: string; contents: string }[];
  workspaceEnvironment: { name: string; value: string }[];
}> {
  if (!registration.configurationFiles.length) {
    throw new Error(`Agent ${registration.id} did not register a configuration file`);
  }

  const writableConfigFiles = await Promise.all(
    registration.configurationFiles.map(async baseConfigFile => {
      let contents = await baseConfigFile.read();
      return {
        path: baseConfigFile.path,
        read: async () => contents,
        update: async (updated: string) => {
          contents = updated;
        },
      };
    }),
  );

  const workspace: {
    environment?: { name: string; value: string }[];
    mcp?: { commands?: McpCommand[] };
  } = {
    environment: [],
    ...(input.mcpCommands?.length ? { mcp: { commands: input.mcpCommands } } : {}),
  };

  if (input.llmMetadataName && registration.isSupportedModelType) {
    const supported = await registration.isSupportedModelType({ name: input.llmMetadataName });
    if (!supported) {
      throw new Error(`Agent ${registration.id} does not support model type ${input.llmMetadataName}`);
    }
  }

  await registration.preWorkspaceStart({
    model: {
      model: { label: input.modelLabel ?? 'gpt-4o' },
      ...(input.llmMetadataName ? { llmMetadata: { name: input.llmMetadataName } } : {}),
      ...(modelEndpoint ? { endpoint: modelEndpoint } : {}),
    },
    configurationFiles: writableConfigFiles,
    workspace,
  });

  const configs = await Promise.all(
    writableConfigFiles.map(async file => ({
      uploadPath: file.path,
      contents: await file.read(),
    })),
  );

  return { configs, workspaceEnvironment: workspace.environment ?? [] };
}

function buildSkillUploads(
  registration: AgentRegistration,
  skills: string[] | undefined,
): { local: string; remote: string }[] {
  return buildOpenshellSkillUploads(skills, registration.destinationSkillsFolder);
}

const agentRegistration = await loadAgentRegistration(input.agent);
const { configs: agentConfigs, workspaceEnvironment } = await buildAgentConfigs(agentRegistration);
const agentConfig = input.settingsPath
  ? (agentConfigs.find(config => config.uploadPath === input.settingsPath) ?? agentConfigs[0])
  : agentConfigs[0];

const output = {
  policy: policy ? stringify(policy) : null,
  agentConfig,
  agentConfigs,
  skillUploads: buildSkillUploads(agentRegistration, input.skills),
  workspaceEnvironment,
};

process.stdout.write(JSON.stringify(output));
