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

import { activate, GOOSE_CONFIG_PATH } from './extension';

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
  test('registers goose agent', async () => {
    await activate(extensionContextMock);

    expect(agents.registerAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'goose',
        name: 'Goose',
        description: expect.any(String),
        icon: expect.objectContaining({ icon: { dark: './icon_dark.png', light: './icon_light.png' } }),
        destinationSkillsFolder: '${HOME}/.agents/skills',
        isSupportedModelType: expect.any(Function),
        isSupportedRuntime: expect.any(Function),
      }),
    );
  });

  test('pushes agent disposable to subscriptions', async () => {
    await activate(extensionContextMock);

    expect(extensionContextMock.subscriptions).toContain(AGENT_DISPOSABLE_MOCK);
  });

  test('registered agent supports only podman runtime', async () => {
    await activate(extensionContextMock);

    const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];
    expect(agent.isSupportedRuntime!('podman')).toBe(true);
    expect(agent.isSupportedRuntime!('openshell')).toBe(false);
  });

  test('registered agent supports all model types', async () => {
    await activate(extensionContextMock);

    const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];
    expect(agent.isSupportedModelType!({ name: 'gemini' })).toBe(true);
    expect(agent.isSupportedModelType!({ name: 'openai' })).toBe(true);
  });

  test('registers agent with config.yaml configuration file', async () => {
    await activate(extensionContextMock);

    const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];
    expect(agent.configurationFiles).toHaveLength(1);
    expect(agent.configurationFiles[0]!.path).toBe(GOOSE_CONFIG_PATH);
  });

  describe('preWorkspaceStart', () => {
    function createContext(configFiles: AgentConfigurationFile[], modelLabel = 'gpt-4o'): AgentWorkspaceContext {
      return {
        model: {
          model: { label: modelLabel },
        },
        configurationFiles: configFiles,
      };
    }

    function createConfigFile(content = ''): AgentConfigurationFile & { updateMock: ReturnType<typeof vi.fn> } {
      const updateMock = vi.fn();
      const file: AgentConfigurationFile = {
        path: GOOSE_CONFIG_PATH,
        read: vi.fn().mockResolvedValue(content),
        update: updateMock,
      };
      return Object.assign(file, { updateMock });
    }

    test('writes model configuration into config.yaml', async () => {
      await activate(extensionContextMock);
      const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];

      const configFile = createConfigFile();
      await agent.preWorkspaceStart(createContext([configFile]));

      expect(configFile.updateMock).toHaveBeenCalledOnce();
      expect(configFile.updateMock.mock.calls[0]![0]).toBe('GOOSE_MODEL: gpt-4o\n');
    });

    test('preserves existing configuration fields', async () => {
      await activate(extensionContextMock);
      const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];

      const configFile = createConfigFile('GOOSE_PROVIDER: openai\nGOOSE_MODEL: old-model\n');
      await agent.preWorkspaceStart(createContext([configFile], 'claude-sonnet'));

      const written = configFile.updateMock.mock.calls[0]![0] as string;
      expect(written).toContain('GOOSE_PROVIDER: openai');
      expect(written).toContain('GOOSE_MODEL: claude-sonnet');
      expect(written).not.toContain('old-model');
    });

    test('handles empty config file', async () => {
      await activate(extensionContextMock);
      const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];

      const configFile = createConfigFile('');
      await agent.preWorkspaceStart(createContext([configFile], 'gemini-2.5-pro'));

      expect(configFile.updateMock.mock.calls[0]![0]).toBe('GOOSE_MODEL: gemini-2.5-pro\n');
    });

    test('does nothing when config file is not in context', async () => {
      await activate(extensionContextMock);
      const agent = vi.mocked(agents.registerAgent).mock.calls[0]![0];

      const updateMock = vi.fn();
      const otherFile: AgentConfigurationFile = {
        path: 'some/other/path.yaml',
        read: vi.fn(),
        update: updateMock,
      };

      await agent.preWorkspaceStart(createContext([otherFile]));

      expect(updateMock).not.toHaveBeenCalled();
    });
  });
});
