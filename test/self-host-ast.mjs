// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { bootstrapSelfHostedCompiler, compileWithSelfHostedCompiler } from '../lib/self-host.mjs';
const bootstrap = await bootstrapSelfHostedCompiler();
assert.equal(bootstrap.fixedPoint, true);
assert.equal(bootstrap.frontendTypecheck[0], true);
assert.ok(bootstrap.frontendAst[1].length >= 10);
assert.equal(bootstrap.capabilities.astParserWrittenInKura, true);
const result = await compileWithSelfHostedCompiler('pub fn identity(value: String) -> String { return value }');
assert.equal(result.typecheck[0], true);
assert.equal(result.ast[1][0][1], 'identity');
await assert.rejects(() => compileWithSelfHostedCompiler('pub fn broken() -> String { return 42 }'), error => error.code === 'KR-SELF-TYPE-0102');
console.log('self-host AST frontend tests passed');
