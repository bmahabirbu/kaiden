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

import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';

import * as tar from 'tar';

import { sha256 } from './sha256';

const OPENSHELL_REPO = 'NVIDIA/OpenShell';
const OPENSHELL_VERSION = '0.0.44';
const REQUEST_TIMEOUT_MS = 30_000;

interface ReleaseInfo {
  version: string;
  digests: Map<string, string>;
}

export async function getRelease(): Promise<ReleaseInfo> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`https://api.github.com/repos/${OPENSHELL_REPO}/releases/tags/v${OPENSHELL_VERSION}`, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`failed to fetch openshell release v${OPENSHELL_VERSION}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { tag_name: string; assets: { name: string; digest: string | null }[] };
  const version = data.tag_name.replace(/^v/, '');
  const digests = new Map<string, string>();
  for (const asset of data.assets) {
    if (asset.digest) {
      digests.set(asset.name, asset.digest.replace(/^sha256:/, ''));
    }
  }
  return { version, digests };
}

const PLATFORM_MAP: Record<string, string> = { darwin: 'apple-darwin', linux: 'unknown-linux-musl' };
const ARCH_MAP: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new Error(`failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  await pipeline(res.body, createWriteStream(dest));
}

async function verifyChecksum(digests: Map<string, string>, assetFileName: string, filePath: string): Promise<void> {
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
  if (isAbsolute(entryName)) {
    return false;
  }
  const normalized = normalize(entryName.replace(/\\/g, '/'));
  return !normalized.startsWith('..') && !isAbsolute(normalized);
}

async function extract(archive: string, outDir: string): Promise<void> {
  await tar.extract({
    file: archive,
    cwd: outDir,
    filter: (path: string) => isSafePath(path),
  });
}

export async function downloadOpenshell(
  version: string,
  platform: string,
  arch: string,
  outputDir: string,
  digests: Map<string, string>,
): Promise<void> {
  const versionFile = join(outputDir, '.openshell-version');
  const versionMarker = `${version}-${platform}-${arch}`;
  const binaryPath = join(outputDir, 'openshell');

  if (existsSync(versionFile) && existsSync(binaryPath)) {
    const existing = await readFile(versionFile, { encoding: 'utf-8' });
    if (existing.trim() === versionMarker) {
      console.log(`openshell ${version} for ${platform}/${arch} already downloaded`);
      return;
    }
  }

  const osPlatform = PLATFORM_MAP[platform];
  const osArch = ARCH_MAP[arch];
  if (!osPlatform) throw new Error(`unsupported platform: ${platform}`);
  if (!osArch) throw new Error(`unsupported arch: ${arch}`);

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const assetFileName = `openshell-${osArch}-${osPlatform}.tar.gz`;
  const url = `https://github.com/${OPENSHELL_REPO}/releases/download/v${version}/${assetFileName}`;
  const archivePath = join(outputDir, assetFileName);

  console.log(`downloading openshell ${version} for ${platform}/${arch}...`);
  await download(url, archivePath);
  await verifyChecksum(digests, assetFileName, archivePath);

  console.log(`extracting to ${outputDir}...`);
  await extract(archivePath, outputDir);
  await rm(archivePath);

  if (!existsSync(binaryPath)) {
    throw new Error(`expected extracted binary at ${binaryPath}`);
  }

  await chmod(binaryPath, 0o755);

  await writeFile(versionFile, versionMarker, { encoding: 'utf-8' });
  console.log(`openshell ${version} for ${platform}/${arch} ready`);
}
