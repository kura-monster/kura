// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createKernelPlatformManifest, createKernelPlatformSource } from './system-kernel-platform.mjs';
import {
  createNativeBuildPlan,
  detectNativeToolchain,
  emitNativeBootstrapObject,
  emitNativeObject,
  linkNativeElf,
} from './system-native-toolchain.mjs';

const PAGE_SIZE = 0x1000;
const HPET_SIGNATURE = 0x54455048;

export const DEFAULT_KERNEL_SCHEDULER_LAYOUT = Object.freeze({
  perCpu: 0xA24000,
  perCpuSize: 0x10000,
  taskTable: 0xA34000,
  taskTableSize: 0x40000,
  schedulerScratch: 0xA74000,
  schedulerScratchSize: 0x10000,
  slabMetadata: 0xA84000,
  slabMetadataSize: 0x10000,
  timerScratch: 0xA94000,
  timerScratchSize: 0x1000,
});

function safeInteger(name, value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function aligned(name, value, alignment = PAGE_SIZE) {
  safeInteger(name, value, alignment);
  if (value % alignment !== 0) throw new TypeError(`${name} must be aligned to ${alignment} bytes.`);
  return value;
}

function asView(input) {
  if (input instanceof DataView) return input;
  if (ArrayBuffer.isView(input)) return new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new DataView(input);
  throw new TypeError('Expected an ArrayBuffer, DataView, Buffer, or typed array.');
}

export function createKernelSchedulerManifest(options = {}) {
  const platform = createKernelPlatformManifest(options);
  const source = { ...DEFAULT_KERNEL_SCHEDULER_LAYOUT, ...(options.schedulerLayout ?? {}) };
  const layout = {
    perCpu: aligned('perCpu', source.perCpu),
    perCpuSize: aligned('perCpuSize', source.perCpuSize),
    taskTable: aligned('taskTable', source.taskTable),
    taskTableSize: aligned('taskTableSize', source.taskTableSize),
    schedulerScratch: aligned('schedulerScratch', source.schedulerScratch),
    schedulerScratchSize: aligned('schedulerScratchSize', source.schedulerScratchSize),
    slabMetadata: aligned('slabMetadata', source.slabMetadata),
    slabMetadataSize: aligned('slabMetadataSize', source.slabMetadataSize),
    timerScratch: aligned('timerScratch', source.timerScratch),
    timerScratchSize: aligned('timerScratchSize', source.timerScratchSize),
  };
  const regions = [
    ...platform.regions,
    { name: 'perCpu', start: layout.perCpu, end: layout.perCpu + layout.perCpuSize },
    { name: 'taskTable', start: layout.taskTable, end: layout.taskTable + layout.taskTableSize },
    { name: 'schedulerScratch', start: layout.schedulerScratch, end: layout.schedulerScratch + layout.schedulerScratchSize },
    { name: 'slabMetadata', start: layout.slabMetadata, end: layout.slabMetadata + layout.slabMetadataSize },
    { name: 'timerScratch', start: layout.timerScratch, end: layout.timerScratch + layout.timerScratchSize },
  ].sort((left, right) => left.start - right.start);
  for (let index = 1; index < regions.length; index++) {
    if (regions[index].start < regions[index - 1].end) {
      throw new TypeError(`Kernel scheduler regions overlap: ${regions[index - 1].name} and ${regions[index].name}.`);
    }
  }
  if (regions.at(-1).end > platform.layout.heap) {
    throw new TypeError('Scheduler metadata must remain below the kernel heap.');
  }
  const maxTasks = Math.floor(layout.taskTableSize / 128);
  const maxCpus = Math.floor(layout.perCpuSize / 128);
  if (maxTasks < 64) throw new TypeError('taskTableSize must hold at least 64 tasks.');
  if (maxCpus < 1) throw new TypeError('perCpuSize must hold at least one CPU record.');
  return Object.freeze({
    ...platform,
    schedulerLayout: Object.freeze(layout),
    maxTasks,
    maxCpus,
    priorities: 4,
    defaultQuantum: 5,
    slabClasses: Object.freeze([32, 64, 128, 256, 512, 1024, 2048]),
    regions: Object.freeze(regions.map(region => Object.freeze(region))),
    features: Object.freeze({
      ...platform.features,
      ticketSpinlocks: true,
      interruptSafeLocks: true,
      perCpuStorage: true,
      hpetClock: true,
      localApicTimer: true,
      slabAllocator: true,
      kernelThreads: true,
      cooperativeContextSwitch: true,
      timerDrivenRescheduleRequests: true,
      priorityRoundRobinScheduler: true,
    }),
  });
}

export function parseAcpiHpet(input, offset = 0) {
  const view = asView(input);
  safeInteger('offset', offset, 0);
  if (offset + 56 > view.byteLength) throw new RangeError('HPET table is truncated.');
  if (view.getUint32(offset, true) !== HPET_SIGNATURE) throw new TypeError('ACPI table is not an HPET table.');
  const length = view.getUint32(offset + 4, true);
  if (length < 56 || offset + length > view.byteLength) throw new RangeError('Invalid HPET table length.');
  let checksum = 0;
  for (let index = 0; index < length; index++) checksum = (checksum + view.getUint8(offset + index)) & 0xFF;
  if (checksum !== 0) throw new TypeError('HPET checksum is invalid.');
  return Object.freeze({
    length,
    eventTimerBlockId: view.getUint32(offset + 36, true),
    addressSpace: view.getUint8(offset + 40),
    registerBitWidth: view.getUint8(offset + 41),
    registerBitOffset: view.getUint8(offset + 42),
    accessSize: view.getUint8(offset + 43),
    address: view.getBigUint64(offset + 44, true),
    number: view.getUint8(offset + 52),
    minimumTick: view.getUint16(offset + 53, true),
    pageProtection: view.getUint8(offset + 55),
  });
}

export class TicketSpinLockModel {
  constructor() {
    this.next = 0;
    this.owner = 0;
  }
  reserve() {
    const ticket = this.next;
    this.next++;
    return ticket;
  }
  canEnter(ticket) {
    return ticket === this.owner;
  }
  release() {
    this.owner++;
  }
  get queued() {
    return this.next - this.owner;
  }
}

export class SlabAllocatorModel {
  constructor(classes = [32, 64, 128, 256, 512, 1024, 2048], pageSize = PAGE_SIZE) {
    this.classes = classes.slice();
    this.pageSize = pageSize;
    this.nextAddress = 0x100000;
    this.freeLists = new Map(this.classes.map(size => [size, []]));
    this.allocations = new Map();
  }
  classFor(bytes) {
    return this.classes.find(size => bytes <= size) ?? null;
  }
  allocate(bytes) {
    const size = this.classFor(bytes);
    if (!size) return 0;
    const list = this.freeLists.get(size);
    if (!list.length) {
      const count = Math.floor(this.pageSize / size);
      const base = this.nextAddress;
      this.nextAddress += this.pageSize;
      for (let index = count - 1; index >= 0; index--) list.push(base + index * size);
    }
    const address = list.pop();
    this.allocations.set(address, size);
    return address;
  }
  free(address) {
    const size = this.allocations.get(address);
    if (!size) return false;
    this.allocations.delete(address);
    this.freeLists.get(size).push(address);
    return true;
  }
}

export class PriorityRoundRobinSchedulerModel {
  constructor(options = {}) {
    this.priorities = safeInteger('priorities', options.priorities ?? 4, 1);
    this.quantum = safeInteger('quantum', options.quantum ?? 5, 1);
    this.tasks = [];
    this.cursor = Array(this.priorities).fill(-1);
    this.ticks = 0;
    this.current = null;
  }
  spawn(entry, priority = 1) {
    if (!Number.isInteger(priority) || priority < 0 || priority >= this.priorities) throw new RangeError('Invalid task priority.');
    const task = { id: this.tasks.length, entry, priority, state: 'ready', quantum: this.quantum, wakeTick: 0, runs: 0 };
    this.tasks.push(task);
    return task.id;
  }
  sleep(id, ticks) {
    const task = this.tasks[id];
    if (!task) return false;
    task.state = 'sleeping';
    task.wakeTick = this.ticks + ticks;
    if (this.current === id) this.current = null;
    return true;
  }
  wake(id) {
    const task = this.tasks[id];
    if (!task || (task.state !== 'sleeping' && task.state !== 'blocked')) return false;
    task.state = 'ready';
    task.wakeTick = 0;
    return true;
  }
  exit(id) {
    const task = this.tasks[id];
    if (!task) return false;
    task.state = 'dead';
    if (this.current === id) this.current = null;
    return true;
  }
  tick() {
    this.ticks++;
    for (const task of this.tasks) if (task.state === 'sleeping' && task.wakeTick <= this.ticks) task.state = 'ready';
    if (this.current !== null) {
      const task = this.tasks[this.current];
      task.quantum--;
      if (task.quantum <= 0) {
        task.state = 'ready';
        this.current = null;
      }
    }
    return this.pick();
  }
  yield() {
    if (this.current !== null) {
      const task = this.tasks[this.current];
      if (task.state === 'running') task.state = 'ready';
      this.current = null;
    }
    return this.pick();
  }
  pick() {
    if (this.current !== null) return this.current;
    for (let priority = 0; priority < this.priorities; priority++) {
      for (let count = 0; count < this.tasks.length; count++) {
        const index = (this.cursor[priority] + 1 + count) % Math.max(this.tasks.length, 1);
        const task = this.tasks[index];
        if (task && task.priority === priority && task.state === 'ready') {
          this.cursor[priority] = index;
          task.state = 'running';
          task.quantum = this.quantum;
          task.runs++;
          this.current = index;
          return index;
        }
      }
    }
    return null;
  }
}

export function createContextSwitchAssembly() {
  return `/* SPDX-License-Identifier: MIT OR Apache-2.0 */
.text
.code64
.global kura_context_switch
.type kura_context_switch, @function
kura_context_switch:
  pushq %rbp
  pushq %rbx
  pushq %r12
  pushq %r13
  pushq %r14
  pushq %r15
  movq %rsp, (%rdi)
  movq %rsi, %rsp
  popq %r15
  popq %r14
  popq %r13
  popq %r12
  popq %rbx
  popq %rbp
  retq
.size kura_context_switch, .-kura_context_switch
`;
}

function hex(value) {
  return `0x${BigInt(value).toString(16).toUpperCase()}`;
}

function schedulerConstants(manifest, options) {
  const layout = manifest.schedulerLayout;
  return `const PER_CPU_BASE: usize = ${hex(layout.perCpu)}
const PER_CPU_BYTES: usize = ${hex(layout.perCpuSize)}
const PER_CPU_STRIDE: usize = 128
const MAX_CPUS: usize = PER_CPU_BYTES / PER_CPU_STRIDE
const TASK_TABLE_BASE: usize = ${hex(layout.taskTable)}
const TASK_TABLE_BYTES: usize = ${hex(layout.taskTableSize)}
const TASK_STRIDE: usize = 128
const MAX_TASKS: usize = TASK_TABLE_BYTES / TASK_STRIDE
const SCHEDULER_SCRATCH: usize = ${hex(layout.schedulerScratch)}
const SCHEDULER_LOCK: usize = SCHEDULER_SCRATCH
const TASK_ID_COUNTER: usize = SCHEDULER_SCRATCH + 16
const RUN_QUEUE_CURSORS: usize = SCHEDULER_SCRATCH + 32
const SLAB_METADATA: usize = ${hex(layout.slabMetadata)}
const SLAB_CLASS_STRIDE: usize = 64
const SLAB_CLASS_COUNT: usize = 7
const TIMER_SCRATCH: usize = ${hex(layout.timerScratch)}
const HPET_SIGNATURE: u32 = 0x54455048
const HPET_GENERAL_CAPABILITIES: usize = 0
const HPET_GENERAL_CONFIGURATION: usize = 0x10
const HPET_MAIN_COUNTER: usize = 0xF0
const APIC_LVT_TIMER: usize = 0x320
const APIC_TIMER_INITIAL: usize = 0x380
const APIC_TIMER_CURRENT: usize = 0x390
const APIC_TIMER_DIVIDE: usize = 0x3E0
const TIMER_VECTOR: u32 = 32
const TIMER_HZ: u64 = ${safeInteger('timerHz', options.timerHz ?? 100, 10)}
const DEFAULT_QUANTUM: u32 = ${safeInteger('quantum', options.quantum ?? 5, 1)}
const TASK_FREE: u32 = 0
const TASK_READY: u32 = 1
const TASK_RUNNING: u32 = 2
const TASK_BLOCKED: u32 = 3
const TASK_SLEEPING: u32 = 4
const TASK_DEAD: u32 = 5
const PRIORITY_COUNT: u32 = 4
const SMOKE_MODE: u8 = ${options.smoke ? 1 : 0}
const SMOKE_EXIT_CODE: u32 = ${safeInteger('smokeExitCode', options.smokeExitCode ?? 0x10, 0)}`;
}

function schedulerGlobals() {
  return `static mut SCHEDULER_READY: u8 = 0
static mut SCHEDULER_TICKS: u64 = 0
static mut SCHEDULER_SWITCHES: u64 = 0
static mut HPET_BASE: usize = 0
static mut HPET_PERIOD_FS: u64 = 0
static mut LAPIC_TIMER_TICKS: u32 = 0
static mut SLAB_PAGES: usize = 0
static mut SLAB_OBJECTS: usize = 0
static mut THREADS_CREATED: usize = 0
static mut THREADS_EXITED: usize = 0
static mut SMOKE_WORKERS_DONE: u32 = 0`;
}

function schedulerRuntime() {
  return `extern "C" fn kura_context_switch(old_stack: *mut usize, new_stack: usize);

unsafe fn irq_save() -> u64 {
    let flags: u64 = cpu.read_rflags()
    cpu.disable_interrupts()
    return flags
}

unsafe fn irq_restore(flags: u64) {
    if (flags & 0x200) != 0 {
        cpu.enable_interrupts()
    }
}

unsafe fn ticket_lock(address: usize) -> u32 {
    let ticket: u32 = atomic.fetch_add<u32>(address, 1)
    while atomic.load<u32>(address + 4) != ticket {
        cpu.pause()
    }
    atomic.fence()
    return ticket
}

unsafe fn ticket_unlock(address: usize) {
    atomic.fence()
    atomic.fetch_add<u32>(address + 4, 1)
}

unsafe fn spin_lock_irqsave(address: usize) -> u64 {
    let flags: u64 = irq_save()
    ticket_lock(address)
    return flags
}

unsafe fn spin_unlock_irqrestore(address: usize, flags: u64) {
    ticket_unlock(address)
    irq_restore(flags)
}

fn task_address(task_id: u32) -> usize {
    return TASK_TABLE_BASE + task_id * TASK_STRIDE
}

fn per_cpu_address(index: u32) -> usize {
    return PER_CPU_BASE + index * PER_CPU_STRIDE
}

unsafe fn current_apic_id() -> u32 {
    if LOCAL_APIC_BASE == 0 {
        return 0
    }
    return local_apic_read(APIC_ID) >> 24
}

unsafe fn current_cpu_index() -> u32 {
    let apic_id: u32 = current_apic_id()
    let index: u32 = 0
    while index < CPU_COUNT {
        if memory.read<u32>(CPU_TABLE + index * 4) == apic_id {
            return index
        }
        index += 1
    }
    return 0
}

unsafe fn current_cpu() -> usize {
    return per_cpu_address(current_cpu_index())
}

unsafe fn task_state(task_id: u32) -> u32 {
    return memory.read<u32>(task_address(task_id) + 4)
}

unsafe fn task_set_state(task_id: u32, state: u32) {
    memory.write<u32>(task_address(task_id) + 4, state)
}

unsafe fn scheduler_metadata_init() {
    zero_region(PER_CPU_BASE, PER_CPU_BYTES)
    zero_region(TASK_TABLE_BASE, TASK_TABLE_BYTES)
    zero_region(SCHEDULER_SCRATCH, 0x10000)
    atomic.store<u32>(SCHEDULER_LOCK, 0)
    atomic.store<u32>(SCHEDULER_LOCK + 4, 0)
    atomic.store<u32>(TASK_ID_COUNTER, 1)
    let priority: usize = 0
    while priority < PRIORITY_COUNT {
        memory.write<u32>(RUN_QUEUE_CURSORS + priority * 4, 0)
        priority += 1
    }
}

unsafe fn scheduler_register_boot_cpu() {
    let cpu_index: u32 = current_cpu_index()
    let cpu: usize = per_cpu_address(cpu_index)
    let task_id: u32 = atomic.fetch_add<u32>(TASK_ID_COUNTER, 1)
    let task: usize = task_address(task_id)
    zero_region(task, TASK_STRIDE)
    memory.write<u32>(task, task_id)
    memory.write<u32>(task + 4, TASK_RUNNING)
    memory.write<u32>(task + 8, 3)
    memory.write<u32>(task + 12, DEFAULT_QUANTUM)
    memory.write<u32>(task + 56, cpu_index)
    memory.write<u32>(cpu, task_id)
    memory.write<u32>(cpu + 32, current_apic_id())
    memory.write<u32>(cpu + 36, 1)
}

unsafe fn initialize_thread_stack(stack_base: usize, stack_bytes: usize) -> usize {
    let stack_top: usize = align_down(stack_base + stack_bytes, 16)
    let saved: usize = stack_top - 56
    memory.write<u64>(saved, 0)
    memory.write<u64>(saved + 8, 0)
    memory.write<u64>(saved + 16, 0)
    memory.write<u64>(saved + 24, 0)
    memory.write<u64>(saved + 32, 0)
    memory.write<u64>(saved + 40, 0)
    memory.write<u64>(saved + 48, function.address(thread_bootstrap))
    return saved
}

pub unsafe fn spawn_kernel_thread(entry: usize, priority: u32, stack_bytes: usize) -> u32 {
    if entry == 0 || priority >= PRIORITY_COUNT || stack_bytes < PAGE_SIZE {
        return 0
    }
    let flags: u64 = spin_lock_irqsave(SCHEDULER_LOCK)
    let task_id: u32 = atomic.fetch_add<u32>(TASK_ID_COUNTER, 1)
    if task_id >= MAX_TASKS {
        spin_unlock_irqrestore(SCHEDULER_LOCK, flags)
        return 0
    }
    let stack: usize = heap_alloc(align_up(stack_bytes, PAGE_SIZE), 16)
    if stack == 0 {
        spin_unlock_irqrestore(SCHEDULER_LOCK, flags)
        return 0
    }
    let task: usize = task_address(task_id)
    zero_region(task, TASK_STRIDE)
    memory.write<u32>(task, task_id)
    memory.write<u32>(task + 4, TASK_READY)
    memory.write<u32>(task + 8, priority)
    memory.write<u32>(task + 12, DEFAULT_QUANTUM)
    memory.write<u64>(task + 16, initialize_thread_stack(stack, stack_bytes))
    memory.write<u64>(task + 24, stack)
    memory.write<u64>(task + 32, stack_bytes)
    memory.write<u64>(task + 40, entry)
    THREADS_CREATED += 1
    spin_unlock_irqrestore(SCHEDULER_LOCK, flags)
    return task_id
}

unsafe fn scheduler_wake_sleepers() {
    let task_id: u32 = 1
    while task_id < MAX_TASKS {
        let task: usize = task_address(task_id)
        if memory.read<u32>(task + 4) == TASK_SLEEPING && memory.read<u64>(task + 48) <= SCHEDULER_TICKS {
            memory.write<u32>(task + 4, TASK_READY)
            memory.write<u64>(task + 48, 0)
        }
        task_id += 1
    }
}

unsafe fn scheduler_pick_next(current: u32) -> u32 {
    let priority: u32 = 0
    while priority < PRIORITY_COUNT {
        let cursor_address: usize = RUN_QUEUE_CURSORS + priority * 4
        let cursor: u32 = memory.read<u32>(cursor_address)
        let scanned: u32 = 0
        while scanned < MAX_TASKS {
            cursor += 1
            if cursor >= MAX_TASKS {
                cursor = 1
            }
            let task: usize = task_address(cursor)
            if memory.read<u32>(task + 4) == TASK_READY && memory.read<u32>(task + 8) == priority {
                memory.write<u32>(cursor_address, cursor)
                return cursor
            }
            scanned += 1
        }
        priority += 1
    }
    return current
}

pub unsafe fn scheduler_yield() {
    if SCHEDULER_READY == 0 {
        return
    }
    let interrupt_flags: u64 = irq_save()
    ticket_lock(SCHEDULER_LOCK)
    let cpu: usize = current_cpu()
    let current_id: u32 = memory.read<u32>(cpu)
    let current: usize = task_address(current_id)
    if memory.read<u32>(current + 4) == TASK_RUNNING {
        memory.write<u32>(current + 4, TASK_READY)
    }
    scheduler_wake_sleepers()
    let next_id: u32 = scheduler_pick_next(current_id)
    let next: usize = task_address(next_id)
    memory.write<u32>(next + 4, TASK_RUNNING)
    memory.write<u32>(next + 12, DEFAULT_QUANTUM)
    memory.write<u32>(next + 56, current_cpu_index())
    memory.write<u32>(cpu, next_id)
    memory.write<u32>(cpu + 12, 0)
    if next_id == current_id {
        ticket_unlock(SCHEDULER_LOCK)
        irq_restore(interrupt_flags)
        return
    }
    memory.write<u64>(current + 72, memory.read<u64>(current + 72) + 1)
    memory.write<u64>(next + 72, memory.read<u64>(next + 72) + 1)
    memory.write<u64>(cpu + 24, memory.read<u64>(cpu + 24) + 1)
    SCHEDULER_SWITCHES += 1
    let new_stack: usize = memory.read<u64>(next + 16)
    ticket_unlock(SCHEDULER_LOCK)
    let old_stack: *mut usize = pointer.from_address<usize>(current + 16)
    kura_context_switch(old_stack, new_stack)
    irq_restore(interrupt_flags)
}

pub unsafe fn scheduler_poll() {
    let cpu: usize = current_cpu()
    if memory.read<u32>(cpu + 12) != 0 && memory.read<u32>(cpu + 8) == 0 {
        scheduler_yield()
    }
}

pub unsafe fn thread_sleep(ticks: u64) {
    let flags: u64 = spin_lock_irqsave(SCHEDULER_LOCK)
    let cpu: usize = current_cpu()
    let task_id: u32 = memory.read<u32>(cpu)
    let task: usize = task_address(task_id)
    memory.write<u64>(task + 48, SCHEDULER_TICKS + ticks)
    memory.write<u32>(task + 4, TASK_SLEEPING)
    spin_unlock_irqrestore(SCHEDULER_LOCK, flags)
    scheduler_yield()
}

pub unsafe fn thread_block() {
    let flags: u64 = spin_lock_irqsave(SCHEDULER_LOCK)
    let task_id: u32 = memory.read<u32>(current_cpu())
    task_set_state(task_id, TASK_BLOCKED)
    spin_unlock_irqrestore(SCHEDULER_LOCK, flags)
    scheduler_yield()
}

pub unsafe fn thread_wake(task_id: u32) -> bool {
    if task_id == 0 || task_id >= MAX_TASKS {
        return false
    }
    let flags: u64 = spin_lock_irqsave(SCHEDULER_LOCK)
    let state: u32 = task_state(task_id)
    let result: bool = false
    if state == TASK_BLOCKED || state == TASK_SLEEPING {
        task_set_state(task_id, TASK_READY)
        result = true
    }
    spin_unlock_irqrestore(SCHEDULER_LOCK, flags)
    return result
}

pub unsafe fn thread_exit() -> never {
    let flags: u64 = spin_lock_irqsave(SCHEDULER_LOCK)
    let task_id: u32 = memory.read<u32>(current_cpu())
    task_set_state(task_id, TASK_DEAD)
    THREADS_EXITED += 1
    spin_unlock_irqrestore(SCHEDULER_LOCK, flags)
    scheduler_yield()
    cpu.halt()
}

unsafe fn thread_bootstrap() -> never {
    cpu.enable_interrupts()
    let task_id: u32 = memory.read<u32>(current_cpu())
    let entry: usize = memory.read<u64>(task_address(task_id) + 40)
    function.call0(entry)
    thread_exit()
}

unsafe fn slab_class_for(bytes: usize) -> usize {
    if bytes <= 32 { return 0 }
    if bytes <= 64 { return 1 }
    if bytes <= 128 { return 2 }
    if bytes <= 256 { return 3 }
    if bytes <= 512 { return 4 }
    if bytes <= 1024 { return 5 }
    if bytes <= 2048 { return 6 }
    return SLAB_CLASS_COUNT
}

unsafe fn slab_object_size(class_id: usize) -> usize {
    return 32 << class_id
}

unsafe fn slab_metadata_address(class_id: usize) -> usize {
    return SLAB_METADATA + class_id * SLAB_CLASS_STRIDE
}

unsafe fn slab_init() {
    zero_region(SLAB_METADATA, SLAB_CLASS_COUNT * SLAB_CLASS_STRIDE)
    let class_id: usize = 0
    while class_id < SLAB_CLASS_COUNT {
        let metadata: usize = slab_metadata_address(class_id)
        memory.write<u32>(metadata, slab_object_size(class_id))
        atomic.store<u32>(metadata + 32, 0)
        atomic.store<u32>(metadata + 36, 0)
        class_id += 1
    }
}

unsafe fn slab_refill(class_id: usize) -> bool {
    let frame: usize = alloc_frame()
    if frame == 0 {
        return false
    }
    zero_region(frame, PAGE_SIZE)
    let metadata: usize = slab_metadata_address(class_id)
    let object_size: usize = slab_object_size(class_id)
    let count: usize = PAGE_SIZE / object_size
    let index: usize = 0
    let head: usize = memory.read<u64>(metadata + 8)
    while index < count {
        let object: usize = frame + index * object_size
        memory.write<u64>(object, head)
        head = object
        index += 1
    }
    memory.write<u64>(metadata + 8, head)
    memory.write<u32>(metadata + 16, memory.read<u32>(metadata + 16) + count)
    memory.write<u32>(metadata + 20, memory.read<u32>(metadata + 20) + count)
    memory.write<u32>(metadata + 24, memory.read<u32>(metadata + 24) + 1)
    SLAB_PAGES += 1
    SLAB_OBJECTS += count
    return true
}

pub unsafe fn slab_alloc(bytes: usize) -> usize {
    let class_id: usize = slab_class_for(bytes)
    if class_id >= SLAB_CLASS_COUNT {
        return heap_alloc(bytes, 16)
    }
    let metadata: usize = slab_metadata_address(class_id)
    let flags: u64 = spin_lock_irqsave(metadata + 32)
    if memory.read<u64>(metadata + 8) == 0 && !slab_refill(class_id) {
        spin_unlock_irqrestore(metadata + 32, flags)
        return 0
    }
    let result: usize = memory.read<u64>(metadata + 8)
    memory.write<u64>(metadata + 8, memory.read<u64>(result))
    memory.write<u32>(metadata + 20, memory.read<u32>(metadata + 20) - 1)
    spin_unlock_irqrestore(metadata + 32, flags)
    return result
}

pub unsafe fn slab_free(address: usize, bytes: usize) -> bool {
    let class_id: usize = slab_class_for(bytes)
    if class_id >= SLAB_CLASS_COUNT {
        return heap_free(address)
    }
    if address == 0 || (address & 0x1F) != 0 {
        return false
    }
    let metadata: usize = slab_metadata_address(class_id)
    let flags: u64 = spin_lock_irqsave(metadata + 32)
    memory.write<u64>(address, memory.read<u64>(metadata + 8))
    memory.write<u64>(metadata + 8, address)
    memory.write<u32>(metadata + 20, memory.read<u32>(metadata + 20) + 1)
    spin_unlock_irqrestore(metadata + 32, flags)
    return true
}

unsafe fn hpet_init() -> bool {
    let table: usize = acpi_find_table(HPET_SIGNATURE)
    if table == 0 || memory.read<u8>(table + 40) != 0 {
        return false
    }
    HPET_BASE = memory.read<u64>(table + 44)
    if HPET_BASE == 0 || HPET_BASE >= MAX_PHYSICAL {
        HPET_BASE = 0
        return false
    }
    let capabilities: u64 = memory.volatile_read<u64>(HPET_BASE + HPET_GENERAL_CAPABILITIES)
    HPET_PERIOD_FS = capabilities >> 32
    if HPET_PERIOD_FS == 0 {
        HPET_BASE = 0
        return false
    }
    memory.volatile_write<u64>(HPET_BASE + HPET_GENERAL_CONFIGURATION, 0)
    memory.volatile_write<u64>(HPET_BASE + HPET_MAIN_COUNTER, 0)
    memory.volatile_write<u64>(HPET_BASE + HPET_GENERAL_CONFIGURATION, 1)
    return true
}

pub unsafe fn monotonic_ticks() -> u64 {
    if HPET_BASE != 0 {
        return memory.volatile_read<u64>(HPET_BASE + HPET_MAIN_COUNTER)
    }
    return SCHEDULER_TICKS
}

unsafe fn mask_legacy_timer() {
    if INTERRUPT_MODE == 2 && IOAPIC_BASE != 0 {
        let override: usize = IRQ_OVERRIDES
        let gsi: u32 = memory.read<u32>(override)
        if gsi >= IOAPIC_GSI_BASE {
            let pin: u32 = gsi - IOAPIC_GSI_BASE
            let low: u32 = ioapic_read(0x10 + pin * 2)
            ioapic_write(0x10 + pin * 2, low | 0x10000)
        }
    } else {
        io.out8(PIC1_DATA, io.in8(PIC1_DATA) | 1)
    }
}

unsafe fn init_pit_timer() {
    let divisor: u16 = 1193182 / TIMER_HZ
    io.out8(0x43, 0x36)
    io.out8(0x40, divisor & 0xFF)
    io.out8(0x40, divisor >> 8)
}

unsafe fn init_local_apic_timer() -> bool {
    if LOCAL_APIC_BASE == 0 || HPET_BASE == 0 {
        return false
    }
    local_apic_write(APIC_TIMER_DIVIDE, 3)
    local_apic_write(APIC_LVT_TIMER, 0x10000 | TIMER_VECTOR)
    local_apic_write(APIC_TIMER_INITIAL, 0xFFFFFFFF)
    let start: u64 = memory.volatile_read<u64>(HPET_BASE + HPET_MAIN_COUNTER)
    let delta: u64 = 10000000000000 / HPET_PERIOD_FS
    if delta == 0 {
        return false
    }
    while memory.volatile_read<u64>(HPET_BASE + HPET_MAIN_COUNTER) - start < delta {
        cpu.pause()
    }
    let elapsed: u32 = 0xFFFFFFFF - local_apic_read(APIC_TIMER_CURRENT)
    if elapsed < 1000 {
        return false
    }
    LAPIC_TIMER_TICKS = elapsed
    mask_legacy_timer()
    local_apic_write(APIC_TIMER_DIVIDE, 3)
    local_apic_write(APIC_LVT_TIMER, 0x20000 | TIMER_VECTOR)
    local_apic_write(APIC_TIMER_INITIAL, LAPIC_TIMER_TICKS)
    return true
}

unsafe fn scheduler_timer_init() {
    let has_hpet: bool = hpet_init()
    if !has_hpet || !init_local_apic_timer() {
        init_pit_timer()
    }
}

unsafe fn scheduler_timer_tick() {
    SCHEDULER_TICKS += 1
    if SCHEDULER_READY == 0 {
        return
    }
    let cpu: usize = current_cpu()
    memory.write<u64>(cpu + 16, memory.read<u64>(cpu + 16) + 1)
    let task_id: u32 = memory.read<u32>(cpu)
    if task_id != 0 {
        let task: usize = task_address(task_id)
        let quantum: u32 = memory.read<u32>(task + 12)
        memory.write<u64>(task + 64, memory.read<u64>(task + 64) + 1)
        if quantum > 1 {
            memory.write<u32>(task + 12, quantum - 1)
        } else {
            memory.write<u32>(task + 12, 0)
            memory.write<u32>(cpu + 12, 1)
        }
    }
}

unsafe fn scheduler_cpu_online() {
    let flags: u64 = spin_lock_irqsave(SCHEDULER_LOCK)
    scheduler_register_boot_cpu()
    spin_unlock_irqrestore(SCHEDULER_LOCK, flags)
}

unsafe fn scheduler_init() {
    scheduler_metadata_init()
    slab_init()
    scheduler_register_boot_cpu()
    scheduler_timer_init()
    SCHEDULER_READY = 1
}

unsafe fn scheduler_idle_loop() -> never {
    cpu.enable_interrupts()
    while true {
        scheduler_poll()
        scheduler_yield()
        if SMOKE_MODE != 0 && SMOKE_WORKERS_DONE >= 2 && SCHEDULER_SWITCHES >= 2 {
            io.out32(0xF4, SMOKE_EXIT_CODE)
        }
        cpu.wait_for_interrupt()
    }
}

unsafe fn smoke_worker_one() {
    let index: usize = 0
    while index < 4 {
        let object: usize = slab_alloc(64)
        if object != 0 {
            memory.write<u64>(object, index)
            slab_free(object, 64)
        }
        scheduler_yield()
        index += 1
    }
    atomic.fetch_add<u32>(TIMER_SCRATCH, 1)
    SMOKE_WORKERS_DONE += 1
}

unsafe fn smoke_worker_two() {
    let index: usize = 0
    while index < 4 {
        thread_sleep(1)
        index += 1
    }
    atomic.fetch_add<u32>(TIMER_SCRATCH + 4, 1)
    SMOKE_WORKERS_DONE += 1
}

unsafe fn background_worker() {
    while true {
        thread_sleep(TIMER_HZ)
        serial_write_byte(0x54)
    }
}`;
}

function replaceFunction(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Generated platform source is missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Generated platform source is missing marker: ${endMarker}`);
  return `${source.slice(0, start)}${replacement}\n\n${source.slice(end)}`;
}

export function createKernelSchedulerSource(options = {}) {
  const manifest = createKernelSchedulerManifest(options);
  let source = createKernelPlatformSource({ ...options, smoke: false });
  source = source.replace('static mut FRAME_SCAN_INDEX', `${schedulerConstants(manifest, options)}\n\nstatic mut FRAME_SCAN_INDEX`);
  source = source.replace('@repr(C)\nstruct InterruptFrame', `${schedulerGlobals()}\n\n@repr(C)\nstruct InterruptFrame`);
  source = source.replace('unsafe fn exception_stop', `${schedulerRuntime()}\n\nunsafe fn exception_stop`);
  source = replaceFunction(
    source,
    '@link_name("kura_ap_main")',
    'unsafe fn smp_start_processor',
    `@link_name("kura_ap_main")
pub unsafe extern "C" fn application_processor_main(apic_id: u32) -> never {
    cpu.disable_interrupts()
    cpu.load_gdt(GDT_DESCRIPTOR)
    cpu.reload_kernel_segments()
    cpu.load_idt(IDT_DESCRIPTOR)
    init_local_apic()
    SMP_ONLINE_CPUS += 1
    memory.volatile_write<u32>(SMP_MAILBOX + 28, 1)
    scheduler_cpu_online()
    serial_write_byte(0x41)
    scheduler_idle_loop()
}`,
  );
  source = replaceFunction(
    source,
    '@interrupt\npub unsafe extern "x86-interrupt" fn timer_interrupt',
    '@interrupt\npub unsafe extern "x86-interrupt" fn keyboard_interrupt',
    `@interrupt
pub unsafe extern "x86-interrupt" fn timer_interrupt(frame: *mut InterruptFrame) {
    TIMER_TICKS += 1
    scheduler_timer_tick()
    interrupt_eoi(0)
}`,
  );
  const entry = source.lastIndexOf('@entry\npub unsafe extern "C" fn kernel_main');
  if (entry < 0) throw new Error('Generated platform source has no kernel_main entry.');
  const workerSetup = options.smoke
    ? `    spawn_kernel_thread(function.address(smoke_worker_one), 1, 0x8000)\n    spawn_kernel_thread(function.address(smoke_worker_two), 1, 0x8000)`
    : `    spawn_kernel_thread(function.address(background_worker), 2, 0x8000)`;
  source = `${source.slice(0, entry)}@entry
pub unsafe extern "C" fn kernel_main() -> never {
    cpu.disable_interrupts()
    serial_init()
    serial_write_byte(0x42)
    init_gdt()
    init_idt()
    init_identity_paging()
    page_table_pool_init()
    let boot_info: usize = kura_boot_info()
    memory_init_from_multiboot(boot_info)
    heap_init()
    platform_interrupts_init()
    scheduler_init()
    smp_start_all()
${workerSetup}
    serial_write_byte(0x4B)
    scheduler_idle_loop()
}
`;
  return source;
}

export function createSchedulerBuildPlan(options = {}) {
  const plan = createNativeBuildPlan(options);
  return {
    ...plan,
    schedulerAssembly: path.join(plan.outDir, 'kura-context-switch.S'),
    schedulerObject: path.join(plan.outDir, 'kura-context-switch.o'),
  };
}

async function run(command, args, options = {}) {
  if (options.dryRun) return { command, args, code: 0, dryRun: true };
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve({ command, args, code, stdout, stderr });
      else reject(new Error(`Command failed (${code}): ${command} ${args.join(' ')}\n${stderr}`));
    });
  });
}

export async function emitSchedulerSupportObject(options = {}) {
  const plan = options.plan ?? createSchedulerBuildPlan(options);
  const tools = options.tools ?? detectNativeToolchain();
  await mkdir(plan.outDir, { recursive: true });
  const assembly = createContextSwitchAssembly();
  if (!options.dryRun) await writeFile(plan.schedulerAssembly, assembly, 'utf8');
  let step;
  if (tools.clang) {
    step = await run(tools.clang.command, [
      '-target', plan.target,
      '-ffreestanding', '-fno-stack-protector', '-fno-pic', '-mno-red-zone',
      '-c', plan.schedulerAssembly, '-o', plan.schedulerObject,
    ], options);
  } else if (tools.assembler) {
    step = await run(tools.assembler.command, ['--64', '-o', plan.schedulerObject, plan.schedulerAssembly], options);
  } else if (options.dryRun) {
    step = await run('clang', ['-target', plan.target, '-c', plan.schedulerAssembly, '-o', plan.schedulerObject], options);
  } else {
    throw new Error('clang or GNU as is required for context-switch assembly.');
  }
  return { plan, assembly, step };
}

export async function buildSchedulerKernel(source, options = {}) {
  const plan = options.plan ?? createSchedulerBuildPlan({
    ...options,
    entry: options.entry ?? 'kura_boot_entry',
    kernelEntry: options.kernelEntry ?? 'kernel_main',
  });
  const tools = options.tools ?? detectNativeToolchain();
  const objectResult = await emitNativeObject(source, { ...options, plan, tools });
  const bootstrapResult = await emitNativeBootstrapObject({ ...options, plan, tools, kernelEntry: plan.kernelEntry });
  const schedulerResult = await emitSchedulerSupportObject({ ...options, plan, tools });
  const linkResult = await linkNativeElf(
    [plan.bootstrapObject, plan.schedulerObject, plan.object],
    { ...options, plan, tools },
  );
  return { plan, tools, objectResult, bootstrapResult, schedulerResult, linkResult };
}
