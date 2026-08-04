// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapSelfHostedCompiler, writeSelfHostArtifacts, verifySelfHostArtifacts } from '../lib/self-host.mjs';
const result = await bootstrapSelfHostedCompiler();
assert.equal(result.fixedPoint, true);
assert.equal(result.hashes.stage2, result.hashes.stage3);
assert.equal(result.probeResult, 'Kura');
assert.equal(result.capabilities.compilerWrittenInKura, true);
const directory = await mkdtemp(join(tmpdir(), 'kura-selfhost-'));
await writeSelfHostArtifacts(directory);
assert.equal((await verifySelfHostArtifacts(directory)).ok, true);
console.log('self-host bootstrap tests passed');
