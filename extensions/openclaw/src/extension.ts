/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import type { AgentWorkspaceContext, ExtensionContext, ModelType } from '@openkaiden/api';
import { agents } from '@openkaiden/api';
import { z } from 'zod';

type JsonObject = Record<string, unknown>;

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), z.unknown());

const OpenClawAgentsSchema = z
  .object({
    defaults: JsonObjectSchema.catch({}).optional(),
  })
  .catchall(z.unknown())
  .catch({});

const OpenClawConfigSchema = z
  .object({
    agents: OpenClawAgentsSchema.optional(),
  })
  .catchall(z.unknown());

type OpenClawConfig = z.output<typeof OpenClawConfigSchema>;

export const OPENCLAW_CONFIG_PATH = 'openclaw.json';

function parseOpenClawConfig(content: string): OpenClawConfig {
  try {
    const parsed: unknown = JSON.parse(content);
    const result = OpenClawConfigSchema.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

export async function activate(extensionContext: ExtensionContext): Promise<void> {
  const disposable = agents.registerAgent({
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Open-source autonomous AI agent — local models via Ollama or Ramalama, or cloud APIs.',
    icon: {
      icon: './icon.png',
      logo: './icon.png',
    },
    command: 'openclaw',
    acp: { args: ['acp'] },
    configurationFiles: [
      {
        path: OPENCLAW_CONFIG_PATH,
        async read(): Promise<string> {
          return '{}';
        },
      },
    ],
    destinationSkillsFolder: '${HOME}/.openclaw/skills',
    isSupportedModelType(type: ModelType): boolean {
      return type.name !== 'vertexai';
    },
    async preWorkspaceStart(context: AgentWorkspaceContext): Promise<void> {
      const configFile = context.configurationFiles.find(f => f.path === OPENCLAW_CONFIG_PATH);
      if (!configFile) {
        return;
      }

      const config = parseOpenClawConfig(await configFile.read());
      const nextConfig: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...(config.agents?.defaults ?? {}),
            model: context.model.model.label,
          },
        },
      };

      await configFile.update(JSON.stringify(nextConfig, undefined, 2));
    },
  });
  extensionContext.subscriptions.push(disposable);
}

export function deactivate(): void {}
