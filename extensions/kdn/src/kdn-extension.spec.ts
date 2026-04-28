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

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CancellationToken, ExtensionContext, Progress } from '@openkaiden/api';
import * as extensionApi from '@openkaiden/api';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { downloadKdn, getLatestVersion } from './kdn-download';
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

function mockConfiguration(customPath: string | undefined): void {
  vi.mocked(extensionApi.configuration.getConfiguration).mockReturnValue({
    get: vi.fn().mockReturnValue(customPath),
    has: vi.fn(),
    update: vi.fn(),
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();

  Object.defineProperty(process, 'resourcesPath', {
    value: '/resources',
    writable: true,
    configurable: true,
  });

  extensionContext = {
    storagePath: '/storage',
    subscriptions: [],
  } as unknown as ExtensionContext;

  kdnExtension = new KdnExtension(extensionContext);

  mockConfiguration(undefined);
  vi.mocked(extensionApi.configuration.onDidChangeConfiguration).mockReturnValue({ dispose: vi.fn() } as never);

  vi.mocked(getLatestVersion).mockResolvedValue('0.5.0');

  vi.mocked(extensionApi.window.withProgress).mockImplementation(async (_options, task) => {
    const progress = { report: vi.fn() } as unknown as Progress<{ message?: string; increment?: number }>;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(),
    } as unknown as CancellationToken;
    return task(progress, token);
  });
});

test('registers from extension storage when binary exists without downloading', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: '',
    stderr: 'kdn version 0.5.0',
  });
  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue({ dispose: vi.fn() } as never);

  await kdnExtension.activate();

  expect(getLatestVersion).not.toHaveBeenCalled();
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
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: '',
    stderr: 'kdn version 1.0.0',
  });
  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue({ dispose: vi.fn() } as never);

  await kdnExtension.activate();

  expect(downloadKdn).not.toHaveBeenCalled();
  expect(extensionApi.cli.createCliTool).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'kdn',
      version: '1.0.0',
      path: 'kdn',
      installationSource: 'external',
    }),
  );
});

test('falls back to bundled resources before attempting download', async () => {
  vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValueOnce(true);
  vi.mocked(extensionApi.process.exec)
    .mockRejectedValueOnce(new Error('not found'))
    .mockResolvedValueOnce({ command: 'kdn', stdout: '', stderr: 'kdn version 0.4.0' });
  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue({ dispose: vi.fn() } as never);

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

test('downloads binary in background when not found locally', async () => {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(extensionApi.process.exec)
    .mockRejectedValueOnce(new Error('not found'))
    .mockResolvedValueOnce({ command: 'kdn', stdout: '', stderr: 'kdn version 0.5.0' });
  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue({ dispose: vi.fn() } as never);

  await kdnExtension.activate();
  await vi.waitFor(() => expect(extensionApi.cli.createCliTool).toHaveBeenCalled());

  expect(extensionApi.window.withProgress).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Downloading kdn CLI' }),
    expect.any(Function),
  );
  expect(getLatestVersion).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(downloadKdn).toHaveBeenCalledWith(
    '0.5.0',
    process.platform,
    expect.any(String),
    join('/storage', 'bin'),
    expect.any(AbortSignal),
  );
  expect(extensionApi.cli.createCliTool).toHaveBeenCalledWith(
    expect.objectContaining({
      version: '0.5.0',
      path: join('/storage', 'bin', 'kdn'),
      installationSource: 'extension',
    }),
  );
});

test('download failure does not reject activate', async () => {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(extensionApi.process.exec).mockRejectedValue(new Error('not found'));
  vi.mocked(extensionApi.window.withProgress).mockRejectedValue(new Error('network error'));

  await expect(kdnExtension.activate()).resolves.toBeUndefined();
  await vi.waitFor(() => expect(extensionApi.window.withProgress).toHaveBeenCalled());
  expect(extensionApi.cli.createCliTool).not.toHaveBeenCalled();
});

test('deactivate aborts in-flight download and skips registration', async () => {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(extensionApi.process.exec).mockRejectedValue(new Error('not found'));
  vi.mocked(downloadKdn).mockImplementation(async () => {
    await kdnExtension.deactivate();
  });

  await kdnExtension.activate();
  await vi.waitFor(() => expect(downloadKdn).toHaveBeenCalled());

  expect(extensionApi.cli.createCliTool).not.toHaveBeenCalled();
});

test('pushes cli tool to subscriptions for cleanup', async () => {
  const disposable = { dispose: vi.fn() };
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: 'kdn version 0.5.0',
    stderr: '',
  });
  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue(disposable as never);

  await kdnExtension.activate();

  expect(extensionContext.subscriptions).toContain(disposable);
});

test('uses custom binary path when kdn.binary.path is set', async () => {
  mockConfiguration('/custom/path/kdn');
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: 'kdn version 2.0.0',
    stderr: '',
  });
  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue({ dispose: vi.fn() } as never);

  await kdnExtension.activate();

  expect(extensionApi.cli.createCliTool).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'kdn',
      version: '2.0.0',
      path: '/custom/path/kdn',
      installationSource: 'external',
    }),
  );
  expect(existsSync).not.toHaveBeenCalled();
});

test('falls back to normal discovery when custom path is empty', async () => {
  mockConfiguration('');
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: '',
    stderr: 'kdn version 0.5.0',
  });
  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue({ dispose: vi.fn() } as never);

  await kdnExtension.activate();

  expect(extensionApi.cli.createCliTool).toHaveBeenCalledWith(
    expect.objectContaining({
      path: join('/storage', 'bin', 'kdn'),
      installationSource: 'extension',
    }),
  );
});

test('falls back to normal discovery when custom path binary is invalid', async () => {
  mockConfiguration('/bad/path/kdn');
  vi.mocked(extensionApi.process.exec).mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce({
    command: 'kdn',
    stdout: '',
    stderr: 'kdn version 1.0.0',
  });
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue({ dispose: vi.fn() } as never);

  await kdnExtension.activate();

  expect(extensionApi.cli.createCliTool).toHaveBeenCalledWith(
    expect.objectContaining({
      path: 'kdn',
      version: '1.0.0',
      installationSource: 'external',
    }),
  );
});

test('registers configuration change listener', async () => {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: 'kdn version 0.5.0',
    stderr: '',
  });
  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue({ dispose: vi.fn() } as never);

  await kdnExtension.activate();

  expect(extensionApi.configuration.onDidChangeConfiguration).toHaveBeenCalled();
});

test('configuration change updates cli tool with new path', async () => {
  const updateVersion = vi.fn();
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: 'kdn version 0.5.0',
    stderr: '',
  });
  vi.mocked(extensionApi.cli.createCliTool).mockReturnValue({ dispose: vi.fn(), updateVersion } as never);

  let configChangeCallback: (e: { affectsConfiguration: (section: string) => boolean }) => void = () => {};
  vi.mocked(extensionApi.configuration.onDidChangeConfiguration).mockImplementation((cb: unknown) => {
    configChangeCallback = cb as typeof configChangeCallback;
    return { dispose: vi.fn() } as never;
  });

  await kdnExtension.activate();

  mockConfiguration('/new/path/kdn');
  vi.mocked(extensionApi.process.exec).mockResolvedValue({
    command: 'kdn',
    stdout: 'kdn version 3.0.0',
    stderr: '',
  });

  configChangeCallback({ affectsConfiguration: (s: string) => s === 'kdn.binary.path' });

  await vi.waitFor(() => {
    expect(updateVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '3.0.0',
        path: '/new/path/kdn',
      }),
    );
  });
});
