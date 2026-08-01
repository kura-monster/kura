// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'kr.mjs');

const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
assert.equal(version.status, 0, version.stderr);
assert.match(version.stdout, /Kura v1\.0\.0/);

const projectRoot = await mkdtemp(path.join(tmpdir(), 'kura-smoke-'));
try {
  const created = spawnSync(process.execPath, [cli, 'new', 'hello'], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const main = await readFile(path.join(projectRoot, 'hello', 'src', 'main.kr'), 'utf8');
  assert.match(main, /fn main/);

  const checked = spawnSync(process.execPath, [cli, 'check'], { cwd: path.join(projectRoot, 'hello'), encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}

console.log('Kura smoke tests passed.');
