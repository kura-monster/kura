// SPDX-License-Identifier: MIT OR Apache-2.0
const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);
export function parseJson(text) { return JSON.parse(String(text), (key, value) => { if (BLOCKED.has(key)) throw new SyntaxError(`Unsafe JSON key '${key}'`); return value; }); }
export function tryParseJson(text) { try { return { ok: true, value: parseJson(text), error: null }; } catch (error) { return { ok: false, value: null, error }; } }
export function stringifyJson(value, pretty = false) { return JSON.stringify(value, null, pretty ? 2 : 0); }
