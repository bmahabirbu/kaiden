/*********************************************************************
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
 ********************************************************************/

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { downloadKdn, getAvailableVersions, getLatestRelease } from './kdn-download';
import { sha256 } from './sha256';

const getEntriesMock = vi.fn();

vi.mock(import('node:fs'));
vi.mock(import('node:fs/promises'));
vi.mock(import('node:stream/promises'));
vi.mock('adm-zip', () => ({
  default: class {
    getEntries = getEntriesMock;
  },
}));
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

describe('downloadKdn', () => {
  test('skips download when cached', async () => {
    fileMap.set('/output/.kdn-version', true);
    fileMap.set('/output/kdn', true);
    vi.mocked(readFile).mockResolvedValue('0.5.0-linux-x64');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('fetch should not be called when cached');
      }),
    );

    await downloadKdn('0.5.0', 'linux', 'x64', '/output', new Map());
  });

  test('re-downloads when binary is missing but version marker exists', async () => {
    fileMap.set('/output/.kdn-version', true);
    fileMap.set('/output/kdn', false);
    vi.mocked(readFile).mockResolvedValue('0.5.0-linux-x64');
    stubFetch();
    const digests = new Map([['kdn_0.5.0_linux_amd64.tar.gz', 'abc123']]);

    vi.mocked(tar.extract).mockImplementation(async (opts: { cwd?: string }) => {
      fileMap.set(normPath(path.join(opts.cwd ?? '', 'kdn')), true);
    });

    await downloadKdn('0.5.0', 'linux', 'x64', '/output', digests);

    expect(vi.mocked(tar.extract)).toHaveBeenCalled();
  });

  test('extracts tar.gz and writes version marker (linux)', async () => {
    stubFetch();
    const digests = new Map([['kdn_0.5.0_linux_amd64.tar.gz', 'abc123']]);

    vi.mocked(tar.extract).mockImplementation(async (opts: { cwd?: string }) => {
      fileMap.set(normPath(path.join(opts.cwd ?? '', 'kdn')), true);
    });

    await downloadKdn('0.5.0', 'linux', 'x64', '/output', digests);

    expect(vi.mocked(tar.extract)).toHaveBeenCalledWith({
      file: expect.stringContaining('kdn_0.5.0_linux_amd64.tar.gz'),
      cwd: '/output',
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('.kdn-version'),
      '0.5.0-linux-x64',
      expect.any(Object),
    );
    expect(chmod).toHaveBeenCalledWith(expect.stringMatching(/[/\\]output[/\\]kdn$/), 0o755);
  });

  test('extracts zip entries safely and writes version marker (win32)', async () => {
    stubFetch();
    const digests = new Map([['kdn_0.5.0_windows_amd64.zip', 'abc123']]);
    const fileData = Buffer.from('binary-content');
    getEntriesMock.mockReturnValue([{ entryName: 'kdn.exe', isDirectory: false, getData: (): Buffer => fileData }]);

    await downloadKdn('0.5.0', 'win32', 'x64', '/output', digests);

    expect(getEntriesMock).toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('output'), { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining('kdn.exe'), fileData);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('.kdn-version'),
      '0.5.0-win32-x64',
      expect.any(Object),
    );
  });

  test('throws on checksum mismatch', async () => {
    stubFetch();
    const digests = new Map([['kdn_0.5.0_linux_amd64.tar.gz', 'wrongchecksum']]);

    await expect(downloadKdn('0.5.0', 'linux', 'x64', '/output', digests)).rejects.toThrow('checksum mismatch');
  });

  test('rejects unsafe zip paths', async () => {
    stubFetch();
    const digests = new Map([['kdn_0.5.0_windows_amd64.zip', 'abc123']]);
    getEntriesMock.mockReturnValue([
      { entryName: '../evil.sh', isDirectory: false, getData: (): Buffer => Buffer.from('bad') },
    ]);

    await expect(downloadKdn('0.5.0', 'win32', 'x64', '/output', digests)).rejects.toThrow('unsafe path');
  });
});

