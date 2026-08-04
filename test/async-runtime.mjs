// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import {
  analyzeAsyncStateMachines, createNativeAsyncPlan, KuraExecutor, AsyncChannel,
  AsyncMutex, AsyncSemaphore, TaskGroup, CancellationToken, CancellationError, sleep,
} from '../lib/async-runtime.mjs';

const source = `async fn load(value: i32) -> i32 { let first = await fetch(value) let second = await fetch(first) return second }`;
const analysis = analyzeAsyncStateMachines(source, { file: 'async.kr' });
assert.equal(analysis.machines.length, 1);
assert.equal(analysis.totalAwaitPoints, 2);
assert.equal(analysis.machines[0].completedState, 3);
const native = createNativeAsyncPlan(source);
assert.match(native.llvm, /%async\.load/);
assert.match(native.llvm, /@load\$poll/);

const executor = new KuraExecutor({ maxConcurrency: 2 });
const channel = new AsyncChannel(1);
const mutex = new AsyncMutex();
const semaphore = new AsyncSemaphore(1);
let shared = 0;
const group = new TaskGroup({ executor });
group.spawn(async token => {
  const release = await semaphore.acquire(token);
  try { await sleep(2, token); await channel.send(40, token); return 1; } finally { release(); }
});
group.spawn(async token => {
  const item = await channel.receive(token);
  return mutex.runExclusive(async () => { shared += item.value + 2; return shared; }, token);
});
assert.deepEqual(await group.wait(), [1, 42]);
assert.equal(shared, 42);
channel.close();

const token = new CancellationToken();
const cancelled = executor.spawn(async inner => { await sleep(100, inner); }, { token });
token.cancel();
await assert.rejects(cancelled.promise, error => error instanceof CancellationError);
await executor.shutdown();
console.log('async runtime tests passed');
