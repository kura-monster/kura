// SPDX-License-Identifier: MIT OR Apache-2.0
export const parseUrl = value => new URL(value);
export const joinUrl = (base, relative) => new URL(relative, base).href;
export function queryString(value) { const params = new URLSearchParams(); for (const [key, item] of Object.entries(value ?? {})) { if (Array.isArray(item)) for (const nested of item) params.append(key, String(nested)); else if (item !== undefined && item !== null) params.set(key, String(item)); } return params.toString(); }
