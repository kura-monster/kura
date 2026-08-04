// SPDX-License-Identifier: MIT OR Apache-2.0
import { createHash, createHmac, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value);
export const sha256 = value => createHash('sha256').update(bytes(value)).digest('hex');
export const sha512 = value => createHash('sha512').update(bytes(value)).digest('hex');
export const hmacSha256 = (key, value) => createHmac('sha256', bytes(key)).update(bytes(value)).digest('hex');
export const secureRandomHex = length => randomBytes(length).toString('hex');
export function timingSafeEqual(left, right) { const a = bytes(left), b = bytes(right); return a.length === b.length && nodeTimingSafeEqual(a, b); }
