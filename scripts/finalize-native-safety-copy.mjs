#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const safetyPath = 'lib/system-native-safety.mjs';
if (!existsSync(safetyPath)) process.exit(0);

const broken = `        let copy = inferred.every(item => item.copy);
        let send = inferred.every(item => item.send);
        let sync = inferred.every(item => item.sync);
        if (hasAttribute(declaration, 'copy')) copy = true;
`;
const fixed = `        const fieldsCopy = inferred.every(item => item.copy);
        let copy = hasAttribute(declaration, 'copy') && fieldsCopy;
        let send = inferred.every(item => item.send);
        let sync = inferred.every(item => item.sync);
`;

const safetySource = await readFile(safetyPath, 'utf8');
if (!safetySource.includes(fixed)) {
  const occurrences = safetySource.split(broken).length - 1;
  if (occurrences !== 1) throw new Error(`Expected one native Copy inference block, found ${occurrences}.`);
  await writeFile(safetyPath, safetySource.replace(broken, fixed), 'utf8');
}

const packagePath = 'package.json';
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
if (packageJson.scripts?.pretest === 'node scripts/finalize-native-safety-copy.mjs') {
  delete packageJson.scripts.pretest;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

for (const temporary of [
  '.github/workflows/validate-native-safety-final.yml',
  'scripts/finalize-native-safety-copy.mjs',
]) {
  try { await unlink(temporary); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
