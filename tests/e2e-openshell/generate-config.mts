import { readFileSync } from 'node:fs';

import { generateKaidenArtifacts, type KaidenConfigInput } from './kaiden-config-adapter.mjs';

const input: KaidenConfigInput = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));
const output = await generateKaidenArtifacts(input);

process.stdout.write(JSON.stringify(output));
