// SPDX-License-Identifier: MIT OR Apache-2.0

import { EventEmitter } from 'node:events';
import { parseLanguage } from './language-core.mjs';

function visit(node, callback, parent = null) {
  if (!node || typeof node !== 'object') return;
  callback(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) visit(item, callback, node);
    else if (value && typeof value === 'object' && value.kind) visit(value, callback, node);
  }
}

export function analyzeAsyncStateMachines(programOrSource, options = {}) {
  const program = typeof programOrSource === 'string' ? parseLanguage(programOrSource, options) : programOrSource;
  const machines = [];
  for (const fn of program.declarations.filter(item => item.kind === 'FunctionDeclaration' && item.async)) {
    const awaits = [];
    const locals = new Map(fn.params.map(item => [item.name, item.type ?? 'unknown']));
    visit(fn.body, node => {
      if (node.kind === 'VariableDeclaration') locals.set(node.name, node.type ?? 'inferred');
      if (node.kind === 'AwaitExpression') awaits.push({ state: awaits.length + 1, line: node.token?.line ?? 1, column: node.token?.column ?? 1 });
    });
    const fields = [
      { name: 'state', type: 'u32' },
      { name: 'status', type: 'u8' },
      { name: 'cancelled', type: 'bool' },
      { name: 'waker', type: '*mut Waker' },
      ...[...locals].map(([name, type]) => ({ name, type })),
    ];
    machines.push({
      function: fn.name,
      symbol: `${fn.name}$Future`,
      pollSymbol: `${fn.name}$poll`,
      dropSymbol: `${fn.name}$drop`,
      initialState: 0,
      completedState: awaits.length + 1,
      awaits,
      fields,
      returnType: fn.returnType,
      cancellationPoints: awaits.map(item => item.state),
    });
  }
  return { program, machines, totalAwaitPoints: machines.reduce((sum, item) => sum + item.awaits.length, 0) };
}

export function createNativeAsyncPlan(programOrSource, options = {}) {
  const analysis = analyzeAsyncStateMachines(programOrSource, options);
  const llvm = [];
  for (const machine of analysis.machines) {
    llvm.push(`%async.${machine.function} = type { i32, i8, i1, ptr${machine.fields.slice(4).map(() => ', i64').join('')} }`);
    llvm.push(`define i8 @${machine.pollSymbol}(ptr %future, ptr %context) {\nentry:\n  %state_ptr = getelementptr %async.${machine.function}, ptr %future, i32 0, i32 0\n  %state = load i32, ptr %state_ptr\n  switch i32 %state, label %pending [ ${Array.from({ length: machine.completedState + 1 }, (_, state) => `i32 ${state}, label %state${state}`).join(' ')} ]\n${Array.from({ length: machine.completedState + 1 }, (_, state) => `state${state}:\n  ${state === machine.completedState ? 'ret i8 1' : `store i32 ${state + 1}, ptr %state_ptr\n  ret i8 0`}`).join('\n')}\npending:\n  ret i8 0\n}`);
  }
  return { ...analysis, llvm: llvm.join('\n\n') + (llvm.length ? '\n' : '') };
}

export class CancellationError extends Error {
  constructor(message = 'Kura task was cancelled.') { super(message); this.name = 'CancellationError'; this.code = 'KR-ASYNC-CANCELLED'; }
}

