// SPDX-License-Identifier: MIT OR Apache-2.0
import { isDeepStrictEqual } from 'node:util';

export class AssertionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AssertionError';
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
  }
}

export function assert(condition, message = 'Expected condition to be true') {
  if (!condition) throw new AssertionError(message, { actual: condition, expected: true, operator: '==' });
}
export function assertEq(actual, expected, message = null) {
  if (!Object.is(actual, expected)) throw new AssertionError(message ?? `Expected ${formatValue(actual)} to equal ${formatValue(expected)}`, { actual, expected, operator: 'Object.is' });
}
export function assertNotEq(actual, expected, message = null) {
  if (Object.is(actual, expected)) throw new AssertionError(message ?? `Expected ${formatValue(actual)} not to equal ${formatValue(expected)}`, { actual, expected, operator: '!Object.is' });
}
export function assertDeepEq(actual, expected, message = null) {
  if (!isDeepStrictEqual(actual, expected)) throw new AssertionError(message ?? `Values are not deeply equal\nactual: ${formatValue(actual)}\nexpected: ${formatValue(expected)}`, { actual, expected, operator: 'deepEqual' });
}
export function assertThrows(fn, expected = null, message = null) {
  try { fn(); } catch (error) {
    if (matchesExpected(error, expected)) return error;
    throw new AssertionError(message ?? `Function threw ${error?.name ?? 'Error'}, but it did not match the expected error`, { actual: error, expected, operator: 'throws' });
  }
  throw new AssertionError(message ?? 'Expected function to throw', { expected, operator: 'throws' });
}
export async function assertRejects(fn, expected = null, message = null) {
  try { await fn(); } catch (error) {
    if (matchesExpected(error, expected)) return error;
    throw new AssertionError(message ?? `Promise rejected with ${error?.name ?? 'Error'}, but it did not match the expected error`, { actual: error, expected, operator: 'rejects' });
  }
  throw new AssertionError(message ?? 'Expected promise to reject', { expected, operator: 'rejects' });
}
export function fail(message = 'Test failed') { throw new AssertionError(message); }

function matchesExpected(error, expected) {
  if (expected === null || expected === undefined) return true;
  if (typeof expected === 'string') return String(error?.message ?? error).includes(expected);
  if (expected instanceof RegExp) return expected.test(String(error?.message ?? error));
  if (typeof expected === 'function') return error instanceof expected;
  return false;
}
function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}
