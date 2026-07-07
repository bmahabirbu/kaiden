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

const HOME_VARIABLE = '${HOME}';

export type OpenshellUpload = { local: string; remote: string };

export function buildOpenshellSkillUploads(
  skills: string[] | undefined,
  destinationSkillsFolder: string,
): OpenshellUpload[] {
  if (!skills?.length) {
    return [];
  }

  const remoteBase = resolveOpenshellSkillsDestination(destinationSkillsFolder);
  return skills.map(skillPath => ({
    local: skillPath,
    remote: remoteBase,
  }));
}

export function resolveOpenshellSkillsDestination(destinationSkillsFolder: string): string {
  if (destinationSkillsFolder === HOME_VARIABLE) {
    return '.';
  }

  for (const str of [`${HOME_VARIABLE}/`, '~/']) {
    if (destinationSkillsFolder.startsWith(str)) {
      return destinationSkillsFolder.slice(str.length);
    }
  }

  if (destinationSkillsFolder.includes('..')) {
    throw new Error(`Invalid destination skills folder: ${destinationSkillsFolder}`);
  }

  return destinationSkillsFolder;
}
