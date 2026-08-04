// SPDX-License-Identifier: MIT OR Apache-2.0
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
export async function fileExists(file) { try { await access(file); return true; } catch { return false; } }
export const readText = file => readFile(file, 'utf8');
export const readBytes = file => readFile(file);
export async function writeText(file, value) { await mkdir(path.dirname(path.resolve(file)), { recursive: true }); await writeFile(file, String(value), 'utf8'); }
export async function writeBytes(file, value) { await mkdir(path.dirname(path.resolve(file)), { recursive: true }); await writeFile(file, value); }
export async function atomicWriteText(file, value) { const resolved = path.resolve(file); await mkdir(path.dirname(resolved), { recursive: true }); const temp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomBytes(6).toString('hex')}.tmp`); try { await writeFile(temp, String(value), { encoding: 'utf8', flag: 'wx' }); await rename(temp, resolved); } finally { await rm(temp, { force: true }).catch(() => {}); } }
export async function listDirectory(directory) { return readdir(directory); }
export async function readJson(file) { return JSON.parse(await readText(file)); }
export async function writeJson(file, value, pretty = true) { await atomicWriteText(file, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`); }