export class CancellationToken {
  #cancelled = false;
  #reason = null;
  #listeners = new Set();
  get cancelled() { return this.#cancelled; }
  get reason() { return this.#reason; }
  cancel(reason = new CancellationError()) {
    if (this.#cancelled) return false;
    this.#cancelled = true;
    this.#reason = reason instanceof Error ? reason : new CancellationError(String(reason));
    for (const listener of this.#listeners) listener(this.#reason);
    this.#listeners.clear();
    return true;
  }
  throwIfCancelled() { if (this.#cancelled) throw this.#reason; }
  onCancel(listener) {
    if (this.#cancelled) { listener(this.#reason); return () => {}; }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  static linked(...tokens) {
    const linked = new CancellationToken();
    for (const token of tokens.filter(Boolean)) token.onCancel(reason => linked.cancel(reason));
    return linked;
  }
}

export class KuraFuture {
  constructor(executor, options = {}) {
    this.token = options.token ?? new CancellationToken();
    this.name = options.name ?? 'future';
    this.createdAt = performance.now();
    this.status = 'pending';
    this.value = undefined;
    this.error = null;
    this.promise = Promise.resolve().then(async () => {
      this.token.throwIfCancelled();
      this.status = 'running';
      try {
        this.value = await executor(this.token);
        this.token.throwIfCancelled();
        this.status = 'completed';
        return this.value;
      } catch (error) {
        this.error = error;
        this.status = error instanceof CancellationError ? 'cancelled' : 'failed';
        throw error;
      }
    });
  }
  then(resolve, reject) { return this.promise.then(resolve, reject); }
  catch(reject) { return this.promise.catch(reject); }
  finally(callback) { return this.promise.finally(callback); }
  cancel(reason) { return this.token.cancel(reason); }
}

export class KuraExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.active = 0;
    this.queue = [];
    this.tasks = new Map();
    this.nextId = 1;
    this.closed = false;
  }
  spawn(executor, options = {}) {
    if (this.closed) throw new Error('Executor is closed.');
    const id = this.nextId++;
    const token = options.token ?? new CancellationToken();
    let start;
    const promise = new Promise((resolve, reject) => { start = { resolve, reject }; });
    const record = { id, name: options.name ?? `task-${id}`, executor, token, status: 'queued', promise, start, createdAt: performance.now() };
    this.tasks.set(id, record);
    this.queue.push(record);
    this.emit('queued', record);
    this.#drain();
    return {
      id,
      name: record.name,
      token,
      promise,
      cancel: reason => token.cancel(reason),
      then: (...args) => promise.then(...args),
      catch: (...args) => promise.catch(...args),
      finally: (...args) => promise.finally(...args),
    };
  }
  #drain() {
    while (!this.closed && this.active < this.maxConcurrency && this.queue.length) {
      const record = this.queue.shift();
      this.active++;
      record.status = 'running';
      record.startedAt = performance.now();
      this.emit('started', record);
      Promise.resolve().then(() => record.executor(record.token)).then(value => {
        record.token.throwIfCancelled();
        record.status = 'completed'; record.value = value; record.start.resolve(value);
        this.emit('completed', record);
      }, error => {
        record.status = error instanceof CancellationError ? 'cancelled' : 'failed'; record.error = error; record.start.reject(error);
        this.emit(record.status, record);
      }).finally(() => {
        record.finishedAt = performance.now(); this.active--; this.#drain();
      });
    }
  }
  async shutdown(options = {}) {
    this.closed = true;
    if (options.cancelPending !== false) {
      for (const record of this.queue) record.token.cancel(new CancellationError('Executor shutdown.'));
      for (const record of this.queue.splice(0)) record.start.reject(record.token.reason);
    }
    if (options.cancelRunning) for (const record of this.tasks.values()) if (record.status === 'running') record.token.cancel(new CancellationError('Executor shutdown.'));
    await Promise.allSettled([...this.tasks.values()].map(item => item.promise));
  }
  snapshot() {
    return [...this.tasks.values()].map(({ executor, start, promise, token, ...item }) => ({ ...item, cancelled: token.cancelled }));
  }
}

export class AsyncChannel {
  constructor(capacity = Infinity) {
    if (!(capacity > 0)) throw new RangeError('Channel capacity must be positive.');
    this.capacity = capacity;
    this.values = [];
    this.receivers = [];
    this.senders = [];
    this.closed = false;
  }
  async send(value, token = null) {
    token?.throwIfCancelled();
    if (this.closed) throw new Error('Channel is closed.');
    if (this.receivers.length) { this.receivers.shift().resolve({ value, done: false }); return; }
    if (this.values.length < this.capacity) { this.values.push(value); return; }
    return new Promise((resolve, reject) => {
      const sender = { value, resolve, reject };
      this.senders.push(sender);
      const unsubscribe = token?.onCancel(reason => {
        const index = this.senders.indexOf(sender);
        if (index >= 0) this.senders.splice(index, 1);
        reject(reason);
      });
      sender.unsubscribe = unsubscribe;
    });
  }
  async receive(token = null) {
    token?.throwIfCancelled();
    if (this.values.length) {
      const value = this.values.shift();
      const sender = this.senders.shift();
      if (sender) { this.values.push(sender.value); sender.unsubscribe?.(); sender.resolve(); }
      return { value, done: false };
    }
    if (this.senders.length) { const sender = this.senders.shift(); sender.unsubscribe?.(); sender.resolve(); return { value: sender.value, done: false }; }
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve, reject) => {
      const receiver = { resolve, reject };
      this.receivers.push(receiver);
      const unsubscribe = token?.onCancel(reason => {
        const index = this.receivers.indexOf(receiver);
        if (index >= 0) this.receivers.splice(index, 1);
        reject(reason);
      });
      receiver.unsubscribe = unsubscribe;
    });
  }
  close() {
    if (this.closed) return false;
    this.closed = true;
    for (const receiver of this.receivers.splice(0)) { receiver.unsubscribe?.(); receiver.resolve({ value: undefined, done: true }); }
    for (const sender of this.senders.splice(0)) { sender.unsubscribe?.(); sender.reject(new Error('Channel is closed.')); }
    return true;
  }
  [Symbol.asyncIterator]() { return { next: () => this.receive() }; }
}

export class AsyncMutex {
  constructor() { this.locked = false; this.waiters = []; }
  async acquire(token = null) {
    token?.throwIfCancelled();
    if (!this.locked) { this.locked = true; return this.#releaseHandle(); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      waiter.unsubscribe = token?.onCancel(reason => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(reason);
      });
    });
  }
  #releaseHandle() {
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      const next = this.waiters.shift();
      if (next) { next.unsubscribe?.(); next.resolve(this.#releaseHandle()); }
      else this.locked = false;
      return true;
    };
  }
  async runExclusive(callback, token = null) { const release = await this.acquire(token); try { return await callback(); } finally { release(); } }
}

