// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { compileLanguage, parseLanguage } from '../lib/language-core.mjs';

const source = `pub fn reverse(source: String) -> String {
  let mut index: usize = source.length
  let mut output: String = ""
  let markers = [1, 2, 3]
  while index > 0 {
    index -= 1
    output = output + source[index]
  }
  if markers[0] == 1 { return output }
  return ""
}`;
const program = parseLanguage(source);
const fn = program.declarations.find(item => item.name === 'reverse');
assert.equal(fn.body.body.some(item => item.kind === 'WhileStatement'), true);
assert.equal(fn.body.body.some(item => item.kind === 'AssignmentStatement'), false);
const result = compileLanguage(source, { autoRun: false });
assert.match(result.code, /while/);
assert.match(result.code, /markers\[0\]/);
const module = await import(`data:text/javascript;base64,${Buffer.from(result.code).toString('base64')}`);
assert.equal(module.reverse('Kura'), 'aruK');
console.log('language control-flow tests passed');
