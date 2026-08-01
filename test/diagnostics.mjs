// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'kr.mjs');

const typo = spawnSync(process.execPath, [cli, 'buidl'], { encoding: 'utf8' });
assert.equal(typo.status, 1);
assert.match(typo.stderr, /Did you mean 'kr build'/);
assert.match(typo.stderr, /KR-CLI-0002/);

const project = await mkdtemp(path.join(tmpdir(), 'kura-diagnostics-'));
try {
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'kura.json'), JSON.stringify({ name: 'bad', entry: 'src/main.kr', target: 'node' }));
  await writeFile(path.join(project, 'src', 'main.kr'), 'fn main( {\n  let value = ;\n}\n');

  const checked = spawnSync(process.execPath, [cli, 'check'], { cwd: project, encoding: 'utf8' });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /KR-PARSE-1102/);
  assert.match(checked.stderr, /src[\\/]main\.kr:1:10/);
  assert.match(checked.stderr, /\^/);
  assert.match(checked.stderr, /Help:/);

  const json = spawnSync(process.execPath, [cli, 'check', '--json'], { cwd: project, encoding: 'utf8' });
  assert.equal(json.status, 1);
  const parsed = JSON.parse(json.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'KR-PARSE-1102');
  assert.equal(parsed.error.line, 1);
} finally {
  await rm(project, { recursive: true, force: true });
}

console.log('Kura friendly diagnostics tests passed.');