export class AsyncSemaphore {
  constructor(permits = 1) { if (!(permits > 0)) throw new RangeError('Permits must be positive.'); this.permits = permits; this.waiters = []; }
  async acquire(token = null) {
    token?.throwIfCancelled();
    if (this.permits > 0) { this.permits--; return this.#releaseHandle(); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      waiter.unsubscribe = token?.onCancel(reason => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); reject(reason); });
    });
  }
  #releaseHandle() { let released = false; return () => { if (released) return false; released = true; const next = this.waiters.shift(); if (next) { next.unsubscribe?.(); next.resolve(this.#releaseHandle()); } else this.permits++; return true; }; }
}

export class TaskGroup {
  constructor(options = {}) { this.token = options.token ?? new CancellationToken(); this.executor = options.executor ?? new KuraExecutor(options); this.tasks = []; }
  spawn(callback, options = {}) { const task = this.executor.spawn(callback, { ...options, token: CancellationToken.linked(this.token, options.token) }); this.tasks.push(task); return task; }
  cancel(reason) { return this.token.cancel(reason); }
  async wait() {
    const results = await Promise.allSettled(this.tasks.map(item => item.promise));
    const failure = results.find(item => item.status === 'rejected');
    if (failure) { this.cancel(failure.reason); throw failure.reason; }
    return results.map(item => item.value);
  }
}

export function sleep(milliseconds, token = null) {
  token?.throwIfCancelled();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe?.(); resolve(); }, milliseconds);
    const unsubscribe = token?.onCancel(reason => { clearTimeout(timer); reject(reason); });
  });
}

export async function withTimeout(promise, milliseconds, message = `Operation timed out after ${milliseconds}ms.`) {
  const token = new CancellationToken();
  const timeout = sleep(milliseconds).then(() => { token.cancel(new Error(message)); throw token.reason; });
  return Promise.race([Promise.resolve(promise), timeout]);
}
