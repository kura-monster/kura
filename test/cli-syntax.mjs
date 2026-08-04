// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const compiler = await import('../lib/compiler.mjs');
assert.equal(typeof compiler.compile, 'function');
assert.equal(typeof compiler.parse, 'function');

const cliSource = await readFile('bin/kr.mjs', 'utf8');
assert.match(cliSource, /mkdir\(path\.join\(directory, 'src'\), \{ recursive: true, mode: 0o700 \}\)/);
assert.doesNotMatch(cliSource, /mode: 0o00\b/);

const result = spawnSync(process.execPath, ['bin/kr.mjs', '--version'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  windowsHide: true,
});

assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /Kura v1\.0\.0/);
console.log('CLI and compiler regression tests passed');
