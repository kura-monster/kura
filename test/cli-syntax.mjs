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
assert.match(cliSource, /async function sqlGate/);
assert.match(cliSource, /async function benchCommand/);
assert.match(cliSource, /async function securityCommand/);

function runCli(file, ...args) {
  return spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
}

const version = runCli('bin/kr.mjs', '--version');
assert.equal(version.status, 0, version.stderr || version.stdout);
assert.match(version.stdout, /Kura v1\.0\.0/);

const doctor = runCli('bin/kr.mjs', 'doctor');
assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
assert.match(doctor.stdout, /Native system compiler: installed/);

const security = runCli('bin/kr.mjs', 'security', 'status');
assert.equal(security.status, 0, security.stderr || security.stdout);
assert.match(security.stdout, /Security Shield/);

const systemHelp = runCli('bin/kr-system.mjs', '--help');
assert.equal(systemHelp.status, 0, systemHelp.stderr || systemHelp.stdout);
assert.match(systemHelp.stdout, /Kura native system compiler/);
assert.match(systemHelp.stdout, /emit-llvm/);

console.log('CLI and compiler regression tests passed');
