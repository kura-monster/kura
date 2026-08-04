// SPDX-License-Identifier: MIT OR Apache-2.0
export const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
export const sum = iterable => [...iterable].reduce((total, value) => total + value, 0);
export function mean(iterable) { const values = [...iterable]; return values.length ? sum(values) / values.length : NaN; }
export function median(iterable) { const values = [...iterable].sort((a, b) => a - b); if (!values.length) return NaN; const middle = Math.floor(values.length / 2); return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2; }
export function variance(iterable, sample = false) { const values = [...iterable]; if (values.length <= Number(sample)) return NaN; const average = mean(values); return values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - Number(sample)); }
export function gcd(a, b) { a = Math.abs(Math.trunc(a)); b = Math.abs(Math.trunc(b)); while (b) [a, b] = [b, a % b]; return a; }
export const lcm = (a, b) => a === 0 || b === 0 ? 0 : Math.abs(Math.trunc(a * b)) / gcd(a, b);
