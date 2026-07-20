import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

import { stringify } from 'yaml';

import type { AgentWorkspaceCreateOptions } from '../../packages/api/src/agent-workspace-info.js';
import type { WorkspaceConfiguration } from '../../packages/main/src/plugin/agent-workspace/workspace-config-writer.js';
import { registeredAgents, resetRegisteredAgents } from './openkaiden-api-runtime.mjs';

const HOME_VARIABLE = '${HOME}';
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
    if (specifier.startsWith('/@/')) {
      const sourcePath = specifier.slice('/@/'.length).replace(/\.js$/u, '.ts');
      return {
        url: new URL(`../../packages/main/src/${sourcePath}`, import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith('/@api/')) {
      const sourcePath = specifier.slice('/@api/'.length).replace(/\.js$/u, '.ts');
      return {
        url: new URL(`../../packages/api/src/${sourcePath}`, import.meta.url).href,
        shortCircuit: true,
      };
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

export interface KaidenConfigInput {
  agent: string;
  sourcePath: string;
  settingsPath?: string;
  network?: { mode: 'allow' | 'deny'; hosts?: string[] };
  mcpCommands?: McpCommand[];
  skills?: string[];
  modelLabel?: string;
  llmMetadataName?: string;
  modelEndpoint?: string;
}

interface AgentConfigurationFile {
  path: string;
  read(): Promise<string>;
}

interface AgentRegistration {
  id: string;
  configurationFiles: AgentConfigurationFile[];
  baseImage?: string;
  destinationSkillsFolder: string;
  isSupportedModelType?(type: { name: string }): boolean | Promise<boolean>;
  preWorkspaceStart(context: {
    model: {
      model: { label: string };
      llmMetadata?: { name: string };
      endpoint?: string;
    };
    configurationFiles: AgentConfigurationFile[];
    workspace: WorkspaceConfiguration;
  }): Promise<void>;
}

type OpenshellUpload = { local: string; remote: string };

interface AgentExtensionModule {
  activate(context: { subscriptions: unknown[] }): Promise<void>;
}

export interface GeneratedKaidenArtifacts {
  policy: string | null;
  workspaceConfig: WorkspaceConfiguration;
  agentConfig: { uploadPath: string; contents: string };
  agentConfigs: { uploadPath: string; contents: string }[];
  baseImage: string | null;
  skillUploads: OpenshellUpload[];
  workspaceEnvironment: { name: string; value: string }[];
}

export async function generateKaidenArtifacts(input: KaidenConfigInput): Promise<GeneratedKaidenArtifacts> {
  if (!input.sourcePath) {
    throw new Error('OpenShell E2E config generation requires sourcePath');
  }

  const [{ writeWorkspaceConfig }, { buildPolicyObject, rewriteLocalhostUrl }] = await Promise.all([
    import('../../packages/main/src/plugin/agent-workspace/workspace-config-writer.js'),
    import('../../packages/main/src/plugin/openshell-cli/openshell-network-policy.js'),
  ]);
  const modelEndpoint = input.modelEndpoint ? rewriteLocalhostUrl(input.modelEndpoint) : undefined;
  const workspace = await writeWorkspaceConfig(buildWorkspaceCreateOptions(input));
  const workspaceConfig = structuredClone(workspace);
  const agentRegistration = await loadAgentRegistration(input.agent);
  const agentConfigs = await buildAgentConfigs(agentRegistration, input, workspace, modelEndpoint);
  const agentConfig = input.settingsPath
    ? (agentConfigs.find(config => config.uploadPath === input.settingsPath) ?? agentConfigs[0])
    : agentConfigs[0];

  if (!agentConfig) {
    throw new Error(`Agent ${agentRegistration.id} did not generate a configuration file`);
  }

  const policy = buildPolicyObject(workspace.network, modelEndpoint);

  return {
    policy: policy ? stringify(policy) : null,
    workspaceConfig,
    agentConfig,
    agentConfigs,
    baseImage: agentRegistration.baseImage ?? null,
    skillUploads: buildOpenshellSkillUploads(input.skills, agentRegistration.destinationSkillsFolder),
    workspaceEnvironment: buildWorkspaceEnvironment(workspace),
  };
}

function buildWorkspaceCreateOptions(input: KaidenConfigInput): AgentWorkspaceCreateOptions {
  const provider = input.llmMetadataName ?? 'openai';
  const modelLabel = input.modelLabel ?? 'gpt-4o';
  const endpoint = input.modelEndpoint ?? '';

  return {
    sourcePath: input.sourcePath,
    agent: input.agent,
    model: `${provider}::${modelLabel}::${endpoint}`,
    skills: input.skills,
    network: input.network,
    mcp: input.mcpCommands?.length ? { commands: input.mcpCommands } : undefined,
  };
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
  const extension = resolveCommonJsModule<AgentExtensionModule>(extensionModule);
  await extension.activate({ subscriptions: [] });
}

function resolveCommonJsModule<T>(module: unknown): T {
  const record = module as Record<string, unknown>;
  return (record.default ?? record['module.exports'] ?? module) as T;
}

async function buildAgentConfigs(
  registration: AgentRegistration,
  input: KaidenConfigInput,
  workspace: WorkspaceConfiguration,
  modelEndpoint: string | undefined,
): Promise<{ uploadPath: string; contents: string }[]> {
  if (!registration.configurationFiles.length) {
    throw new Error(`Agent ${registration.id} did not register a configuration file`);
  }

  const writableConfigFiles = await Promise.all(
    registration.configurationFiles.map(async baseConfigFile => {
      let contents = await baseConfigFile.read();
      return {
        path: baseConfigFile.path,
        read: async (): Promise<string> => contents,
        update: async (updated: string): Promise<void> => {
          contents = updated;
        },
      };
    }),
  );

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

  return Promise.all(
    writableConfigFiles.map(async file => ({
      uploadPath: file.path,
      contents: await file.read(),
    })),
  );
}

function buildWorkspaceEnvironment(workspace: WorkspaceConfiguration): { name: string; value: string }[] {
  return (workspace.environment ?? []).flatMap(entry =>
    typeof entry.value === 'string' && entry.value !== '' ? [{ name: entry.name, value: entry.value }] : [],
  );
}

function buildOpenshellSkillUploads(skills: string[] | undefined, destinationSkillsFolder: string): OpenshellUpload[] {
  if (!skills?.length) {
    return [];
  }

  const remoteBase = resolveOpenshellSkillsDestination(destinationSkillsFolder);
  return skills.map(skillPath => ({
    local: skillPath,
    remote: remoteBase,
  }));
}

function resolveOpenshellSkillsDestination(destinationSkillsFolder: string): string {
  if (destinationSkillsFolder === HOME_VARIABLE) {
    return '.';
  }

  for (const str of [`${HOME_VARIABLE}/`, '~/']) {
    if (destinationSkillsFolder.startsWith(str)) {
      return destinationSkillsFolder.slice(str.length);
    }
  }

  if (destinationSkillsFolder.includes('..')) {
    throw new Error(`Invalid destination skills folder: ${destinationSkillsFolder}`);
  }

  return destinationSkillsFolder;
}
