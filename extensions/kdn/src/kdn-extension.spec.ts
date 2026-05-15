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
 **********************************************************************/

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionContext } from '@openkaiden/api';
import * as extensionApi from '@openkaiden/api';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { downloadKdn, getAvailableVersions, getReleaseByTag } from './kdn-download';
import { KdnExtension } from './kdn-extension';

vi.mock(import('node:fs'));
vi.mock(import('./kdn-download'));

let extensionContext: ExtensionContext;
let kdnExtension: KdnExtension;
let originalResourcesPathDescriptor: PropertyDescriptor | undefined;

beforeAll(() => {
  originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
});

afterAll(() => {
  if (originalResourcesPathDescriptor) {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPathDescriptor);
  } else {
    delete (process as unknown as Record<string, unknown>).resourcesPath;
  }
});

beforeEach(() => {
  vi.resetAllMocks();

  Object.defineProperty(process, 'resourcesPath', {
    value: '/resources',
    writable: true,
    configurable: true,
  });

  vi.mocked(extensionApi.configuration.getConfiguration).mockReturnValue({
    get: vi.fn().mockReturnValue(''),
  } as unknown as ReturnType<typeof extensionApi.configuration.getConfiguration>);

  extensionContext = {
    storagePath: '/storage',
    subscriptions: [],
  } as unknown as ExtensionContext;

  kdnExtension = new KdnExtension(extensionContext);

  vi.mocked(getReleaseByTag).mockResolvedValue({ version: '0.6.0', digests: new Map() });

  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue({
    dispose: vi.fn(),
    registerUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    updateVersion: vi.fn(),
  } as never);
});

test('registers from custom binary path setting when configured', async () => {
  vi.mocked(extensionApi.configuration.getConfiguration).mockReturnValue({
    get: vi.fn().mockReturnValue('/custom/path/kdn'),
  } as unknown as ReturnType<typeof extensionApi.configuration.getConfiguration>);
  vi.mocked(existsSync).mockImplementation(p => String(p) === '/custom/path/kdn');
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: '',
    stderr: 'kdn version 2.0.0',
  });

  await kdnExtension.activate();

  expect(extensionApi.cli.createCliTool).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'kdn',
      version: '2.0.0',
      path: '/custom/path/kdn',
      installationSource: 'external',
    }),
  );
});

test('falls through when custom binary path is configured but file does not exist', async () => {
  vi.mocked(extensionApi.configuration.getConfiguration).mockReturnValue({
    get: vi.fn().mockReturnValue('/nonexistent/kdn'),
  } as unknown as ReturnType<typeof extensionApi.configuration.getConfiguration>);
  vi.mocked(existsSync).mockImplementation(p => String(p) === join('/storage', 'bin', 'kdn'));
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: '',
    stderr: 'kdn version 0.5.0',
  });

  await kdnExtension.activate();

  expect(extensionApi.cli.createCliTool).toHaveBeenCalledWith(
    expect.objectContaining({
      path: join('/storage', 'bin', 'kdn'),
      installationSource: 'extension',
    }),
  );
});

test('registers from extension storage when binary exists', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: '',
    stderr: 'kdn version 0.5.0',
  });

  await kdnExtension.activate();

  expect(downloadKdn).not.toHaveBeenCalled();
  expect(extensionApi.cli.createCliTool).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'kdn',
      version: '0.5.0',
      path: join('/storage', 'bin', 'kdn'),
      installationSource: 'extension',
    }),
  );
});

test('falls back to system PATH before attempting download', async () => {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(extensionApi.process.exec)
    .mockResolvedValueOnce({
      command: 'kdn',
      stdout: '',
      stderr: 'kdn version 1.0.0',
    })
    .mockResolvedValueOnce({
      command: 'which',
      stdout: '/usr/local/bin/kdn\n',
      stderr: '',
    });

  await kdnExtension.activate();

  expect(downloadKdn).not.toHaveBeenCalled();
  expect(extensionApi.cli.createCliTool).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'kdn',
      version: '1.0.0',
      path: '/usr/local/bin/kdn',
      installationSource: 'external',
    }),
  );
});

test('falls back to bundled resources before attempting download', async () => {
  vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValueOnce(true);
  vi.mocked(extensionApi.process.exec)
    .mockRejectedValueOnce(new Error('not found'))
    .mockResolvedValueOnce({ command: 'kdn', stdout: '', stderr: 'kdn version 0.4.0' });

  await kdnExtension.activate();

  expect(downloadKdn).not.toHaveBeenCalled();
  expect(extensionApi.cli.createCliTool).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'kdn',
      version: '0.4.0',
      path: join('/resources', 'kdn', 'kdn'),
      installationSource: 'extension',
    }),
  );
});

test('throws when not found anywhere', async () => {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(extensionApi.process.exec).mockRejectedValue(new Error('not found'));

  await expect(kdnExtension.activate()).rejects.toThrow(
    'kdn CLI not found in custom path, extension storage, PATH, or bundled resources',
  );
  expect(extensionApi.cli.createCliTool).not.toHaveBeenCalled();
});

test('pushes cli tool to subscriptions for cleanup', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: 'kdn version 0.5.0',
    stderr: '',
  });

  await kdnExtension.activate();

  expect(extensionContext.subscriptions.length).toBeGreaterThanOrEqual(1);
});

test('registers updater when installationSource is extension', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: '',
    stderr: 'kdn version 0.5.0',
  });

  await kdnExtension.activate();

  const cliTool = vi.mocked(extensionApi.cli.createCliTool).mock.results[0]?.value;
  expect(cliTool.registerUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      selectVersion: expect.any(Function),
      doUpdate: expect.any(Function),
    }),
  );
});

test('does not register updater when installationSource is external', async () => {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(extensionApi.process.exec)
    .mockResolvedValueOnce({
      command: 'kdn',
      stdout: '',
      stderr: 'kdn version 1.0.0',
    })
    .mockResolvedValueOnce({
      command: 'which',
      stdout: '/usr/local/bin/kdn\n',
      stderr: '',
    });

  await kdnExtension.activate();

  const cliTool = vi.mocked(extensionApi.cli.createCliTool).mock.results[0]?.value;
  expect(cliTool.registerUpdate).not.toHaveBeenCalled();
});

test('doUpdate downloads selected version and updates cli tool', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: '',
    stderr: 'kdn version 0.5.0',
  });
  vi.mocked(getAvailableVersions).mockResolvedValue([
    { label: 'kdn v0.6.0', tag: '0.6.0' },
    { label: 'kdn v0.4.0', tag: '0.4.0' },
  ]);
  vi.mocked(extensionApi.window.showQuickPick).mockResolvedValue({ label: 'kdn v0.6.0', tag: '0.6.0' } as never);

  await kdnExtension.activate();

  const cliTool = vi.mocked(extensionApi.cli.createCliTool).mock.results[0]?.value;
  const updater = vi.mocked(cliTool.registerUpdate).mock.calls[0]?.[0];

  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: '',
    stderr: 'kdn version 0.6.0',
  });

  await updater.selectVersion();
  await updater.doUpdate();

  expect(getReleaseByTag).toHaveBeenCalledWith('0.6.0');
  expect(downloadKdn).toHaveBeenCalledWith(
    '0.6.0',
    process.platform,
    expect.any(String),
    join('/storage', 'bin'),
    expect.any(Map),
  );
  expect(cliTool.updateVersion).toHaveBeenCalledWith(
    expect.objectContaining({
      version: '0.6.0',
      path: join('/storage', 'bin', 'kdn'),
    }),
  );
});
