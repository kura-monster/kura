// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile } from '../lib/compiler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'kr.mjs');

assert.throws(
  () => compile('import x from "data:text/javascript,export default 1";\nfn main() {}'),
  error => error.code === 'KR-SEC-1203',
);
assert.throws(
  () => compile('import fs from node:"fs";\nfn main() {}', { securityMode: 'strict' }),
  error => error.code === 'KR-SEC-1205',
);

const workspace = await mkdtemp(path.join(tmpdir(), 'kura-security-'));
try {
  const traversal = path.join(workspace, 'traversal');
  await mkdir(traversal, { recursive: true });
  await writeFile(path.join(workspace, 'outside.kr'), 'fn main() {}\n');
  await writeFile(path.join(traversal, 'kura.json'), JSON.stringify({ name: 'bad', entry: '../outside.kr', target: 'node' }));
  const escaped = spawnSync(process.execPath, [cli, 'check'], { cwd: traversal, encoding: 'utf8' });
  assert.equal(escaped.status, 1);
  assert.match(escaped.stderr, /KR-SEC-0201/);

  const invalidNew = spawnSync(process.execPath, [cli, 'new', '../escape'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(invalidNew.status, 1);
  assert.match(invalidNew.stderr, /KR-SEC-0102/);

  const created = spawnSync(process.execPath, [cli, 'new', 'safe'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const project = path.join(workspace, 'safe');

  const first = spawnSync(process.execPath, [cli, 'run', '--turbo'], { cwd: project, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Hello, Kura!/);

  const cacheDir = path.join(project, '.kura', 'velocity');
  const cacheFile = (await readdir(cacheDir)).find(name => name.endsWith('.mjs'));
  assert.ok(cacheFile);
  await writeFile(path.join(cacheDir, cacheFile), 'console.log("CACHE_PWNED");\n');
  const second = spawnSync(process.execPath, [cli, 'run', '--turbo'], { cwd: project, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Hello, Kura!/);
  assert.doesNotMatch(second.stdout, /CACHE_PWNED/);
  const repaired = await readFile(path.join(cacheDir, cacheFile), 'utf8');
  assert.match(repaired, /^\/\/ Kura-Cache-HMAC: [a-f0-9]{64}/);

  await writeFile(path.join(project, 'src', 'env.kr'), 'fn main() { println(process.env.NODE_OPTIONS); }\n');
  const envRun = spawnSync(process.execPath, [cli, 'run', 'src/env.kr'], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--trace-warnings' },
  });
  assert.equal(envRun.status, 0, envRun.stderr);
  assert.match(envRun.stdout, /undefined/);

  await writeFile(path.join(project, 'src', 'danger.kr'), 'import cp from node:"child_process";\nfn main() {}\n');
  const audit = spawnSync(process.execPath, [cli, 'security', 'audit'], { cwd: project, encoding: 'utf8' });
  assert.equal(audit.status, 1);
  assert.match(audit.stdout, /KR-AUDIT-001/);
  assert.match(audit.stderr, /KR-AUDIT-0001/);

  if (process.platform !== 'win32') {
    const buildDir = path.join(project, 'build');
    await mkdir(buildDir, { recursive: true });
    const target = path.join(workspace, 'target.mjs');
    await writeFile(target, 'safe\n');
    const link = path.join(buildDir, 'main.mjs');
    await symlink(target, link);
    const build = spawnSync(process.execPath, [cli, 'build', '-o', 'build/main.mjs'], { cwd: project, encoding: 'utf8' });
    assert.equal(build.status, 1);
    assert.match(build.stderr, /KR-SEC-0204/);
    assert.equal(await readFile(target, 'utf8'), 'safe\n');
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}

console.log('Kura security hardening tests passed.');
