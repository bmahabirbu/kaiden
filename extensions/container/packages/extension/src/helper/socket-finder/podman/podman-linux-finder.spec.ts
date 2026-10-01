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

import type { PathLike } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { window } from '@openkaiden/api';
import { Container } from 'inversify';
import { beforeEach, expect, test, vi } from 'vitest';

import { PodmanSocketLinuxFinder } from './podman-linux-finder';
import { PodmanVersionDetector } from './podman-version-detector';

vi.mock(import('node:fs'));
vi.mock(import('@openkaiden/api'));

const ROOTLESS_SOCKET = resolve('/run/user/1000', 'podman/podman.sock');
const ROOTFUL_SOCKET = '/run/podman/podman.sock';

const versionDetectorMock = {
  isInstalled: vi.fn(),
} as unknown as PodmanVersionDetector;

let finder: PodmanSocketLinuxFinder;

beforeEach(async () => {
  vi.resetAllMocks();
  process.env.XDG_RUNTIME_DIR = '/run/user/1000';
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);
  vi.mocked(versionDetectorMock.isInstalled).mockResolvedValue(true);

  const container = new Container();
  container.bind(PodmanSocketLinuxFinder).toSelf().inSingletonScope();
  container.bind(PodmanVersionDetector).toConstantValue(versionDetectorMock);
  finder = await container.getAsync(PodmanSocketLinuxFinder);
});

test('findPaths returns the rootless socket when it exists', async () => {
  vi.mocked(existsSync).mockImplementation((path: PathLike) => String(path) === ROOTLESS_SOCKET);

  expect(await finder.findPaths()).toEqual([ROOTLESS_SOCKET]);
  expect(window.showWarningMessage).not.toHaveBeenCalled();
});

test('findPaths returns the rootful socket when only it exists', async () => {
  delete process.env.XDG_RUNTIME_DIR;
  vi.mocked(existsSync).mockImplementation((path: PathLike) => String(path) === ROOTFUL_SOCKET);

  expect(await finder.findPaths()).toEqual([ROOTFUL_SOCKET]);
  expect(window.showWarningMessage).not.toHaveBeenCalled();
});

test('findPaths returns both sockets when both exist', async () => {
  vi.mocked(existsSync).mockReturnValue(true);

  expect(await finder.findPaths()).toEqual([ROOTLESS_SOCKET, ROOTFUL_SOCKET]);
  expect(window.showWarningMessage).not.toHaveBeenCalled();
});

test('findPaths falls back to /run/user/$UID when XDG_RUNTIME_DIR is unset', async () => {
  // Windows has no process.getuid to spy on, so provide it through a scoped process stub.
  vi.stubGlobal('process', {
    ...process,
    env: { ...process.env, XDG_RUNTIME_DIR: undefined },
    getuid: () => 1000,
  });
  vi.mocked(existsSync).mockImplementation((path: PathLike) => String(path) === ROOTLESS_SOCKET);

  try {
    expect(await finder.findPaths()).toEqual([ROOTLESS_SOCKET]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('findPaths warns once when podman is installed but no socket is found', async () => {
  await finder.findPaths();
  await finder.findPaths();

  expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  expect(window.showWarningMessage).toHaveBeenCalledWith(
    expect.stringContaining('systemctl --user enable --now podman.socket'),
  );
  expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(ROOTLESS_SOCKET));
});

test('findPaths warns only once for overlapping calls while the install check is pending', async () => {
  // Overlapping discovery polls must not both pass the warn guard while isInstalled() is pending.
  const pendingInstall = Promise.withResolvers<boolean>();
  vi.mocked(versionDetectorMock.isInstalled).mockReturnValue(pendingInstall.promise);

  const first = finder.findPaths();
  const second = finder.findPaths();
  pendingInstall.resolve(true);
  await Promise.all([first, second]);

  expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
});

test('findPaths does not warn when podman is not installed', async () => {
  vi.mocked(versionDetectorMock.isInstalled).mockResolvedValue(false);

  expect(await finder.findPaths()).toEqual([]);
  expect(window.showWarningMessage).not.toHaveBeenCalled();
});

test('findPaths warns again after the socket disappears', async () => {
  // Socket missing -> warn.
  await finder.findPaths();
  // Socket back -> re-arm the warning.
  vi.mocked(existsSync).mockReturnValue(true);
  await finder.findPaths();
  // Socket missing again -> warn a second time.
  vi.mocked(existsSync).mockReturnValue(false);
  await finder.findPaths();

  expect(window.showWarningMessage).toHaveBeenCalledTimes(2);
});
