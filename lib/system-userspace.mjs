// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createKernelSchedulerSource, createSchedulerBuildPlan, emitSchedulerSupportObject } from './system-kernel-scheduler.mjs';
import { detectNativeToolchain, emitNativeBootstrapObject, emitNativeObject, linkNativeElf } from './system-native-toolchain.mjs';

const PAGE_SIZE = 0x1000;
const USER_MIN = 0x0000000000400000;
const USER_MAX = 0x00007FFFFFFFF000;

function safeInteger(name, value, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer >= ${minimum}.`); return value; }
function aligned(name, value, alignment = PAGE_SIZE) { safeInteger(name, value, alignment); if (value % alignment) throw new TypeError(`${name} must be aligned to ${alignment}.`); return value; }
function asView(input) { if (input instanceof DataView) return input; if (ArrayBuffer.isView(input)) return new DataView(input.buffer, input.byteOffset, input.byteLength); if (input instanceof ArrayBuffer) return new DataView(input); throw new TypeError('Expected a Buffer, typed array, DataView, or ArrayBuffer.'); }
function alignUp(value, alignment) { return Math.ceil(value / alignment) * alignment; }
function checksum16(bytes) { let sum = 0; for (let index = 0; index < bytes.length; index += 2) sum += (bytes[index] << 8) | (bytes[index + 1] ?? 0); while (sum >>> 16) sum = (sum & 0xFFFF) + (sum >>> 16); return (~sum) & 0xFFFF; }

export const DEFAULT_USERSPACE_LAYOUT = Object.freeze({
  tss: 0xB00000,
  kernelSyscallStack: 0xB10000,
  kernelSyscallStackSize: 0x10000,
  processTable: 0xB20000,
  processTableSize: 0x20000,
  fileTable: 0xB40000,
  fileTableSize: 0x20000,
  syscallTable: 0xB60000,
  syscallTableSize: 0x1000,
  userPageTablePool: 0xC00000,
  userPageTablePoolSize: 0x200000,
  userImageBase: USER_MIN,
  userStackTop: 0x00007FFFFFF00000,
  userStackSize: 0x100000,
  maxProcesses: 256,
  maxFilesPerProcess: 128,
});

export function createUserspaceManifest(options = {}) {
  const source = { ...DEFAULT_USERSPACE_LAYOUT, ...(options.layout ?? options) };
  const layout = {
    tss: aligned('tss', source.tss, 16),
    kernelSyscallStack: aligned('kernelSyscallStack', source.kernelSyscallStack),
    kernelSyscallStackSize: aligned('kernelSyscallStackSize', source.kernelSyscallStackSize),
    processTable: aligned('processTable', source.processTable), processTableSize: aligned('processTableSize', source.processTableSize),
    fileTable: aligned('fileTable', source.fileTable), fileTableSize: aligned('fileTableSize', source.fileTableSize),
    syscallTable: aligned('syscallTable', source.syscallTable), syscallTableSize: aligned('syscallTableSize', source.syscallTableSize),
    userPageTablePool: aligned('userPageTablePool', source.userPageTablePool), userPageTablePoolSize: aligned('userPageTablePoolSize', source.userPageTablePoolSize),
    userImageBase: aligned('userImageBase', source.userImageBase), userStackTop: aligned('userStackTop', source.userStackTop), userStackSize: aligned('userStackSize', source.userStackSize),
    maxProcesses: safeInteger('maxProcesses', source.maxProcesses, 1), maxFilesPerProcess: safeInteger('maxFilesPerProcess', source.maxFilesPerProcess, 1),
  };
  if (layout.userImageBase < USER_MIN || layout.userImageBase >= USER_MAX) throw new TypeError('userImageBase is outside canonical user space.');
  if (layout.userStackTop <= layout.userImageBase || layout.userStackTop > USER_MAX) throw new TypeError('userStackTop is outside canonical user space.');
  const regions = [
    ['tss', layout.tss, layout.tss + PAGE_SIZE], ['kernelSyscallStack', layout.kernelSyscallStack, layout.kernelSyscallStack + layout.kernelSyscallStackSize],
    ['processTable', layout.processTable, layout.processTable + layout.processTableSize], ['fileTable', layout.fileTable, layout.fileTable + layout.fileTableSize],
    ['syscallTable', layout.syscallTable, layout.syscallTable + layout.syscallTableSize], ['userPageTablePool', layout.userPageTablePool, layout.userPageTablePool + layout.userPageTablePoolSize],
  ].map(([name, start, end]) => ({ name, start, end })).sort((a, b) => a.start - b.start);
  for (let index = 1; index < regions.length; index++) if (regions[index].start < regions[index - 1].end) throw new TypeError(`Userspace regions overlap: ${regions[index - 1].name} and ${regions[index].name}.`);
  return Object.freeze({
    architecture: 'x86_64', target: 'x86_64-unknown-none', pageSize: PAGE_SIZE,
    selectors: Object.freeze({ kernelCode: 0x08, kernelData: 0x10, userData: 0x1B, userCode: 0x23, tss: 0x28 }),
    syscallMsrs: Object.freeze({ efer: 0xC0000080, star: 0xC0000081, lstar: 0xC0000082, fmask: 0xC0000084 }),
    syscalls: Object.freeze({ exit: 0, write: 1, read: 2, open: 3, close: 4, yield: 5, sleep: 6, mmap: 7, munmap: 8, spawn: 9, wait: 10, getpid: 11, clock: 12 }),
    layout: Object.freeze(layout), regions: Object.freeze(regions),
    features: Object.freeze({ ring3: true, tss: true, syscallSysret: true, processes: true, elf64Loader: true, virtualFileSystem: true, pci: true, virtio: true, ipv4: true, udp: true, tcpStateMachine: true }),
  });
}

export function createUserspaceAssembly(options = {}) {
  const manifest = createUserspaceManifest(options);
  return `.text
.code64

.global kura_syscall_entry
.type kura_syscall_entry,@function
.extern kura_syscall_dispatch
.extern kura_current_kernel_stack
kura_syscall_entry:
  swapgs
  mov %rsp, %gs:0
  mov kura_current_kernel_stack(%rip), %rsp
  pushq $0x1B
  pushq %gs:0
  pushq %r11
  pushq $0x23
  pushq %rcx
  pushq %rax
  pushq %rdi
  pushq %rsi
  pushq %rdx
  pushq %r10
  pushq %r8
  pushq %r9
  mov %rax, %rdi
  mov %r10, %rcx
  call kura_syscall_dispatch
  popq %r9
  popq %r8
  popq %r10
  popq %rdx
  popq %rsi
  popq %rdi
  addq $8, %rsp
  popq %rcx
  addq $8, %rsp
  popq %r11
  popq %rsp
  addq $8, %rsp
  swapgs
  sysretq
.size kura_syscall_entry, .-kura_syscall_entry

.global kura_enter_userspace
.type kura_enter_userspace,@function
# rdi = RIP, rsi = RSP, rdx = argc, rcx = argv
kura_enter_userspace:
  cli
  mov $${manifest.selectors.userData}, %ax
  mov %ax, %ds
  mov %ax, %es
  pushq $${manifest.selectors.userData}
  pushq %rsi
  pushfq
  orq $0x200, (%rsp)
  pushq $${manifest.selectors.userCode}
  pushq %rdi
  mov %rdx, %rdi
  mov %rcx, %rsi
  iretq
.size kura_enter_userspace, .-kura_enter_userspace

.global kura_switch_address_space
.type kura_switch_address_space,@function
kura_switch_address_space:
  mov %rdi, %cr3
  ret
.size kura_switch_address_space, .-kura_switch_address_space
`;
}

export function createUserspaceKernelSource(options = {}) {
  const manifest = createUserspaceManifest(options); const L = manifest.layout; const S = manifest.selectors;
  const header = options.fragment ? '' : '#![target("x86_64-unknown-none")]\n#![no_std]\n\n';
  const schedulerExterns = options.fragment ? '' : 'extern "C" fn scheduler_yield();\nextern "C" fn thread_sleep(ticks: u64);\nextern "C" fn thread_exit();\nextern "C" fn serial_write_byte(value: u8);\n';
  const zeroHelper = options.fragment ? '' : `unsafe fn zero_region(base: usize, bytes: usize) {
    let offset: usize = 0
    while offset + 8 <= bytes {
        memory.write<u64>(base + offset, 0)
        offset += 8
    }
    while offset < bytes {
        memory.write<u8>(base + offset, 0)
        offset += 1
    }
}
`;
  return `${header}const USER_DATA_SELECTOR: usize = ${S.userData}
const USER_CODE_SELECTOR: usize = ${S.userCode}
const TSS_SELECTOR: usize = ${S.tss}
const TSS_BASE: usize = ${L.tss}
const KERNEL_SYSCALL_STACK: usize = ${L.kernelSyscallStack + L.kernelSyscallStackSize}
const PROCESS_TABLE: usize = ${L.processTable}
const PROCESS_RECORD_SIZE: usize = 256
const MAX_PROCESSES: usize = ${L.maxProcesses}
const USER_IMAGE_BASE: usize = ${L.userImageBase}
const USER_STACK_TOP: usize = ${L.userStackTop}
const USER_STACK_SIZE: usize = ${L.userStackSize}
const IA32_EFER: u32 = 0xC0000080
const IA32_STAR: u32 = 0xC0000081
const IA32_LSTAR: u32 = 0xC0000082
const IA32_FMASK: u32 = 0xC0000084

static mut CURRENT_PID: u32 = 0
static mut NEXT_PID: u32 = 1
static mut KERNEL_SYSCALL_STACK_VALUE: usize = KERNEL_SYSCALL_STACK

extern "C" fn kura_syscall_entry();
extern "C" fn kura_enter_userspace(entry: usize, stack: usize, argc: usize, argv: usize);
extern "C" fn kura_switch_address_space(pml4: usize);
${schedulerExterns}${zeroHelper}
@repr(C)
struct TaskStateSegment {
    reserved0: u32,
    rsp0: u64,
    rsp1: u64,
    rsp2: u64,
    reserved1: u64,
    ist1: u64,
    ist2: u64,
    ist3: u64,
    ist4: u64,
    ist5: u64,
    ist6: u64,
    ist7: u64,
    reserved2: u64,
    reserved3: u16,
    io_map_base: u16,
}

unsafe fn init_tss(gdt: usize) {
    zero_region(TSS_BASE, 0x1000)
    memory.write<u64>(TSS_BASE + 4, KERNEL_SYSCALL_STACK)
    memory.write<u16>(TSS_BASE + 102, 104)
    let limit: u64 = 103
    let base: u64 = TSS_BASE
    let low: u64 = (limit & 0xFFFF) | ((base & 0xFFFFFF) << 16) | (0x89 << 40) | (((limit >> 16) & 0xF) << 48) | (((base >> 24) & 0xFF) << 56)
    let high: u64 = base >> 32
    memory.write<u64>(gdt + 40, low)
    memory.write<u64>(gdt + 48, high)
    cpu.load_task_register(TSS_SELECTOR)
}

unsafe fn init_syscall() {
    let efer: u64 = cpu.read_msr(IA32_EFER)
    cpu.write_msr(IA32_EFER, efer | 1)
    let star: u64 = 0x00130008 << 32
    cpu.write_msr(IA32_STAR, star)
    cpu.write_msr(IA32_LSTAR, function.address(kura_syscall_entry))
    cpu.write_msr(IA32_FMASK, 0x200 | 0x100 | 0x400)
}

unsafe fn process_record(index: usize) -> usize {
    return PROCESS_TABLE + index * PROCESS_RECORD_SIZE
}

unsafe fn allocate_process() -> u32 {
    let index: usize = 0
    while index < MAX_PROCESSES {
        let record: usize = process_record(index)
        if memory.read<u8>(record) == 0 {
            let pid: u32 = NEXT_PID
            NEXT_PID += 1
            zero_region(record, PROCESS_RECORD_SIZE)
            memory.write<u8>(record, 1)
            memory.write<u32>(record + 4, pid)
            return pid
        }
        index += 1
    }
    return 0
}

unsafe fn find_process(pid: u32) -> usize {
    let index: usize = 0
    while index < MAX_PROCESSES {
        let record: usize = process_record(index)
        if memory.read<u8>(record) != 0 && memory.read<u32>(record + 4) == pid {
            return record
        }
        index += 1
    }
    return 0
}

unsafe fn validate_user_range(address: usize, bytes: usize) -> bool {
    if address < ${USER_MIN} || address >= ${USER_MAX} { return false }
    if bytes > ${USER_MAX} - address { return false }
    return true
}

pub static mut kura_current_kernel_stack: usize = KERNEL_SYSCALL_STACK

pub extern "C" fn kura_syscall_dispatch(number: usize, a0: usize, a1: usize, a2: usize, a3: usize, a4: usize, a5: usize) -> isize {
    unsafe {
        if number == 0 { process_exit(a0); return 0 }
        if number == 1 { return syscall_write(a0, a1, a2) }
        if number == 2 { return syscall_read(a0, a1, a2) }
        if number == 5 { scheduler_yield(); return 0 }
        if number == 6 { thread_sleep(a0); return 0 }
        if number == 11 { return CURRENT_PID }
        if number == 12 { return 0 }
        return -38
    }
}

unsafe fn syscall_write(fd: usize, address: usize, bytes: usize) -> isize {
    if !validate_user_range(address, bytes) { return -14 }
    if fd != 1 && fd != 2 { return -9 }
    let offset: usize = 0
    while offset < bytes {
        serial_write_byte(memory.read<u8>(address + offset))
        offset += 1
    }
    return bytes
}

unsafe fn syscall_read(fd: usize, address: usize, bytes: usize) -> isize {
    if !validate_user_range(address, bytes) { return -14 }
    if fd != 0 { return -9 }
    return 0
}

unsafe fn process_exit(code: usize) {
    let record: usize = find_process(CURRENT_PID)
    if record != 0 {
        memory.write<u32>(record + 8, 4)
        memory.write<usize>(record + 12, code)
    }
    thread_exit()
}

unsafe fn launch_user_process(entry: usize, user_stack: usize, pml4: usize) -> u32 {
    let pid: u32 = allocate_process()
    if pid == 0 { return 0 }
    let record: usize = find_process(pid)
    memory.write<usize>(record + 16, pml4)
    memory.write<usize>(record + 24, entry)
    memory.write<usize>(record + 32, user_stack)
    CURRENT_PID = pid
    kura_switch_address_space(pml4)
    kura_enter_userspace(entry, user_stack, 0, 0)
    return pid
}

pub unsafe fn init_userspace(gdt: usize) {
    zero_region(PROCESS_TABLE, ${L.processTableSize})
    init_tss(gdt)
    init_syscall()
}
`;
}

export function parseElf64Executable(input) {
  const view = asView(input);
  if (view.byteLength < 64) throw new RangeError('ELF header is truncated.');
  if (view.getUint32(0, false) !== 0x7F454C46) throw new TypeError('Invalid ELF magic.');
  if (view.getUint8(4) !== 2) throw new TypeError('Only ELF64 is supported.');
  if (view.getUint8(5) !== 1) throw new TypeError('Only little-endian ELF is supported.');
  const type = view.getUint16(16, true); const machine = view.getUint16(18, true);
  if (![2, 3].includes(type)) throw new TypeError(`Unsupported ELF type ${type}.`);
  if (machine !== 0x3E) throw new TypeError(`Unsupported ELF machine ${machine}.`);
  const entry = view.getBigUint64(24, true); const programOffset = Number(view.getBigUint64(32, true)); const programEntrySize = view.getUint16(54, true); const programCount = view.getUint16(56, true);
  if (programEntrySize < 56 || programOffset + programEntrySize * programCount > view.byteLength) throw new RangeError('ELF program header table is truncated.');
  const segments = [];
  for (let index = 0; index < programCount; index++) {
    const offset = programOffset + index * programEntrySize; const kind = view.getUint32(offset, true); if (kind !== 1) continue;
    const flags = view.getUint32(offset + 4, true); const fileOffset = Number(view.getBigUint64(offset + 8, true)); const virtualAddress = view.getBigUint64(offset + 16, true); const physicalAddress = view.getBigUint64(offset + 24, true); const fileSize = Number(view.getBigUint64(offset + 32, true)); const memorySize = Number(view.getBigUint64(offset + 40, true)); const alignment = Number(view.getBigUint64(offset + 48, true));
    if (fileSize > memorySize || fileOffset + fileSize > view.byteLength) throw new RangeError(`Invalid ELF load segment ${index}.`);
    if (virtualAddress < BigInt(USER_MIN) || virtualAddress + BigInt(memorySize) > BigInt(USER_MAX)) throw new RangeError(`ELF segment ${index} is outside user space.`);
    segments.push({ index, flags, readable: Boolean(flags & 4), writable: Boolean(flags & 2), executable: Boolean(flags & 1), fileOffset, virtualAddress, physicalAddress, fileSize, memorySize, alignment, pageStart: virtualAddress & ~0xFFFn, pageEnd: (virtualAddress + BigInt(memorySize) + 0xFFFn) & ~0xFFFn });
  }
  if (!segments.some(segment => entry >= segment.virtualAddress && entry < segment.virtualAddress + BigInt(segment.memorySize) && segment.executable)) throw new RangeError('ELF entry point is not inside an executable load segment.');
  return { type, machine: 'x86_64', entry, segments, imageStart: segments.reduce((min, item) => item.pageStart < min ? item.pageStart : min, BigInt(USER_MAX)), imageEnd: segments.reduce((max, item) => item.pageEnd > max ? item.pageEnd : max, 0n) };
}

export class ProcessTableModel {
  constructor(options = {}) { this.maximum = options.maximum ?? 256; this.nextPid = 1; this.processes = new Map(); }
  spawn({ name = 'process', entry = 0n, addressSpace = 0n, parent = 0, files = [] } = {}) { if (this.processes.size >= this.maximum) throw new Error('Process table is full.'); const pid = this.nextPid++; const process = { pid, parent, name, entry: BigInt(entry), addressSpace: BigInt(addressSpace), state: 'ready', exitCode: null, files: new Map(files.map((value, index) => [index, value])), children: new Set(), signals: [], createdAt: Date.now() }; this.processes.set(pid, process); this.processes.get(parent)?.children.add(pid); return process; }
  get(pid) { return this.processes.get(pid) ?? null; }
  transition(pid, state) { const process = this.get(pid); if (!process) throw new Error(`Unknown PID ${pid}.`); const allowed = { ready: ['running','stopped','zombie'], running: ['ready','blocked','stopped','zombie'], blocked: ['ready','stopped','zombie'], stopped: ['ready','zombie'], zombie: [] }; if (!allowed[process.state].includes(state)) throw new Error(`Invalid process transition ${process.state} -> ${state}.`); process.state = state; return process; }
  exit(pid, code = 0) { const process = this.get(pid); if (!process) return false; process.state = 'zombie'; process.exitCode = code; for (const child of process.children) { const item = this.get(child); if (item) item.parent = 0; } return true; }
  reap(pid) { const process = this.get(pid); if (!process || process.state !== 'zombie') return null; this.processes.delete(pid); this.processes.get(process.parent)?.children.delete(pid); return process; }
  signal(pid, signal) { const process = this.get(pid); if (!process) return false; process.signals.push(signal); return true; }
  snapshot() { return [...this.processes.values()].map(item => ({ ...item, files: Object.fromEntries(item.files), children: [...item.children] })); }
}

class VfsNode {
  constructor(name, type, parent = null) { this.name = name; this.type = type; this.parent = parent; this.children = type === 'directory' ? new Map() : null; this.data = type === 'file' ? new Uint8Array() : null; this.mode = type === 'directory' ? 0o755 : 0o644; this.createdAt = Date.now(); this.modifiedAt = this.createdAt; }
  get path() { if (!this.parent) return '/'; const parts = []; for (let node = this; node?.parent; node = node.parent) parts.unshift(node.name); return '/' + parts.join('/'); }
}

export class VirtualFileSystem {
  constructor() { this.root = new VfsNode('', 'directory'); this.mounts = new Map([['/', this.root]]); this.descriptors = new Map(); this.nextFd = 3; }
  normalize(path) { const output = []; for (const part of String(path).split('/')) { if (!part || part === '.') continue; if (part === '..') output.pop(); else output.push(part); } return '/' + output.join('/'); }
  resolve(path) { const normalized = this.normalize(path); if (normalized === '/') return this.root; let node = this.root; for (const part of normalized.slice(1).split('/')) { if (node.type !== 'directory') return null; node = node.children.get(part); if (!node) return null; } return node; }
  mkdir(path, options = {}) { const normalized = this.normalize(path); let node = this.root; for (const part of normalized.slice(1).split('/').filter(Boolean)) { let child = node.children.get(part); if (!child) { if (!options.recursive && part !== normalized.split('/').at(-1)) throw new Error('Parent directory does not exist.'); child = new VfsNode(part, 'directory', node); node.children.set(part, child); } if (child.type !== 'directory') throw new Error(`${child.path} is not a directory.`); node = child; } return node; }
  create(path, data = new Uint8Array()) { const normalized = this.normalize(path); const parts = normalized.slice(1).split('/'); const name = parts.pop(); const parent = this.resolve('/' + parts.join('/')); if (!parent || parent.type !== 'directory') throw new Error('Parent directory does not exist.'); if (parent.children.has(name)) throw new Error('File already exists.'); const node = new VfsNode(name, 'file', parent); node.data = data instanceof Uint8Array ? data.slice() : new TextEncoder().encode(String(data)); parent.children.set(name, node); return node; }
  open(path, flags = 'r') { let node = this.resolve(path); if (!node && flags.includes('w')) node = this.create(path); if (!node) throw new Error(`No such file: ${path}`); if (node.type !== 'file') throw new Error('Cannot open a directory as a file.'); if (flags.includes('w') && !flags.includes('a')) node.data = new Uint8Array(); const fd = this.nextFd++; this.descriptors.set(fd, { fd, node, flags, offset: flags.includes('a') ? node.data.length : 0 }); return fd; }
  read(fd, size) { const file = this.descriptors.get(fd); if (!file || !file.flags.includes('r')) throw new Error('Bad file descriptor.'); const data = file.node.data.slice(file.offset, file.offset + size); file.offset += data.length; return data; }
  write(fd, data) { const file = this.descriptors.get(fd); if (!file || !/[wa+]/.test(file.flags)) throw new Error('Bad file descriptor.'); const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data)); const length = Math.max(file.node.data.length, file.offset + bytes.length); const next = new Uint8Array(length); next.set(file.node.data); next.set(bytes, file.offset); file.node.data = next; file.offset += bytes.length; file.node.modifiedAt = Date.now(); return bytes.length; }
  seek(fd, offset) { const file = this.descriptors.get(fd); if (!file) throw new Error('Bad file descriptor.'); if (offset < 0) throw new RangeError('Negative seek.'); file.offset = offset; return offset; }
  close(fd) { return this.descriptors.delete(fd); }
  list(path = '/') { const node = this.resolve(path); if (!node || node.type !== 'directory') throw new Error('Not a directory.'); return [...node.children.values()].map(item => ({ name: item.name, type: item.type, size: item.data?.length ?? 0, mode: item.mode })); }
  mount(path, root) { const normalized = this.normalize(path); const mountPoint = this.resolve(normalized); if (!mountPoint || mountPoint.type !== 'directory') throw new Error('Mount point does not exist.'); if (!(root instanceof VfsNode) || root.type !== 'directory') throw new TypeError('Mounted root must be a VFS directory.'); mountPoint.children = root.children; this.mounts.set(normalized, root); }
}

export function decodePciConfiguration(input, options = {}) {
  const view = asView(input); const bus = options.bus ?? 0; const device = options.device ?? 0; const functionNumber = options.function ?? 0;
  if (view.byteLength < 64) throw new RangeError('PCI configuration header is truncated.');
  const vendorId = view.getUint16(0, true); const deviceId = view.getUint16(2, true); if (vendorId === 0xFFFF) return null;
  const command = view.getUint16(4, true); const status = view.getUint16(6, true); const revision = view.getUint8(8); const programmingInterface = view.getUint8(9); const subclass = view.getUint8(10); const classCode = view.getUint8(11); const headerType = view.getUint8(14);
  const bars = [];
  for (let index = 0; index < 6; index++) { const raw = view.getUint32(16 + index * 4, true); if (!raw) continue; if (raw & 1) bars.push({ index, type: 'io', address: raw & ~3, raw }); else { const memoryType = (raw >> 1) & 3; const prefetchable = Boolean(raw & 8); let address = BigInt(raw & ~15); if (memoryType === 2 && index < 5) { address |= BigInt(view.getUint32(16 + (++index) * 4, true)) << 32n; } bars.push({ index, type: 'memory', memoryType, prefetchable, address, raw }); } }
  let capabilities = [];
  if (status & 0x10 && view.byteLength >= 256) { const seen = new Set(); let pointer = view.getUint8(0x34) & ~3; while (pointer >= 0x40 && pointer + 2 <= view.byteLength && !seen.has(pointer)) { seen.add(pointer); capabilities.push({ id: view.getUint8(pointer), offset: pointer }); pointer = view.getUint8(pointer + 1) & ~3; } }
  return { bus, device, function: functionNumber, vendorId, deviceId, command, status, revision, programmingInterface, subclass, classCode, headerType: headerType & 0x7F, multifunction: Boolean(headerType & 0x80), bars, capabilities, address: `${bus.toString(16).padStart(2,'0')}:${device.toString(16).padStart(2,'0')}.${functionNumber}` };
}

export class VirtioQueueModel {
  constructor(size = 256) { if (size < 2 || size > 32768 || size & (size - 1)) throw new RangeError('VirtIO queue size must be a power of two between 2 and 32768.'); this.size = size; this.descriptors = Array.from({ length: size }, (_, index) => ({ index, address: 0n, length: 0, flags: 0, next: 0, used: false })); this.free = Array.from({ length: size }, (_, index) => index); this.available = []; this.used = []; this.availableIndex = 0; this.usedIndex = 0; }
  allocate(chainLength = 1) { if (chainLength < 1 || chainLength > this.free.length) return null; const indices = this.free.splice(0, chainLength); indices.forEach((index, position) => { const descriptor = this.descriptors[index]; descriptor.used = true; descriptor.flags = position + 1 < indices.length ? 1 : 0; descriptor.next = indices[position + 1] ?? 0; }); return indices; }
  configure(index, { address, length, write = false, next = null }) { const descriptor = this.descriptors[index]; if (!descriptor?.used) throw new Error('Descriptor is not allocated.'); descriptor.address = BigInt(address); descriptor.length = length; descriptor.flags = (next != null ? 1 : 0) | (write ? 2 : 0); descriptor.next = next ?? 0; return descriptor; }
  submit(head) { if (!this.descriptors[head]?.used) throw new Error('Invalid descriptor head.'); this.available.push({ head, index: this.availableIndex++ }); return this.availableIndex - 1; }
  devicePop() { return this.available.shift() ?? null; }
  complete(head, length) { this.used.push({ head, length, index: this.usedIndex++ }); }
  driverPopUsed() { const entry = this.used.shift(); if (!entry) return null; const chain = []; let current = entry.head; const seen = new Set(); while (!seen.has(current)) { seen.add(current); chain.push(current); const descriptor = this.descriptors[current]; if (!(descriptor.flags & 1)) break; current = descriptor.next; } for (const index of chain) { Object.assign(this.descriptors[index], { address: 0n, length: 0, flags: 0, next: 0, used: false }); this.free.push(index); } return { ...entry, chain }; }
  snapshot() { return { size: this.size, free: this.free.length, availableIndex: this.availableIndex, usedIndex: this.usedIndex, pendingAvailable: this.available.length, pendingUsed: this.used.length }; }
}

export function encodeIpv4Packet({ source, destination, protocol, payload, identification = 0, ttl = 64 }) {
  const data = payload instanceof Uint8Array ? payload : Uint8Array.from(payload); const packet = new Uint8Array(20 + data.length); const view = new DataView(packet.buffer);
  packet[0] = 0x45; packet[1] = 0; view.setUint16(2, packet.length, false); view.setUint16(4, identification, false); view.setUint16(6, 0x4000, false); packet[8] = ttl; packet[9] = protocol;
  const parseAddress = value => String(value).split('.').map(Number); packet.set(parseAddress(source), 12); packet.set(parseAddress(destination), 16); view.setUint16(10, checksum16(packet.slice(0, 20)), false); packet.set(data, 20); return packet;
}

export function decodeIpv4Packet(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input); if (bytes.length < 20 || bytes[0] >> 4 !== 4) throw new TypeError('Invalid IPv4 packet.'); const headerLength = (bytes[0] & 15) * 4; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const totalLength = view.getUint16(2, false); if (headerLength < 20 || totalLength > bytes.length) throw new RangeError('Truncated IPv4 packet.'); if (checksum16(bytes.slice(0, headerLength)) !== 0) throw new Error('Invalid IPv4 header checksum.'); const address = offset => [...bytes.slice(offset, offset + 4)].join('.'); return { version: 4, headerLength, totalLength, identification: view.getUint16(4, false), flagsAndOffset: view.getUint16(6, false), ttl: bytes[8], protocol: bytes[9], source: address(12), destination: address(16), payload: bytes.slice(headerLength, totalLength) };
}

export function encodeUdpDatagram({ sourcePort, destinationPort, payload }) { const data = payload instanceof Uint8Array ? payload : Uint8Array.from(payload); const output = new Uint8Array(8 + data.length); const view = new DataView(output.buffer); view.setUint16(0, sourcePort, false); view.setUint16(2, destinationPort, false); view.setUint16(4, output.length, false); view.setUint16(6, 0, false); output.set(data, 8); return output; }
export function decodeUdpDatagram(input) { const bytes = input instanceof Uint8Array ? input : new Uint8Array(input); if (bytes.length < 8) throw new RangeError('UDP datagram is truncated.'); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const length = view.getUint16(4, false); if (length < 8 || length > bytes.length) throw new RangeError('Invalid UDP length.'); return { sourcePort: view.getUint16(0, false), destinationPort: view.getUint16(2, false), checksum: view.getUint16(6, false), payload: bytes.slice(8, length) }; }

export class TcpConnectionModel {
  constructor(options = {}) { this.state = 'CLOSED'; this.sequence = options.sequence ?? 1; this.acknowledgment = 0; this.sendWindow = options.sendWindow ?? 65535; this.receiveWindow = options.receiveWindow ?? 65535; this.retransmissions = []; }
  activeOpen() { if (this.state !== 'CLOSED') throw new Error('TCP active open requires CLOSED.'); this.state = 'SYN-SENT'; return { syn: true, sequence: this.sequence }; }
  passiveOpen() { if (this.state !== 'CLOSED') throw new Error('TCP passive open requires CLOSED.'); this.state = 'LISTEN'; }
  receive(segment) {
    const previous = this.state;
    if (this.state === 'LISTEN' && segment.syn) { this.acknowledgment = segment.sequence + 1; this.state = 'SYN-RECEIVED'; return { syn: true, ack: true, sequence: this.sequence, acknowledgment: this.acknowledgment }; }
    if (this.state === 'SYN-SENT' && segment.syn && segment.ack) { this.acknowledgment = segment.sequence + 1; this.state = 'ESTABLISHED'; return { ack: true, sequence: this.sequence + 1, acknowledgment: this.acknowledgment }; }
    if (this.state === 'SYN-RECEIVED' && segment.ack) { this.state = 'ESTABLISHED'; return null; }
    if (this.state === 'ESTABLISHED' && segment.fin) { this.acknowledgment = segment.sequence + 1; this.state = 'CLOSE-WAIT'; return { ack: true, acknowledgment: this.acknowledgment }; }
    if (this.state === 'FIN-WAIT-1' && segment.ack && segment.fin) { this.state = 'TIME-WAIT'; return { ack: true, acknowledgment: segment.sequence + 1 }; }
    if (this.state === 'FIN-WAIT-1' && segment.ack) { this.state = 'FIN-WAIT-2'; return null; }
    if (this.state === 'FIN-WAIT-2' && segment.fin) { this.state = 'TIME-WAIT'; return { ack: true, acknowledgment: segment.sequence + 1 }; }
    return { ignored: true, previous, state: this.state };
  }
  close() { if (this.state === 'ESTABLISHED') { this.state = 'FIN-WAIT-1'; return { fin: true, sequence: this.sequence }; } if (this.state === 'CLOSE-WAIT') { this.state = 'LAST-ACK'; return { fin: true, sequence: this.sequence }; } if (this.state === 'LISTEN' || this.state === 'SYN-SENT') { this.state = 'CLOSED'; return null; } throw new Error(`Cannot close TCP connection in ${this.state}.`); }
  timeout() { if (this.state === 'TIME-WAIT') this.state = 'CLOSED'; }
}

export function userspaceFingerprint(options = {}) { const manifest = createUserspaceManifest(options); return createHash('sha256').update(JSON.stringify(manifest)).update(createUserspaceAssembly(options)).update(createUserspaceKernelSource(options)).digest('hex'); }


function run(command, args, options = {}) {
  if (options.dryRun) return Promise.resolve({ command, args, code: 0, dryRun: true });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve({ command, args, code, stdout, stderr }) : reject(new Error(`Command failed (${code}): ${command} ${args.join(' ')}\n${stderr}`)));
  });
}

export function createUserspaceBuildPlan(options = {}) {
  const scheduler = createSchedulerBuildPlan({ ...options, outDir: options.outDir ?? 'build/userspace', entry: options.entry ?? 'kura_boot_entry', kernelEntry: options.kernelEntry ?? 'kernel_main' });
  return {
    ...scheduler,
    userspaceAssembly: path.join(scheduler.outDir, 'kura-userspace.S'),
    userspaceObject: path.join(scheduler.outDir, 'kura-userspace.o'),
    userspaceManifest: path.join(scheduler.outDir, 'kura-userspace.json'),
  };
}

export function createCompleteUserspaceKernelSource(options = {}) {
  return `${createKernelSchedulerSource(options)}\n\n${createUserspaceKernelSource({ ...options, fragment: true })}`;
}

export async function emitUserspaceSupportObject(options = {}) {
  const plan = options.plan ?? createUserspaceBuildPlan(options);
  const tools = options.tools ?? detectNativeToolchain();
  const assembly = createUserspaceAssembly(options);
  await mkdir(plan.outDir, { recursive: true });
  if (!options.dryRun) {
    await writeFile(plan.userspaceAssembly, assembly, 'utf8');
    await writeFile(plan.userspaceManifest, JSON.stringify(createUserspaceManifest(options), null, 2) + '\n', 'utf8');
  }
  let step;
  if (tools.clang) step = await run(tools.clang.command, ['-target', plan.target, '-ffreestanding', '-fno-stack-protector', '-fno-pic', '-mno-red-zone', '-c', plan.userspaceAssembly, '-o', plan.userspaceObject], options);
  else if (tools.assembler) step = await run(tools.assembler.command, ['--64', '-o', plan.userspaceObject, plan.userspaceAssembly], options);
  else if (options.dryRun) step = await run('clang', ['-target', plan.target, '-c', plan.userspaceAssembly, '-o', plan.userspaceObject], options);
  else throw new Error('clang or GNU as is required for userspace assembly.');
  return { plan, tools, assembly, step };
}

export async function buildUserspaceKernel(source = null, options = {}) {
  const plan = options.plan ?? createUserspaceBuildPlan(options);
  const tools = options.tools ?? detectNativeToolchain();
  const kernelSource = source ?? createCompleteUserspaceKernelSource(options);
  const objectResult = await emitNativeObject(kernelSource, { ...options, plan, tools });
  const bootstrapResult = await emitNativeBootstrapObject({ ...options, plan, tools, kernelEntry: plan.kernelEntry });
  const schedulerResult = await emitSchedulerSupportObject({ ...options, plan, tools });
  const userspaceResult = await emitUserspaceSupportObject({ ...options, plan, tools });
  const linkResult = await linkNativeElf([plan.bootstrapObject, plan.schedulerObject, plan.userspaceObject, plan.object], { ...options, plan, tools });
  return { plan, tools, source: kernelSource, objectResult, bootstrapResult, schedulerResult, userspaceResult, linkResult };
}
