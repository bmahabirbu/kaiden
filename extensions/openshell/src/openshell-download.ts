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
import { isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs as nodeParseArgs } from 'node:util';

const OPENSHELL_REPO = 'NVIDIA/OpenShell';
const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${OPENSHELL_REPO}/main/install.sh`;

export async function getLatestVersion(): Promise<string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  const token = process.env['GITHUB_TOKEN'];
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`https://api.github.com/repos/${OPENSHELL_REPO}/releases/latest`, {
    headers,
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`failed to fetch latest OpenShell release: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { tag_name: string };
  return data.tag_name.replace(/^v/, '');
}

export async function downloadInstallScript(outputDir: string): Promise<void> {
  const version = await getLatestVersion();
  const versionFile = join(outputDir, '.openshell-version');
  const scriptPath = join(outputDir, 'install.sh');

  if (existsSync(versionFile) && existsSync(scriptPath)) {
    const existing = await readFile(versionFile, { encoding: 'utf-8' });
    if (existing.trim() === version) {
      console.log(`OpenShell install.sh (version ${version}) already downloaded`);
      return;
    }
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  console.log(`downloading OpenShell install.sh (latest: ${version})...`);
  const res = await fetch(INSTALL_SCRIPT_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`failed to download install.sh: ${res.status} ${res.statusText}`);
  }
  await pipeline(res.body, createWriteStream(scriptPath));
  await chmod(scriptPath, 0o755);

  await writeFile(versionFile, version, { encoding: 'utf-8' });
  console.log(`OpenShell install.sh (version ${version}) ready at ${scriptPath}`);
}

function parseArgs(args: string[]): { output: string } {
  const { values } = nodeParseArgs({
    args,
    options: {
      output: { type: 'string' },
    },
    strict: true,
  });

  if (!values.output || !isAbsolute(values.output)) throw new Error('--output must be an absolute path');

  return { output: values.output };
}

if (!process.env['VITEST']) {
  const { output } = parseArgs(process.argv.slice(2));
  downloadInstallScript(output).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
