// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapSelfHostedCompiler, compileWithSelfHostedCompiler, writeSelfHostArtifacts, verifySelfHostArtifacts } from '../lib/self-host.mjs';

const bootstrap = await bootstrapSelfHostedCompiler();
assert.equal(bootstrap.fixedPoint, true);
assert.equal(bootstrap.frontendSelfAnalysis.ok, true);
assert.equal(bootstrap.frontendSelfAnalysis.functions >= 8, true);
assert.equal(bootstrap.invalidAnalysis.diagnostics.some(item => item.code === 'KR-SELF-TYPE-0001'), true);
const compiled = await compileWithSelfHostedCompiler('pub fn add(a: i32, b: i32) -> i32 { return a + b }');
assert.equal(compiled.analysis.ok, true);
const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
assert.equal(module.add(20, 22), 42);
await assert.rejects(() => compileWithSelfHostedCompiler('pub fn bad(value: Unknown) -> String { return value }'), error => error.code === 'KR-SELF-TYPE-0001');
const directory = await mkdtemp(join(tmpdir(), 'kura-selfhost-frontend-'));
await writeSelfHostArtifacts(directory);
assert.equal((await verifySelfHostArtifacts(directory)).ok, true);
console.log('self-host frontend tests passed');
