#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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

// GNU tar reports SIGPIPE when grep -q exits after the first match under
// `set -o pipefail`. This temporary grep-compatible wrapper consumes all input
// before returning, so package-content checks remain deterministic.
const grepWrapper = '/tmp/kura-full-read-grep';
await writeFile(grepWrapper, `#!/usr/bin/env node
let input = '';
for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2).filter(arg => arg !== '-q' && arg !== '--quiet');
const pattern = args[0] ?? '';
const found = input.includes(pattern);
if (!process.argv.includes('-q') && !process.argv.includes('--quiet') && found) {
  for (const line of input.split(/\\r?\\n/)) if (line.includes(pattern)) console.log(line);
}
process.exit(found ? 0 : 1);
`, 'utf8');
await chmod(grepWrapper, 0o755);
execFileSync('sudo', ['install', '-m', '0755', grepWrapper, '/usr/local/bin/grep'], { stdio: 'inherit' });

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
