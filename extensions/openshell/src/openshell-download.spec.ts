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
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { downloadOpenshellBinaries, getRelease } from './openshell-download';
import { sha256 } from './sha256';

vi.mock(import('node:fs'));
vi.mock(import('node:fs/promises'));
vi.mock(import('node:stream/promises'));
vi.mock(import('tar'));
vi.mock(import('./sha256'));

let fileMap: Map<string, boolean>;

function normPath(p: string): string {
  return path.posix.normalize(String(p).replace(/\\/g, '/'));
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        body: new PassThrough(),
      }),
    ),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  fileMap = new Map();
  vi.mocked(existsSync).mockImplementation(p => fileMap.get(normPath(String(p))) ?? false);
  vi.mocked(sha256).mockResolvedValue('abc123');
  vi.mocked(writeFile).mockImplementation(async (p: Parameters<typeof writeFile>[0]) => {
    fileMap.set(normPath(String(p)), true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downloadOpenshellBinaries', () => {
  test('skips download when cached', async () => {
    fileMap.set('/output/.openshell-version', true);
    fileMap.set('/output/openshell', true);
    fileMap.set('/output/openshell-gateway', true);
    fileMap.set('/output/openshell-sandbox', true);
    fileMap.set('/output/openshell-driver-vm', true);
    vi.mocked(readFile).mockResolvedValue('0.0.55-linux-x64');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('fetch should not be called when cached');
      }),
    );

    await downloadOpenshellBinaries('0.0.55', 'linux', 'x64', '/output', new Map());
  });

  test('re-downloads when binary is missing but version marker exists', async () => {
    fileMap.set('/output/.openshell-version', true);
    fileMap.set('/output/openshell', false);
    vi.mocked(readFile).mockResolvedValue('0.0.55-linux-x64');
    stubFetch();
    const digests = new Map([
      ['openshell-x86_64-unknown-linux-musl.tar.gz', 'abc123'],
      ['openshell-gateway-x86_64-unknown-linux-gnu.tar.gz', 'abc123'],
      ['openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz', 'abc123'],
      ['openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz', 'abc123'],
    ]);

    vi.mocked(tar.extract).mockImplementation(async (opts: { cwd?: string }) => {
      const cwd = opts.cwd ?? '';
      fileMap.set(normPath(path.join(cwd, 'openshell')), true);
      fileMap.set(normPath(path.join(cwd, 'openshell-gateway')), true);
      fileMap.set(normPath(path.join(cwd, 'openshell-sandbox')), true);
      fileMap.set(normPath(path.join(cwd, 'openshell-driver-vm')), true);
    });

    await downloadOpenshellBinaries('0.0.55', 'linux', 'x64', '/output', digests);

    expect(vi.mocked(tar.extract)).toHaveBeenCalled();
  });

  test('extracts tar.gz and writes version marker', async () => {
    stubFetch();
    const digests = new Map([
      ['openshell-x86_64-unknown-linux-musl.tar.gz', 'abc123'],
      ['openshell-gateway-x86_64-unknown-linux-gnu.tar.gz', 'abc123'],
      ['openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz', 'abc123'],
      ['openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz', 'abc123'],
    ]);

    vi.mocked(tar.extract).mockImplementation(async (opts: { cwd?: string }) => {
      const cwd = opts.cwd ?? '';
      fileMap.set(normPath(path.join(cwd, 'openshell')), true);
      fileMap.set(normPath(path.join(cwd, 'openshell-gateway')), true);
      fileMap.set(normPath(path.join(cwd, 'openshell-driver-vm')), true);
    });

    await downloadOpenshellBinaries('0.0.55', 'linux', 'x64', '/output', digests);

    expect(vi.mocked(tar.extract)).toHaveBeenCalledTimes(3);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('.openshell-version'),
      '0.0.55-linux-x64',
      expect.any(Object),
    );
    expect(chmod).toHaveBeenCalledTimes(3);
  });

  test('throws on checksum mismatch', async () => {
    stubFetch();
    const digests = new Map([['openshell-x86_64-unknown-linux-musl.tar.gz', 'wrongchecksum']]);

    await expect(downloadOpenshellBinaries('0.0.55', 'linux', 'x64', '/output', digests)).rejects.toThrow(
      'checksum mismatch',
    );
  });

  test('throws on unsupported target', async () => {
    await expect(downloadOpenshellBinaries('0.0.55', 'win32', 'x64', '/output', new Map())).rejects.toThrow(
      'unsupported target',
    );
  });

  test('handles darwin-arm64', async () => {
    stubFetch();
    const digests = new Map([
      ['openshell-aarch64-apple-darwin.tar.gz', 'abc123'],
      ['openshell-gateway-aarch64-apple-darwin.tar.gz', 'abc123'],
      ['openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz', 'abc123'],
      ['openshell-driver-vm-aarch64-apple-darwin.tar.gz', 'abc123'],
    ]);

    vi.mocked(tar.extract).mockImplementation(async (opts: { cwd?: string }) => {
      const cwd = opts.cwd ?? '';
      fileMap.set(normPath(path.join(cwd, 'openshell')), true);
      fileMap.set(normPath(path.join(cwd, 'openshell-gateway')), true);
      fileMap.set(normPath(path.join(cwd, 'openshell-driver-vm')), true);
    });

    await downloadOpenshellBinaries('0.0.55', 'darwin', 'arm64', '/output', digests);

    expect(mkdir).toHaveBeenCalledWith('/output', { recursive: true });
  });
});

describe('getRelease', () => {
  test('strips v prefix and builds digest map', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          tag_name: 'v0.0.55',
          assets: [
            { name: 'openshell-x86_64-unknown-linux-musl.tar.gz', digest: 'sha256:abc123' },
            { name: 'openshell-gateway-x86_64-unknown-linux-gnu.tar.gz', digest: 'sha256:def456' },
            { name: 'no-digest-asset.txt', digest: null },
          ],
        }),
      }),
    );

    const release = await getRelease('0.0.55');

    expect(release.version).toBe('0.0.55');
    expect(release.digests.get('openshell-x86_64-unknown-linux-musl.tar.gz')).toBe('abc123');
    expect(release.digests.get('openshell-gateway-x86_64-unknown-linux-gnu.tar.gz')).toBe('def456');
    expect(release.digests.has('no-digest-asset.txt')).toBe(false);
  });

  test('throws on fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      }),
    );

    await expect(getRelease('0.0.99')).rejects.toThrow('failed to fetch OpenShell release v0.0.99');
  });
});
