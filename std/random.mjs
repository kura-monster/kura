// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomBytes, randomInt as nodeRandomInt, randomUUID } from 'node:crypto';
export const randomInt = (minimum, maximum) => nodeRandomInt(minimum, maximum);
export const uuid = () => randomUUID();
export const randomHex = bytes => randomBytes(bytes).toString('hex');
export function choice(iterable) { const values = [...iterable]; if (!values.length) throw new RangeError('cannot choose from an empty collection'); return values[nodeRandomInt(values.length)]; }
export function shuffle(iterable) { const values = [...iterable]; for (let index = values.length - 1; index > 0; index--) { const other = nodeRandomInt(index + 1); [values[index], values[other]] = [values[other], values[index]]; } return values; }
