// SPDX-License-Identifier: MIT OR Apache-2.0
export const hasEnv = name => Object.hasOwn(process.env, name);
export const getEnv = (name, fallback = null) => process.env[name] ?? fallback;
export function requireEnv(name) { const value = process.env[name]; if (value === undefined || value === '') throw new Error(`Required environment variable '${name}' is missing`); return value; }
