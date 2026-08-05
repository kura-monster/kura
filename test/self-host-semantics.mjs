// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import {
  analyzeWithSelfHostedFrontend,
  bootstrapSelfHostedCompiler,
  parseWithSelfHostedFrontend,
} from '../lib/self-host.mjs';

const bootstrap = await bootstrapSelfHostedCompiler();
assert.equal(bootstrap.fixedPoint, true);
assert.equal(bootstrap.frontendVersion, '1.4-kura-semantic-frontend');
assert.equal(bootstrap.frontendSemanticTypecheck[0], true);
assert.equal(bootstrap.capabilities.expressionParserWrittenInKura, true);
assert.equal(bootstrap.capabilities.patternParserWrittenInKura, true);
assert.equal(bootstrap.capabilities.genericConstraintCheckerWrittenInKura, true);
assert.equal(bootstrap.capabilities.moveDataflowWrittenInKura, true);

const expression = await parseWithSelfHostedFrontend('expression', '1 + 2 * 3 == 7');
assert.equal(expression[1].length, 0);
assert.equal(expression[0][0], 'binary');
assert.equal(expression[0][1], '==');
assert.equal(expression[0][2][0], 'binary');
assert.equal(expression[0][2][3][1], '*');

const pattern = await parseWithSelfHostedFrontend('pattern', 'Option::Some(value) | Option::None');
assert.equal(pattern[0], 'or');
assert.deepEqual(pattern[1], ['variant', 'Option::Some', [['binding', 'value']]]);
assert.deepEqual(pattern[2], ['variant', 'Option::None', []]);

const valid = await analyzeWithSelfHostedFrontend(`trait Render {}
pub fn choose<T: Render>(value: T) -> T where T: Clone { return value }`);
assert.equal(valid.analysis.ok, true);
assert.equal(valid.semanticTypecheck[0], true);
assert.equal(valid.generics[0], true);
assert.equal(valid.generics[3][0][1][0][0], 'T');
assert.deepEqual(valid.generics[3][0][2][0], ['T', ['Clone']]);

const invalidTrait = await analyzeWithSelfHostedFrontend('pub fn choose<T: Missing>(value: T) -> T { return value }');
assert.equal(invalidTrait.generics[0], false);
assert.ok(invalidTrait.generics[4].some(item => item[0] === 'KR-SELF-TRAIT-0001'));

const moved = await analyzeWithSelfHostedFrontend(`pub fn consume(value: String) -> String {
  if true { let left = move value } else { let right = move value }
  return value
}`);
assert.equal(moved.moveDataflow[0], false);
assert.ok(moved.moveDataflow[2].some(item => item[0] === 'KR-SELF-BORROW-0103'));
assert.equal(moved.semanticTypecheck[0], false);

const loopMove = await analyzeWithSelfHostedFrontend(`pub fn consume(value: String) -> String {
  while true { let item = move value }
  return value
}`);
assert.ok(loopMove.moveDataflow[2].some(item => item[0] === 'KR-SELF-BORROW-0102'));

console.log('self-host semantic frontend tests passed');
