// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export class IncrementalCompilerCache {
  constructor(directory = '.kura/cache') { this.directory = resolve(directory); this.indexPath = join(this.directory, 'index.json'); this.index = { version: 1, entries: {} }; this.loaded = false; }
  async load() {
    if (this.loaded) return this;
    await mkdir(this.directory, { recursive: true });
    try { this.index = JSON.parse(await readFile(this.indexPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.loaded = true; return this;
  }
  key({ source, file = '<input>', target = 'js', options = {}, dependencies = {} }) {
    return sha256(stable({ source, file, target, options, dependencies }));
  }
  async get(input) {
    await this.load();
    const key = this.key(input); const metadata = this.index.entries[key];
    if (!metadata) return null;
    try {
      const payload = JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8'));
      metadata.hits = (metadata.hits ?? 0) + 1; metadata.lastAccess = Date.now(); await this.#saveIndex();
      return { key, metadata, payload };
    } catch (error) {
      if (error.code === 'ENOENT') { delete this.index.entries[key]; await this.#saveIndex(); return null; }
      throw error;
    }
  }
  async put(input, payload, metadata = {}) {
    await this.load(); const key = this.key(input); const path = join(this.directory, `${key}.json`);
    await writeFile(path, JSON.stringify(payload));
    this.index.entries[key] = { file: input.file ?? '<input>', target: input.target ?? 'js', createdAt: Date.now(), lastAccess: Date.now(), hits: 0, bytes: Buffer.byteLength(JSON.stringify(payload)), dependencies: input.dependencies ?? {}, ...metadata };
    await this.#saveIndex(); return { key, path };
  }
  async invalidateFile(file) {
    await this.load(); const absolute = resolve(file); let removed = 0;
    for (const [key, entry] of Object.entries(this.index.entries)) if (resolve(entry.file) === absolute || Object.keys(entry.dependencies ?? {}).some(dep => resolve(dep) === absolute)) {
      delete this.index.entries[key]; await rm(join(this.directory, `${key}.json`), { force: true }); removed++;
    }
    await this.#saveIndex(); return removed;
  }
  async prune(options = {}) {
    await this.load(); const maxEntries = options.maxEntries ?? 512; const maxAge = options.maxAge ?? 30 * 86400000; const now = Date.now();
    const sorted = Object.entries(this.index.entries).sort((a, b) => (b[1].lastAccess ?? 0) - (a[1].lastAccess ?? 0));
    let removed = 0;
    for (let index = 0; index < sorted.length; index++) {
      const [key, entry] = sorted[index];
      if (index >= maxEntries || now - (entry.lastAccess ?? entry.createdAt ?? 0) > maxAge) { delete this.index.entries[key]; await rm(join(this.directory, `${key}.json`), { force: true }); removed++; }
    }
    await this.#saveIndex(); return removed;
  }
  async clear() { await rm(this.directory, { recursive: true, force: true }); this.index = { version: 1, entries: {} }; this.loaded = false; }
  async #saveIndex() { await mkdir(dirname(this.indexPath), { recursive: true }); await writeFile(this.indexPath, JSON.stringify(this.index, null, 2) + '\n'); }
  stats() { const entries = Object.values(this.index.entries); return { entries: entries.length, bytes: entries.reduce((sum, item) => sum + (item.bytes ?? 0), 0), hits: entries.reduce((sum, item) => sum + (item.hits ?? 0), 0) }; }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(value) { let current = value < 0 ? ((-value) << 1) + 1 : value << 1; let output = ''; do { let digit = current & 31; current >>>= 5; if (current) digit |= 32; output += BASE64[digit]; } while (current); return output; }

export function createSourceMap({ file, source, generatedFile, mappings = [] }) {
  const lines = [];
  let previousSource = 0; let previousLine = 0; let previousColumn = 0;
  const grouped = new Map();
  for (const mapping of mappings) { const list = grouped.get(mapping.generatedLine) ?? []; list.push(mapping); grouped.set(mapping.generatedLine, list); }
  const maxLine = Math.max(1, ...grouped.keys());
  for (let line = 1; line <= maxLine; line++) {
    const items = (grouped.get(line) ?? []).sort((a, b) => a.generatedColumn - b.generatedColumn);
    let previousGeneratedColumn = 0;
    lines.push(items.map(item => {
      const segment = vlq(item.generatedColumn - previousGeneratedColumn) + vlq(0 - previousSource) + vlq((item.sourceLine - 1) - previousLine) + vlq(item.sourceColumn - previousColumn);
      previousGeneratedColumn = item.generatedColumn; previousSource = 0; previousLine = item.sourceLine - 1; previousColumn = item.sourceColumn;
      return segment;
    }).join(','));
  }
  return { version: 3, file: generatedFile, sources: [file], sourcesContent: [source], names: [], mappings: lines.join(';') };
}

export function createDwarfMetadata({ file = '<input>', directory = '.', functions = [], producer = 'Kura Compiler 1.0' } = {}) {
  const escaped = value => String(value).replaceAll('\\', '\\5C').replaceAll('"', '\\22');
  const nodes = [];
  nodes.push(`!0 = distinct !DICompileUnit(language: DW_LANG_C_plus_plus_14, file: !1, producer: "${escaped(producer)}", isOptimized: false, runtimeVersion: 0, emissionKind: FullDebug)`);
  nodes.push(`!1 = !DIFile(filename: "${escaped(file)}", directory: "${escaped(directory)}")`);
  nodes.push('!2 = !{}');
  const functionMetadata = [];
  functions.forEach((fn, index) => {
    const id = index + 3;
    nodes.push(`!${id} = distinct !DISubprogram(name: "${escaped(fn.name)}", linkageName: "${escaped(fn.symbol ?? fn.name)}", scope: !1, file: !1, line: ${fn.line ?? 1}, type: !2, scopeLine: ${fn.line ?? 1}, spFlags: DISPFlagDefinition, unit: !0)`);
    functionMetadata.push({ name: fn.name, id });
  });
  return { moduleFlags: ['!llvm.dbg.cu = !{!0}', '!llvm.module.flags = !{!100, !101}', '!100 = !{i32 2, !"Dwarf Version", i32 5}', '!101 = !{i32 2, !"Debug Info Version", i32 3}'], nodes, functions: functionMetadata, text: [...nodes, '!llvm.dbg.cu = !{!0}', '!llvm.module.flags = !{!100, !101}', '!100 = !{i32 2, !"Dwarf Version", i32 5}', '!101 = !{i32 2, !"Debug Info Version", i32 3}'].join('\n') + '\n' };
}

export class KuraDebuggerSession extends EventEmitter {
  constructor(program = {}) { super(); this.program = program; this.breakpoints = new Map(); this.frames = []; this.state = 'created'; this.nextBreakpointId = 1; this.pauseReason = null; }
  setBreakpoint(file, line, column = 1, condition = null) {
    const id = this.nextBreakpointId++; const record = { id, file: resolve(file), line, column, condition, enabled: true, hits: 0 };
    this.breakpoints.set(id, record); this.emit('breakpoint', { action: 'set', breakpoint: record }); return record;
  }
  removeBreakpoint(id) { const record = this.breakpoints.get(id); const removed = this.breakpoints.delete(id); if (removed) this.emit('breakpoint', { action: 'removed', breakpoint: record }); return removed; }
  shouldBreak(location, context = {}) {
    for (const breakpoint of this.breakpoints.values()) {
      if (!breakpoint.enabled || breakpoint.file !== resolve(location.file) || breakpoint.line !== location.line) continue;
      if (breakpoint.condition && !this.#evaluateCondition(breakpoint.condition, context)) continue;
      breakpoint.hits++; return breakpoint;
    }
    return null;
  }
  #evaluateCondition(condition, context) { try { return Boolean(Function(...Object.keys(context), `"use strict"; return (${condition});`)(...Object.values(context))); } catch { return false; } }
  pause(reason, frame = null) { if (frame) this.frames.unshift(frame); this.state = 'paused'; this.pauseReason = reason; this.emit('paused', { reason, frames: this.frames }); }
  resume() { this.state = 'running'; this.pauseReason = null; this.emit('resumed'); }
  step(mode = 'into') { if (!['into', 'over', 'out'].includes(mode)) throw new Error(`Unknown step mode ${mode}.`); this.state = `step-${mode}`; this.emit('step', { mode }); }
  pushFrame(frame) { this.frames.unshift({ id: frame.id ?? this.frames.length + 1, name: frame.name ?? '<anonymous>', file: frame.file ?? '<input>', line: frame.line ?? 1, column: frame.column ?? 1, locals: frame.locals ?? {} }); }
  popFrame() { return this.frames.shift(); }
  evaluate(expression, frameId = null) { const frame = frameId == null ? this.frames[0] : this.frames.find(item => item.id === frameId); if (!frame) throw new Error('No stack frame.'); return Function(...Object.keys(frame.locals), `"use strict"; return (${expression});`)(...Object.values(frame.locals)); }
  snapshot() { return { state: this.state, pauseReason: this.pauseReason, breakpoints: [...this.breakpoints.values()], frames: structuredClone(this.frames) }; }
}

export class KuraProfiler {
  constructor(options = {}) { this.clock = options.clock ?? (() => performance.now()); this.events = []; this.stack = []; this.counters = new Map(); }
  begin(name, category = 'function', metadata = {}) { const event = { name, category, metadata, start: this.clock(), depth: this.stack.length }; this.stack.push(event); return event; }
  end(event = this.stack.at(-1)) { const top = this.stack.pop(); if (top !== event) throw new Error('Profiler regions must end in stack order.'); event.end = this.clock(); event.duration = event.end - event.start; this.events.push(event); return event.duration; }
  async measure(name, callback, category = 'function', metadata = {}) { const event = this.begin(name, category, metadata); try { return await callback(); } finally { this.end(event); } }
  increment(name, amount = 1) { this.counters.set(name, (this.counters.get(name) ?? 0) + amount); }
  report() {
    const groups = {};
    for (const event of this.events) { const key = `${event.category}:${event.name}`; const group = groups[key] ??= { name: event.name, category: event.category, calls: 0, total: 0, min: Infinity, max: 0 }; group.calls++; group.total += event.duration; group.min = Math.min(group.min, event.duration); group.max = Math.max(group.max, event.duration); }
    for (const group of Object.values(groups)) group.average = group.calls ? group.total / group.calls : 0;
    return { events: this.events, groups, counters: Object.fromEntries(this.counters), traceEvents: this.events.flatMap((event, index) => [{ name: event.name, cat: event.category, ph: 'B', ts: event.start * 1000, pid: 1, tid: 1, id: index }, { name: event.name, cat: event.category, ph: 'E', ts: event.end * 1000, pid: 1, tid: 1, id: index }]) };
  }
}

export class AddressSanitizerModel {
  constructor(options = {}) { this.redZone = options.redZone ?? 16; this.nextAddress = options.baseAddress ?? 0x10000000; this.allocations = new Map(); this.freed = new Set(); }
  allocate(size, metadata = {}) { if (!(size > 0)) throw new RangeError('Allocation size must be positive.'); const address = this.nextAddress + this.redZone; this.nextAddress = address + size + this.redZone; this.allocations.set(address, { address, size, start: address, end: address + size, metadata, initialized: new Uint8Array(size), bytes: new Uint8Array(size) }); return address; }
  free(address) { const allocation = this.allocations.get(address); if (!allocation) throw this.error('KR-ASAN-INVALID-FREE', `Invalid free at 0x${address.toString(16)}.`, address); this.allocations.delete(address); this.freed.add(address); }
  #find(address, size = 1) { for (const allocation of this.allocations.values()) if (address >= allocation.start && address + size <= allocation.end) return allocation; return null; }
  check(address, size = 1, operation = 'read') { const allocation = this.#find(address, size); if (allocation) return allocation; for (const freed of this.freed) if (address >= freed) throw this.error('KR-ASAN-UAF', `Use-after-free during ${operation} at 0x${address.toString(16)}.`, address); throw this.error('KR-ASAN-OOB', `Out-of-bounds ${operation} at 0x${address.toString(16)}.`, address); }
  write(address, bytes) { const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes); const allocation = this.check(address, data.length, 'write'); const offset = address - allocation.start; allocation.bytes.set(data, offset); allocation.initialized.fill(1, offset, offset + data.length); }
  read(address, size) { const allocation = this.check(address, size, 'read'); const offset = address - allocation.start; if (allocation.initialized.slice(offset, offset + size).some(value => !value)) throw this.error('KR-ASAN-UNINITIALIZED', `Uninitialized read at 0x${address.toString(16)}.`, address); return allocation.bytes.slice(offset, offset + size); }
  error(code, message, address) { const error = new Error(message); error.name = 'KuraSanitizerError'; error.code = code; error.address = address; return error; }
  snapshot() { return { allocations: [...this.allocations.values()].map(({ bytes, initialized, ...item }) => item), freed: [...this.freed] }; }
}

export class RaceDetectorModel {
  constructor() { this.locations = new Map(); this.reports = []; this.epochs = new Map(); }
  tick(thread) { const next = (this.epochs.get(thread) ?? 0) + 1; this.epochs.set(thread, next); return next; }
  access({ thread, address, write = false, atomic = false, lockset = [] }) {
    const epoch = this.tick(thread); const previous = this.locations.get(address) ?? [];
    if (!atomic) for (const access of previous) {
      if (access.thread === thread || !(write || access.write) || access.atomic) continue;
      const sharedLock = access.lockset.some(lock => lockset.includes(lock));
      if (!sharedLock) this.reports.push({ code: 'KR-TSAN-RACE', address, first: access, second: { thread, write, atomic, lockset: [...lockset], epoch } });
    }
    previous.push({ thread, write, atomic, lockset: [...lockset], epoch });
    if (previous.length > 32) previous.shift(); this.locations.set(address, previous);
    return this.reports.at(-1) ?? null;
  }
  report() { return { races: this.reports.length, reports: structuredClone(this.reports) }; }
}

export async function dependencyFingerprint(files = []) {
  const output = {};
  for (const file of files) {
    try { const info = await stat(file); const content = await readFile(file); output[resolve(file)] = { size: info.size, mtimeMs: info.mtimeMs, hash: sha256(content) }; }
    catch (error) { output[resolve(file)] = { missing: true, code: error.code }; }
  }
  return output;
}
