// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import {
  PriorityRoundRobinSchedulerModel,
  SlabAllocatorModel,
  TicketSpinLockModel,
  createContextSwitchAssembly,
  createKernelSchedulerManifest,
  createKernelSchedulerSource,
  createSchedulerBuildPlan,
  parseAcpiHpet,
} from '../lib/system-kernel-scheduler.mjs';
import { compileNativeSystemSource } from '../lib/system-native-compiler.mjs';

const manifest = createKernelSchedulerManifest();
assert.equal(manifest.features.ticketSpinlocks, true);
assert.equal(manifest.features.perCpuStorage, true);
assert.equal(manifest.features.slabAllocator, true);
assert.equal(manifest.features.kernelThreads, true);
assert.equal(manifest.features.priorityRoundRobinScheduler, true);
assert.ok(manifest.maxTasks >= 256);
assert.ok(manifest.maxCpus >= 64);
for (let index = 1; index < manifest.regions.length; index++) {
  assert.ok(manifest.regions[index].start >= manifest.regions[index - 1].end);
}

const lock = new TicketSpinLockModel();
const first = lock.reserve();
const second = lock.reserve();
assert.equal(first, 0);
assert.equal(second, 1);
assert.equal(lock.canEnter(first), true);
assert.equal(lock.canEnter(second), false);
lock.release();
assert.equal(lock.canEnter(second), true);
assert.equal(lock.queued, 1);

const slab = new SlabAllocatorModel();
const objectA = slab.allocate(48);
const objectB = slab.allocate(48);
assert.notEqual(objectA, 0);
assert.notEqual(objectA, objectB);
assert.equal(slab.free(objectA), true);
assert.equal(slab.allocate(48), objectA);
assert.equal(slab.allocate(4096), 0);

const scheduler = new PriorityRoundRobinSchedulerModel({ quantum: 2 });
const low = scheduler.spawn('low', 3);
const highA = scheduler.spawn('high-a', 0);
const highB = scheduler.spawn('high-b', 0);
assert.equal(scheduler.pick(), highA);
assert.equal(scheduler.yield(), highB);
assert.equal(scheduler.yield(), highA);
scheduler.sleep(highA, 2);
assert.equal(scheduler.pick(), highB);
scheduler.tick();
scheduler.tick();
scheduler.yield();
assert.equal(scheduler.current, highB);
assert.equal(scheduler.yield(), highA);
scheduler.exit(highA);
scheduler.exit(highB);
assert.equal(scheduler.pick(), low);

const hpet = Buffer.alloc(56);
hpet.write('HPET', 0, 'ascii');
hpet.writeUInt32LE(56, 4);
hpet.writeUInt32LE(0x8086A201, 36);
hpet.writeUInt8(0, 40);
hpet.writeUInt8(64, 41);
hpet.writeUInt8(0, 42);
hpet.writeUInt8(4, 43);
hpet.writeBigUInt64LE(0xFED00000n, 44);
hpet.writeUInt8(0, 52);
hpet.writeUInt16LE(128, 53);
let checksum = 0;
for (const byte of hpet) checksum = (checksum + byte) & 0xFF;
hpet[9] = (-checksum) & 0xFF;
const parsedHpet = parseAcpiHpet(hpet);
assert.equal(parsedHpet.address, 0xFED00000n);
assert.equal(parsedHpet.minimumTick, 128);

const assembly = createContextSwitchAssembly();
assert.match(assembly, /kura_context_switch/);
assert.match(assembly, /movq %rsp, \(%rdi\)/);
assert.match(assembly, /movq %rsi, %rsp/);

const source = createKernelSchedulerSource({ smoke: true, enableSmp: true });
assert.match(source, /atomic\.fetch_add<u32>/);
assert.match(source, /extern "C" fn kura_context_switch/);
assert.match(source, /pub unsafe fn spawn_kernel_thread/);
assert.match(source, /pub unsafe fn slab_alloc/);
assert.match(source, /unsafe fn init_local_apic_timer/);
assert.match(source, /function\.call0\(entry\)/);
assert.match(source, /scheduler_timer_tick\(\)/);
const llvm = compileNativeSystemSource(source, { file: 'scheduler-kernel.kr' });
assert.match(llvm, /cmpxchg|atomicrmw/);
assert.match(llvm, /declare void @kura_context_switch/);
assert.match(llvm, /define .* @kernel_main/);
assert.match(llvm, /define .* @kura_ap_main/);

const plan = createSchedulerBuildPlan({ input: 'kernel.kr', outDir: 'build/scheduler' });
assert.match(plan.schedulerAssembly, /kura-context-switch\.S$/);
assert.match(plan.schedulerObject, /kura-context-switch\.o$/);

console.log('system kernel scheduler tests passed');
