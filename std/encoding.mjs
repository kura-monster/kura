// SPDX-License-Identifier: MIT OR Apache-2.0
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const utf8Encode = value => encoder.encode(String(value));
export const utf8Decode = value => decoder.decode(value);
export const base64Encode = value => Buffer.from(typeof value === 'string' ? value : value).toString('base64');
export const base64Decode = value => Buffer.from(String(value), 'base64');
export const hexEncode = value => Buffer.from(typeof value === 'string' ? value : value).toString('hex');
export const hexDecode = value => Buffer.from(String(value), 'hex');
