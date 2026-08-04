// SPDX-License-Identifier: MIT OR Apache-2.0
export const unique = iterable => [...new Set(iterable)];
export function chunk(iterable, size) { if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer'); const values = [...iterable]; const out = []; for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size)); return out; }
export function groupBy(iterable, keyFn) { const out = new Map(); for (const value of iterable) { const key = keyFn(value); const group = out.get(key); if (group) group.push(value); else out.set(key, [value]); } return out; }
export function countBy(iterable, keyFn = value => value) { const out = new Map(); for (const value of iterable) { const key = keyFn(value); out.set(key, (out.get(key) ?? 0) + 1); } return out; }
export function zip(...iterables) { const arrays = iterables.map(value => [...value]); const length = Math.min(...arrays.map(value => value.length)); return Array.from({ length }, (_, index) => arrays.map(value => value[index])); }
export function sortBy(iterable, keyFn) { return [...iterable].sort((a, b) => { const left = keyFn(a), right = keyFn(b); return left < right ? -1 : left > right ? 1 : 0; }); }
export function partition(iterable, predicate) { const yes = [], no = []; for (const value of iterable) (predicate(value) ? yes : no).push(value); return [yes, no]; }
export function range(start, end, step = 1) { if (step === 0) throw new RangeError('step cannot be zero'); const out = []; if (step > 0) for (let value = start; value < end; value += step) out.push(value); else for (let value = start; value > end; value += step) out.push(value); return out; }
