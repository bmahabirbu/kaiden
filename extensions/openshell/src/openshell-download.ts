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

import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';

import * as tar from 'tar';

import { sha256 } from './sha256';

const OPENSHELL_REPO = 'NVIDIA/OpenShell';

export interface ReleaseInfo {
  version: string;
  digests: Map<string, string>;
}

interface AssetSpec {
  component: string;
  assetName: string;
  binaryName: string;
  subdir?: string;
}

const ASSET_MAP: Record<string, AssetSpec[]> = {
  'darwin-arm64': [
    { component: 'openshell', assetName: 'openshell-aarch64-apple-darwin.tar.gz', binaryName: 'openshell' },
    {
      component: 'openshell-gateway',
      assetName: 'openshell-gateway-aarch64-apple-darwin.tar.gz',
      binaryName: 'openshell-gateway',
    },
    {
      component: 'openshell-driver-vm',
      assetName: 'openshell-driver-vm-aarch64-apple-darwin.tar.gz',
      binaryName: 'openshell-driver-vm',
    },
  ],
  'linux-x64': [
    { component: 'openshell', assetName: 'openshell-x86_64-unknown-linux-musl.tar.gz', binaryName: 'openshell' },
    {
      component: 'openshell-gateway',
      assetName: 'openshell-gateway-x86_64-unknown-linux-gnu.tar.gz',
      binaryName: 'openshell-gateway',
    },
    {
      component: 'openshell-sandbox',
      assetName: 'openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz',
      binaryName: 'openshell-sandbox',
    },
    {
      component: 'openshell-driver-vm',
      assetName: 'openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz',
      binaryName: 'openshell-driver-vm',
    },
  ],
  'linux-arm64': [
    { component: 'openshell', assetName: 'openshell-aarch64-unknown-linux-musl.tar.gz', binaryName: 'openshell' },
    {
      component: 'openshell-gateway',
      assetName: 'openshell-gateway-aarch64-unknown-linux-gnu.tar.gz',
      binaryName: 'openshell-gateway',
    },
    {
      component: 'openshell-sandbox',
      assetName: 'openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz',
      binaryName: 'openshell-sandbox',
    },
    {
      component: 'openshell-driver-vm',
      assetName: 'openshell-driver-vm-aarch64-unknown-linux-gnu.tar.gz',
      binaryName: 'openshell-driver-vm',
    },
  ],
};

export async function getRelease(version: string): Promise<ReleaseInfo> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`https://api.github.com/repos/${OPENSHELL_REPO}/releases/tags/v${version}`, {
    headers,
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`failed to fetch OpenShell release v${version}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { tag_name: string; assets: { name: string; digest: string | null }[] };
  const resolvedVersion = data.tag_name.replace(/^v/, '');
  const digests = new Map<string, string>();
  for (const asset of data.assets) {
    if (asset.digest) {
      digests.set(asset.name, asset.digest.replace(/^sha256:/, ''));
    }
  }
  return { version: resolvedVersion, digests };
}

export async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  await pipeline(res.body, createWriteStream(dest));
}

export async function verifyChecksum(
  digests: Map<string, string>,
  assetFileName: string,
  filePath: string,
): Promise<void> {
  const expected = digests.get(assetFileName);
  if (!expected) {
    throw new Error(`no digest found for ${assetFileName} in release assets`);
  }

  const actual = await sha256(filePath);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${assetFileName}: expected ${expected}, got ${actual}`);
  }
  console.log(`checksum verified for ${assetFileName}`);
}

function isSafePath(entryName: string): boolean {
  const normalized = normalize(entryName.replace(/\\/g, '/'));
  return !normalized.startsWith('..') && !normalized.startsWith('/');
}

export async function extract(archive: string, outDir: string): Promise<void> {
  await tar.extract({
    file: archive,
    cwd: outDir,
    filter: (path: string) => isSafePath(path),
  });
}

export async function downloadOpenshellBinaries(
  version: string,
  platform: string,
  arch: string,
  outputDir: string,
  digests: Map<string, string>,
): Promise<void> {
  const key = `${platform}-${arch}`;
  const assets = ASSET_MAP[key];
  if (!assets) {
    throw new Error(`unsupported target: ${key}. Supported: ${Object.keys(ASSET_MAP).join(', ')}`);
  }

  const versionFile = join(outputDir, '.openshell-version');
  const versionMarker = `${version}-${platform}-${arch}`;

  if (existsSync(versionFile)) {
    const existing = await readFile(versionFile, { encoding: 'utf-8' });
    if (existing.trim() === versionMarker) {
      const allPresent = assets.every(a => {
        const dir = a.subdir ? join(outputDir, a.subdir) : outputDir;
        return existsSync(join(dir, a.binaryName));
      });
      if (allPresent) {
        console.log(`openshell ${version} for ${platform}/${arch} already downloaded`);
        return;
      }
    }
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  for (const asset of assets) {
    const extractDir = asset.subdir ? join(outputDir, asset.subdir) : outputDir;
    await mkdir(extractDir, { recursive: true });

    const url = `https://github.com/${OPENSHELL_REPO}/releases/download/v${version}/${asset.assetName}`;
    const archivePath = join(extractDir, asset.assetName);

    console.log(`downloading ${asset.component} ${version} for ${platform}/${arch}...`);
    await download(url, archivePath);
    await verifyChecksum(digests, asset.assetName, archivePath);

    console.log(`extracting ${asset.component}...`);
    await extract(archivePath, extractDir);
    await rm(archivePath);

    const binaryPath = join(extractDir, asset.binaryName);
    if (!existsSync(binaryPath)) {
      throw new Error(`expected extracted binary at ${binaryPath}`);
    }
    await chmod(binaryPath, 0o755);
  }

  await writeFile(versionFile, versionMarker, { encoding: 'utf-8' });
  console.log(`openshell ${version} for ${platform}/${arch} ready`);
}
