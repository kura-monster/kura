// SPDX-License-Identifier: MIT OR Apache-2.0
import { performance } from 'node:perf_hooks';
export const now = () => Date.now();
export const monotonic = () => performance.now();
export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export async function measure(fn) { const start = performance.now(); const value = await fn(); return { value, milliseconds: performance.now() - start }; }
export async function withTimeout(promise, milliseconds, message = 'Operation timed out') { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); timer.unref?.(); })]); } finally { if (timer) clearTimeout(timer); } }