describe('getLatestRelease', () => {
  test('strips v prefix and builds digest map', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => ({
          tag_name: 'v1.2.3',
          assets: [
            { name: 'kdn_1.2.3_linux_amd64.tar.gz', digest: 'sha256:abc123' },
            { name: 'kdn_1.2.3_darwin_arm64.tar.gz', digest: 'sha256:def456' },
            { name: 'no-digest-asset.txt', digest: null },
          ],
        }),
      }),
    );
    const release = await getLatestRelease();
    expect(release.version).toBe('1.2.3');
    expect(release.digests.get('kdn_1.2.3_linux_amd64.tar.gz')).toBe('abc123');
    expect(release.digests.get('kdn_1.2.3_darwin_arm64.tar.gz')).toBe('def456');
    expect(release.digests.has('no-digest-asset.txt')).toBe(false);
  });

  test('passes signal to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ tag_name: 'v1.0.0', assets: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await getLatestRelease(controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
  });
});

describe('downloadKdn signal', () => {
  test('passes signal through to fetch calls', async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve({ ok: true, body: new PassThrough() }));
    vi.stubGlobal('fetch', fetchMock);
    const digests = new Map([['kdn_0.5.0_linux_amd64.tar.gz', 'abc123']]);

    vi.mocked(tar.extract).mockImplementation(async (opts: { cwd?: string }) => {
      fileMap.set(normPath(path.join(opts.cwd ?? '', 'kdn')), true);
    });

    const controller = new AbortController();
    await downloadKdn('0.5.0', 'linux', 'x64', '/output', digests, controller.signal);

    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ signal: controller.signal }));
    }
  });
});

describe('getAvailableVersions', () => {
  test('filters by platform/arch asset and excludes prereleases and legacy names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => [
          {
            tag_name: 'v0.6.0',
            name: 'kdn v0.6.0',
            prerelease: false,
            assets: [{ name: 'kdn_0.6.0_linux_amd64.tar.gz' }],
          },
          {
            tag_name: 'v0.6.0-rc1',
            name: 'kdn v0.6.0-rc1',
            prerelease: true,
            assets: [{ name: 'kdn_0.6.0-rc1_linux_amd64.tar.gz' }],
          },
          {
            tag_name: 'v0.5.0',
            name: 'kdn v0.5.0',
            prerelease: false,
            assets: [{ name: 'kdn_0.5.0_linux_amd64.tar.gz' }],
          },
          {
            tag_name: 'v0.4.0',
            name: null,
            prerelease: false,
            assets: [{ name: 'kortex-cli_0.4.0_linux_amd64.tar.gz' }],
          },
        ],
      }),
    );

    const versions = await getAvailableVersions('linux', 'x64');

    expect(versions).toEqual([
      { label: 'kdn v0.6.0', tag: '0.6.0' },
      { label: 'kdn v0.5.0', tag: '0.5.0' },
    ]);
  });

  test('excludes releases missing the target platform archive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => [
          {
            tag_name: 'v0.6.0',
            name: 'kdn v0.6.0',
            prerelease: false,
            assets: [{ name: 'kdn_0.6.0_linux_amd64.tar.gz' }],
          },
        ],
      }),
    );

    const versions = await getAvailableVersions('win32', 'x64');

    expect(versions).toEqual([]);
  });

  test('limits to 5 versions', async () => {
    const releases = Array.from({ length: 10 }, (_, i) => ({
      tag_name: `v0.${10 - i}.0`,
      name: `kdn v0.${10 - i}.0`,
      prerelease: false,
      assets: [{ name: `kdn_0.${10 - i}.0_linux_amd64.tar.gz` }],
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => releases }));

    const versions = await getAvailableVersions('linux', 'x64');

    expect(versions).toHaveLength(5);
  });
});
