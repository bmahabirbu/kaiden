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

import type { AgentConfigurationFile, AgentWorkspaceContext, Disposable, ExtensionContext } from '@openkaiden/api';
import { agents } from '@openkaiden/api';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { activate, OPENCLAW_CONFIG_PATH } from './extension';

const AGENT_DISPOSABLE_MOCK: Disposable = { dispose: vi.fn() };

let extensionContextMock: ExtensionContext;

beforeEach(() => {
  vi.resetAllMocks();

  extensionContextMock = {
    subscriptions: [],
  } as unknown as ExtensionContext;

  vi.mocked(agents.registerAgent).mockReturnValue(AGENT_DISPOSABLE_MOCK);
});

describe('activate', () => {
  test('registers openclaw agent', async () => {
    await activate(extensionContextMock);

    expect(agents.registerAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'openclaw',
        name: 'OpenClaw',
        description: expect.any(String),
        icon: expect.objectContaining({ icon: './icon.png' }),
        destinationSkillsFolder: '${HOME}/.openclaw/skills',
        isSupportedModelType: expect.any(Function),
      }),
    );
  });

  test('pushes agent disposable to subscriptions', async () => {
    await activate(extensionContextMock);

    expect(extensionContextMock.subscriptions).toContain(AGENT_DISPOSABLE_MOCK);
  });

  test('registered agent supports all model types except vertexai', async () => {
    await activate(extensionContextMock);

    const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];
    expect(agent.isSupportedModelType!({ name: 'openai' })).toBe(true);
    expect(agent.isSupportedModelType!({ name: 'gemini' })).toBe(true);
    expect(agent.isSupportedModelType!({ name: 'vertexai' })).toBe(false);
  });

  test('registers agent with openclaw.json configuration file', async () => {
    await activate(extensionContextMock);

    const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];
    expect(agent.configurationFiles).toHaveLength(1);
    expect(agent.configurationFiles[0]!.path).toBe(OPENCLAW_CONFIG_PATH);
  });

  describe('preWorkspaceStart', () => {
    function createContext(
      configFiles: AgentConfigurationFile[],
      modelLabel = 'anthropic/claude-opus-4-6',
    ): AgentWorkspaceContext {
      return {
        model: {
          model: { label: modelLabel },
        },
        configurationFiles: configFiles,
      };
    }

    function createConfigFile(content = '{}'): AgentConfigurationFile & { updateMock: ReturnType<typeof vi.fn> } {
      const updateMock = vi.fn();
      const file: AgentConfigurationFile = {
        path: OPENCLAW_CONFIG_PATH,
        read: vi.fn().mockResolvedValue(content),
        update: updateMock,
      };
      return Object.assign(file, { updateMock });
    }

    test('writes model configuration into openclaw.json', async () => {
      await activate(extensionContextMock);
      const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];

      const configFile = createConfigFile();
      await agent.preWorkspaceStart(createContext([configFile]));

      expect(configFile.updateMock).toHaveBeenCalledOnce();
      const written = JSON.parse(configFile.updateMock.mock.calls[0]![0] as string);
      expect(written).toEqual({
        agents: { defaults: { model: 'anthropic/claude-opus-4-6' } },
      });
    });

    test('preserves existing configuration fields', async () => {
      await activate(extensionContextMock);
      const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];

      const existingConfig = JSON.stringify({
        agents: { defaults: { model: 'old-model', params: { cacheRetention: 'long' } } },
        other: true,
      });
      const configFile = createConfigFile(existingConfig);
      await agent.preWorkspaceStart(createContext([configFile], 'openai/gpt-5.5'));

      const written = JSON.parse(configFile.updateMock.mock.calls[0]![0] as string);
      expect(written.agents.defaults.model).toBe('openai/gpt-5.5');
      expect(written.agents.defaults.params.cacheRetention).toBe('long');
      expect(written.other).toBe(true);
    });

    test.each([
      'null',
      '"a string"',
      '123',
      'true',
      '[1, 2]',
    ])('falls back to empty config when parsed JSON is non-object: %s', async (payload: string) => {
      await activate(extensionContextMock);
      const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];

      const configFile = createConfigFile(payload);
      await agent.preWorkspaceStart(createContext([configFile]));

      expect(configFile.updateMock).toHaveBeenCalledOnce();
      const written = JSON.parse(configFile.updateMock.mock.calls[0]![0] as string);
      expect(written.agents.defaults.model).toBe('anthropic/claude-opus-4-6');
    });

    test('handles invalid JSON by starting with empty config', async () => {
      await activate(extensionContextMock);
      const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];

      const configFile = createConfigFile('not valid json');
      await agent.preWorkspaceStart(createContext([configFile]));

      expect(configFile.updateMock).toHaveBeenCalledOnce();
      const written = JSON.parse(configFile.updateMock.mock.calls[0]![0] as string);
      expect(written.agents.defaults.model).toBe('anthropic/claude-opus-4-6');
    });

    test('does nothing when config file is not in context', async () => {
      await activate(extensionContextMock);
      const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];

      const updateMock = vi.fn();
      const otherFile: AgentConfigurationFile = {
        path: 'some/other/path.json',
        read: vi.fn(),
        update: updateMock,
      };

      await agent.preWorkspaceStart(createContext([otherFile]));

      expect(updateMock).not.toHaveBeenCalled();
    });
  });
});
