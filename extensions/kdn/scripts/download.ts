#!/usr/bin/env tsx
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

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { getLatestRelease, downloadKdn } from '../src/kdn-download';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, '..', 'assets');

const SUPPORTED_TARGETS: { platform: string; arch: string }[] = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'win32', arch: 'x64' },
  { platform: 'win32', arch: 'arm64' },
];

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    all: { type: 'boolean', default: false },
    platform: { type: 'string' },
    arch: { type: 'string' },
  },
  strict: true,
});

let targets: { platform: string; arch: string }[];

if (values.all) {
  targets = SUPPORTED_TARGETS;
} else if (values.platform && values.arch) {
  targets = [{ platform: values.platform, arch: values.arch }];
} else if (values.platform || values.arch) {
  console.error('--platform and --arch must be specified together');
  process.exit(1);
} else {
  targets = SUPPORTED_TARGETS.filter(t => t.platform === process.platform);
}

const { version, digests } = await getLatestRelease();
console.log(`kdn latest release: v${version}`);

for (const { platform, arch } of targets) {
  const outputDir = resolve(ASSETS_DIR, `${platform}-${arch}`);
  await downloadKdn(version, platform, arch, outputDir, digests);
}
