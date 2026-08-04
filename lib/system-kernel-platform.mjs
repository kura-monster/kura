// SPDX-License-Identifier: MIT OR Apache-2.0

const PAGE_SIZE = 0x1000;
const HUGE_PAGE_SIZE = 0x200000;
const GIB = 0x40000000;
const MAX_PHYSICAL_4G = 0x100000000;
const IDT_BYTES = 256 * 16;

const AP_TRAMPOLINE_BYTES = Object.freeze([
  250, 252, 49, 192, 142, 208, 188, 240, 191, 184, 0, 10, 142, 216, 102, 15,
  1, 22, 176, 0, 15, 32, 192, 102, 131, 200, 1, 15, 34, 192, 102, 234,
  38, 160, 0, 0, 8, 0, 102, 184, 16, 0, 142, 216, 142, 192, 142, 208,
  161, 0, 176, 0, 0, 15, 34, 216, 15, 32, 224, 131, 200, 32, 15, 34,
  224, 185, 128, 0, 0, 192, 15, 50, 13, 0, 1, 0, 0, 15, 48, 15,
  32, 192, 13, 0, 0, 0, 128, 15, 34, 192, 234, 97, 160, 0, 0, 24,
  0, 102, 184, 16, 0, 142, 216, 142, 192, 142, 208, 72, 139, 36, 37, 8,
  176, 0, 0, 72, 49, 237, 139, 60, 37, 24, 176, 0, 0, 72, 139, 4,
  37, 16, 176, 0, 0, 255, 208, 250, 244, 235, 252, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 154, 207, 0,
  255, 255, 0, 0, 0, 146, 207, 0, 255, 255, 0, 0, 0, 154, 175, 0,
  31, 0, 144, 160, 0, 0,
]);

export const DEFAULT_KERNEL_PLATFORM_LAYOUT = Object.freeze({
  gdt: 0x1000,
  gdtDescriptor: 0x1100,
  idt: 0x2000,
  idtDescriptor: 0x3000,
  pml4: 0x4000,
  pdpt: 0x5000,
  pageDirectories: 0x6000,
  pageDirectoryCount: 4,
  apTrampoline: 0xA000,
  smpMailbox: 0xB000,
  pageTablePool: 0x800000,
  pageTablePoolSize: 0x200000,
  frameBitmap: 0xA00000,
  frameBitmapSize: 0x20000,
  cpuTable: 0xA20000,
  cpuTableSize: 0x1000,
  irqOverrides: 0xA21000,
  irqOverridesSize: 0x1000,
  platformScratch: 0xA22000,
  platformScratchSize: 0x2000,
  heap: 0x1000000,
  heapSize: 0x800000,
  frameStart: 0x2000000,
  fallbackFrameEnd: 0x10000000,
  maxPhysical: MAX_PHYSICAL_4G,
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

function hex(value) {
  return `0x${BigInt(value).toString(16).toUpperCase()}`;
}

function readU64(view, offset) {
  return view.getBigUint64(offset, true);
}

function asView(input) {
  if (input instanceof DataView) return input;
  if (ArrayBuffer.isView(input)) return new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new DataView(input);
  throw new TypeError('Expected an ArrayBuffer, DataView, Buffer, or typed array.');
}

export function createKernelPlatformManifest(options = {}) {
  const source = { ...DEFAULT_KERNEL_PLATFORM_LAYOUT, ...(options.layout ?? options) };
  const layout = {
    gdt: aligned('gdt', source.gdt, 8),
    gdtDescriptor: aligned('gdtDescriptor', source.gdtDescriptor, 2),
    idt: aligned('idt', source.idt, 16),
    idtDescriptor: aligned('idtDescriptor', source.idtDescriptor, 2),
    pml4: aligned('pml4', source.pml4),
    pdpt: aligned('pdpt', source.pdpt),
    pageDirectories: aligned('pageDirectories', source.pageDirectories),
    pageDirectoryCount: safeInteger('pageDirectoryCount', source.pageDirectoryCount, 1),
    apTrampoline: aligned('apTrampoline', source.apTrampoline),
    smpMailbox: aligned('smpMailbox', source.smpMailbox),
    pageTablePool: aligned('pageTablePool', source.pageTablePool),
    pageTablePoolSize: aligned('pageTablePoolSize', source.pageTablePoolSize),
    frameBitmap: aligned('frameBitmap', source.frameBitmap),
    frameBitmapSize: aligned('frameBitmapSize', source.frameBitmapSize),
    cpuTable: aligned('cpuTable', source.cpuTable),
    cpuTableSize: aligned('cpuTableSize', source.cpuTableSize),
    irqOverrides: aligned('irqOverrides', source.irqOverrides),
    irqOverridesSize: aligned('irqOverridesSize', source.irqOverridesSize),
    platformScratch: aligned('platformScratch', source.platformScratch),
    platformScratchSize: aligned('platformScratchSize', source.platformScratchSize),
    heap: aligned('heap', source.heap),
    heapSize: aligned('heapSize', source.heapSize),
    frameStart: aligned('frameStart', source.frameStart),
    fallbackFrameEnd: aligned('fallbackFrameEnd', source.fallbackFrameEnd),
    maxPhysical: aligned('maxPhysical', source.maxPhysical),
  };
  if (layout.pageDirectoryCount < 4) throw new TypeError('At least four page directories are required for the initial 4 GiB map.');
  if (layout.maxPhysical > MAX_PHYSICAL_4G) throw new TypeError('The current bitmap implementation tracks at most 4 GiB.');
  const trackedBytes = layout.frameBitmapSize * 8 * PAGE_SIZE;
  if (trackedBytes < layout.maxPhysical) throw new TypeError('frameBitmapSize is too small for maxPhysical.');
  if (layout.fallbackFrameEnd <= layout.frameStart) throw new TypeError('fallbackFrameEnd must be above frameStart.');

  const regions = [
    { name: 'gdt', start: layout.gdt, end: layout.gdt + 0x100 },
    { name: 'gdtDescriptor', start: layout.gdtDescriptor, end: layout.gdtDescriptor + 16 },
    { name: 'idt', start: layout.idt, end: layout.idt + IDT_BYTES },
    { name: 'idtDescriptor', start: layout.idtDescriptor, end: layout.idtDescriptor + 16 },
    { name: 'pml4', start: layout.pml4, end: layout.pml4 + PAGE_SIZE },
    { name: 'pdpt', start: layout.pdpt, end: layout.pdpt + PAGE_SIZE },
    {
      name: 'pageDirectories',
      start: layout.pageDirectories,
      end: layout.pageDirectories + layout.pageDirectoryCount * PAGE_SIZE,
    },
    { name: 'apTrampoline', start: layout.apTrampoline, end: layout.apTrampoline + PAGE_SIZE },
    { name: 'smpMailbox', start: layout.smpMailbox, end: layout.smpMailbox + PAGE_SIZE },
    { name: 'pageTablePool', start: layout.pageTablePool, end: layout.pageTablePool + layout.pageTablePoolSize },
    { name: 'frameBitmap', start: layout.frameBitmap, end: layout.frameBitmap + layout.frameBitmapSize },
    { name: 'cpuTable', start: layout.cpuTable, end: layout.cpuTable + layout.cpuTableSize },
    { name: 'irqOverrides', start: layout.irqOverrides, end: layout.irqOverrides + layout.irqOverridesSize },
    { name: 'platformScratch', start: layout.platformScratch, end: layout.platformScratch + layout.platformScratchSize },
    { name: 'heap', start: layout.heap, end: layout.heap + layout.heapSize },
  ].sort((left, right) => left.start - right.start);
  for (let index = 1; index < regions.length; index++) {
    const previous = regions[index - 1];
    const current = regions[index];
    if (current.start < previous.end) throw new TypeError(`Kernel platform regions overlap: ${previous.name} and ${current.name}.`);
  }
  if (regions.at(-1).end > layout.frameStart) throw new TypeError('frameStart must be above every reserved platform region.');

  return Object.freeze({
    architecture: 'x86_64',
    target: 'x86_64-unknown-none',
    pageSize: PAGE_SIZE,
    hugePageSize: HUGE_PAGE_SIZE,
    identityMappedBytes: MAX_PHYSICAL_4G,
    maxTrackedPhysicalBytes: layout.maxPhysical,
    maxTrackedFrames: layout.maxPhysical / PAGE_SIZE,
    selectors: Object.freeze({ code: 0x08, data: 0x10 }),
    vectors: Object.freeze({
      divideByZero: 0,
      breakpoint: 3,
      invalidOpcode: 6,
      doubleFault: 8,
      generalProtection: 13,
      pageFault: 14,
      timer: 32,
      keyboard: 33,
      spurious: 0xFF,
    }),
    layout: Object.freeze(layout),
    regions: Object.freeze(regions.map(region => Object.freeze(region))),
    features: Object.freeze({
      multiboot2MemoryMap: true,
      reusablePhysicalFrames: true,
      fourLevelPaging: true,
      freeListHeap: true,
      acpiMadt: true,
      ioApic: true,
      symmetricMultiprocessing: true,
    }),
  });
}

export function decodeMultiboot2(input, options = {}) {
  const view = asView(input);
  const offset = safeInteger('offset', options.offset ?? 0, 0);
  if (offset + 8 > view.byteLength) throw new RangeError('Multiboot2 information header is truncated.');
  const totalSize = view.getUint32(offset, true);
  if (totalSize < 16 || offset + totalSize > view.byteLength) throw new RangeError('Invalid Multiboot2 total size.');
  const tags = [];
  const memoryMap = [];
  const modules = [];
  let rsdp = null;
  let cursor = offset + 8;
  while (cursor + 8 <= offset + totalSize) {
    const type = view.getUint32(cursor, true);
    const size = view.getUint32(cursor + 4, true);
    if (size < 8 || cursor + size > offset + totalSize) throw new RangeError(`Invalid Multiboot2 tag size ${size}.`);
    const tag = { type, size, offset: cursor - offset };
    tags.push(tag);
    if (type === 3 && size >= 16) {
      modules.push({
        start: view.getUint32(cursor + 8, true),
        end: view.getUint32(cursor + 12, true),
      });
    } else if (type === 6 && size >= 16) {
      const entrySize = view.getUint32(cursor + 8, true);
      if (entrySize < 24) throw new RangeError('Multiboot2 memory-map entry size is below 24 bytes.');
      let entry = cursor + 16;
      while (entry + entrySize <= cursor + size) {
        memoryMap.push({
          address: readU64(view, entry),
          length: readU64(view, entry + 8),
          type: view.getUint32(entry + 16, true),
        });
        entry += entrySize;
      }
    } else if (type === 14 || type === 15) {
      rsdp = { revisionTag: type, offset: cursor + 8 - offset, bytes: size - 8 };
    }
    if (type === 0) break;
    cursor += (size + 7) & ~7;
  }
  return Object.freeze({
    totalSize,
    tags: Object.freeze(tags),
    memoryMap: Object.freeze(memoryMap),
    modules: Object.freeze(modules),
    rsdp,
  });
}

export function createPhysicalFrameBitmap(regions, options = {}) {
  const frameStart = BigInt(options.frameStart ?? DEFAULT_KERNEL_PLATFORM_LAYOUT.frameStart);
  const maxPhysical = BigInt(options.maxPhysical ?? DEFAULT_KERNEL_PLATFORM_LAYOUT.maxPhysical);
  const frameCount = Number(maxPhysical / BigInt(PAGE_SIZE));
  const bitmap = new Uint8Array(Math.ceil(frameCount / 8));
  bitmap.fill(0xFF);
  let freeFrames = 0;
  let highestPhysical = 0n;
  const setFree = frame => {
    const index = Number(frame / BigInt(PAGE_SIZE));
    if (index < 0 || index >= frameCount) return;
    const byte = index >>> 3;
    const bit = 1 << (index & 7);
    if ((bitmap[byte] & bit) !== 0) {
      bitmap[byte] &= ~bit;
      freeFrames++;
    }
  };
  for (const region of regions) {
    if (Number(region.type) !== 1) continue;
    let start = BigInt(region.address);
    let end = start + BigInt(region.length);
    if (start < frameStart) start = frameStart;
    if (end > maxPhysical) end = maxPhysical;
    start = (start + BigInt(PAGE_SIZE - 1)) & ~BigInt(PAGE_SIZE - 1);
    end &= ~BigInt(PAGE_SIZE - 1);
    for (let frame = start; frame < end; frame += BigInt(PAGE_SIZE)) setFree(frame);
    if (end > highestPhysical) highestPhysical = end;
  }
  return Object.freeze({ bitmap, freeFrames, highestPhysical, frameCount });
}

export function parseAcpiMadt(input, offset = 0) {
  const view = asView(input);
  safeInteger('offset', offset, 0);
  if (offset + 44 > view.byteLength) throw new RangeError('MADT header is truncated.');
  if (view.getUint32(offset, true) !== 0x43495041) throw new TypeError('ACPI table is not a MADT/APIC table.');
  const length = view.getUint32(offset + 4, true);
  if (length < 44 || offset + length > view.byteLength) throw new RangeError('Invalid MADT length.');
  let checksum = 0;
  for (let index = 0; index < length; index++) checksum = (checksum + view.getUint8(offset + index)) & 0xFF;
  if (checksum !== 0) throw new TypeError('MADT checksum is invalid.');
  let localApicAddress = BigInt(view.getUint32(offset + 36, true));
  const processors = [];
  const ioApics = [];
  const overrides = [];
  let cursor = offset + 44;
  while (cursor + 2 <= offset + length) {
    const type = view.getUint8(cursor);
    const entryLength = view.getUint8(cursor + 1);
    if (entryLength < 2 || cursor + entryLength > offset + length) throw new RangeError('Invalid MADT entry length.');
    if (type === 0 && entryLength >= 8) {
      processors.push({
        acpiId: view.getUint8(cursor + 2),
        apicId: view.getUint8(cursor + 3),
        flags: view.getUint32(cursor + 4, true),
        x2Apic: false,
      });
    } else if (type === 1 && entryLength >= 12) {
      ioApics.push({
        id: view.getUint8(cursor + 2),
        address: BigInt(view.getUint32(cursor + 4, true)),
        gsiBase: view.getUint32(cursor + 8, true),
      });
    } else if (type === 2 && entryLength >= 10) {
      overrides.push({
        bus: view.getUint8(cursor + 2),
        source: view.getUint8(cursor + 3),
        gsi: view.getUint32(cursor + 4, true),
        flags: view.getUint16(cursor + 8, true),
      });
    } else if (type === 5 && entryLength >= 12) {
      localApicAddress = readU64(view, cursor + 4);
    } else if (type === 9 && entryLength >= 16) {
      processors.push({
        acpiId: view.getUint32(cursor + 12, true),
        apicId: view.getUint32(cursor + 4, true),
        flags: view.getUint32(cursor + 8, true),
        x2Apic: true,
      });
    }
    cursor += entryLength;
  }
  return Object.freeze({
    length,
    localApicAddress,
    processors: Object.freeze(processors),
    ioApics: Object.freeze(ioApics),
    overrides: Object.freeze(overrides),
  });
}

export function createApTrampolineBytes() {
  return Uint8Array.from(AP_TRAMPOLINE_BYTES);
}

function platformConstants(manifest, options) {
  const { layout } = manifest;
  return `const GDT_BASE: usize = ${hex(layout.gdt)}
const GDT_DESCRIPTOR: usize = ${hex(layout.gdtDescriptor)}
const IDT_BASE: usize = ${hex(layout.idt)}
const IDT_DESCRIPTOR: usize = ${hex(layout.idtDescriptor)}
const PML4_BASE: usize = ${hex(layout.pml4)}
const PDPT_BASE: usize = ${hex(layout.pdpt)}
const PAGE_DIRECTORIES_BASE: usize = ${hex(layout.pageDirectories)}
const PAGE_DIRECTORY_COUNT: usize = ${layout.pageDirectoryCount}
const AP_TRAMPOLINE_BASE: usize = ${hex(layout.apTrampoline)}
const AP_TRAMPOLINE_VECTOR: u8 = ${layout.apTrampoline >> 12}
const SMP_MAILBOX: usize = ${hex(layout.smpMailbox)}
const PAGE_TABLE_POOL: usize = ${hex(layout.pageTablePool)}
const PAGE_TABLE_POOL_SIZE: usize = ${hex(layout.pageTablePoolSize)}
const FRAME_BITMAP: usize = ${hex(layout.frameBitmap)}
const FRAME_BITMAP_BYTES: usize = ${hex(layout.frameBitmapSize)}
const CPU_TABLE: usize = ${hex(layout.cpuTable)}
const CPU_TABLE_BYTES: usize = ${hex(layout.cpuTableSize)}
const IRQ_OVERRIDES: usize = ${hex(layout.irqOverrides)}
const PLATFORM_SCRATCH: usize = ${hex(layout.platformScratch)}
const PAGE_SIZE: usize = 0x1000
const HUGE_PAGE_SIZE: usize = 0x200000
const ONE_GIB: usize = 0x40000000
const MAX_PHYSICAL: usize = ${hex(layout.maxPhysical)}
const MAX_FRAMES: usize = MAX_PHYSICAL / PAGE_SIZE
const FRAME_START: usize = ${hex(layout.frameStart)}
const FALLBACK_FRAME_END: usize = ${hex(layout.fallbackFrameEnd)}
const HEAP_BASE: usize = ${hex(layout.heap)}
const HEAP_SIZE: usize = ${hex(layout.heapSize)}
const HEAP_HEADER_SIZE: usize = 32
const HEAP_MIN_SPLIT: usize = 64
const HEAP_MAGIC_FREE: u64 = 0x4B55524146524545
const HEAP_MAGIC_USED: u64 = 0x4B55524155534544
const PTE_PRESENT: u64 = 1
const PTE_WRITABLE: u64 = 2
const PTE_USER: u64 = 4
const PTE_HUGE: u64 = 0x80
const PTE_GLOBAL: u64 = 0x100
const PTE_NO_EXECUTE: u64 = 0x8000000000000000
const PTE_ADDRESS_MASK: u64 = 0x000FFFFFFFFFF000
const COM1: u16 = 0x3F8
const PIC1_COMMAND: u16 = 0x20
const PIC1_DATA: u16 = 0x21
const PIC2_COMMAND: u16 = 0xA0
const PIC2_DATA: u16 = 0xA1
const APIC_BASE_MSR: u32 = 0x1B
const APIC_ENABLE: u64 = 0x800
const APIC_ID: usize = 0x20
const APIC_EOI: usize = 0xB0
const APIC_SPURIOUS: usize = 0xF0
const APIC_ICR_LOW: usize = 0x300
const APIC_ICR_HIGH: usize = 0x310
const ACPI_RSDP_SIGNATURE: u64 = 0x2052545020445352
const ACPI_MADT_SIGNATURE: u32 = 0x43495041
const ENABLE_SMP: u8 = ${options.enableSmp ? 1 : 0}
const PREFER_IOAPIC: u8 = ${options.preferIoApic ? 1 : 0}`;
}

function apTrampolineWrites() {
  return AP_TRAMPOLINE_BYTES.map((value, index) => `    memory.write<u8>(AP_TRAMPOLINE_BASE + ${index}, ${value})`).join('\n');
}

export function createKernelPlatformSource(options = {}) {
  const manifest = createKernelPlatformManifest(options);
  const smoke = Boolean(options.smoke);
  const smokeExitCode = safeInteger('smokeExitCode', options.smokeExitCode ?? 0x10, 0);
  if (smokeExitCode > 0x7F) throw new TypeError('smokeExitCode must be between 0 and 127.');
  const enableSmp = options.enableSmp !== false;
  const preferIoApic = options.preferIoApic !== false;
  const sourceOptions = { enableSmp, preferIoApic };
  const mainTail = smoke
    ? `    serial_write_byte(0x53)\n    if ENABLE_SMP != 0 && CPU_COUNT > 1 && SMP_ONLINE_CPUS < CPU_COUNT {\n        io.out32(0xF4, ${Math.min(smokeExitCode + 1, 0x7F)})\n    }\n    io.out32(0xF4, ${smokeExitCode})\n    cpu.halt()`
    : `    serial_write_byte(0x4B)\n    cpu.enable_interrupts()\n    while true {\n        cpu.wait_for_interrupt()\n    }`;

  return `#![target("x86_64-unknown-none")]
#![no_std]
#![no_main]

${platformConstants(manifest, sourceOptions)}

static mut FRAME_SCAN_INDEX: usize = FRAME_START / PAGE_SIZE
static mut FREE_FRAMES: usize = 0
static mut ALLOCATED_FRAMES: usize = 0
static mut TOTAL_USABLE_BYTES: u64 = 0
static mut HIGHEST_PHYSICAL: usize = 0
static mut PAGE_TABLE_NEXT: usize = PAGE_TABLE_POOL
static mut PAGE_TABLE_END: usize = PAGE_TABLE_POOL + PAGE_TABLE_POOL_SIZE
static mut HEAP_FREE_HEAD: usize = 0
static mut HEAP_USED_BYTES: usize = 0
static mut HEAP_ALLOCATIONS: usize = 0
static mut TIMER_TICKS: u64 = 0
static mut RSDP_ADDRESS: usize = 0
static mut MADT_ADDRESS: usize = 0
static mut LOCAL_APIC_BASE: usize = 0
static mut IOAPIC_BASE: usize = 0
static mut IOAPIC_GSI_BASE: u32 = 0
static mut CPU_COUNT: u32 = 0
static mut BSP_APIC_ID: u32 = 0
static mut SMP_ONLINE_CPUS: u32 = 1
static mut INTERRUPT_MODE: u8 = 0

@repr(C)
struct InterruptFrame {
    instruction_pointer: u64,
    code_segment: u64,
    cpu_flags: u64,
    stack_pointer: u64,
    stack_segment: u64,
}

extern "C" fn kura_boot_info() -> usize;

fn align_up(value: usize, alignment: usize) -> usize {
    if alignment <= 1 {
        return value
    }
    let mask: usize = alignment - 1
    return (value + mask) & ~mask
}

fn align_down(value: usize, alignment: usize) -> usize {
    if alignment <= 1 {
        return value
    }
    return value & ~(alignment - 1)
}

unsafe fn zero_region(base: usize, bytes: usize) {
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

unsafe fn copy_region(destination: usize, source: usize, bytes: usize) {
    let offset: usize = 0
    while offset < bytes {
        let value: u8 = memory.read<u8>(source + offset)
        memory.write<u8>(destination + offset, value)
        offset += 1
    }
}

unsafe fn serial_init() {
    io.out8(COM1 + 1, 0)
    io.out8(COM1 + 3, 0x80)
    io.out8(COM1, 3)
    io.out8(COM1 + 1, 0)
    io.out8(COM1 + 3, 3)
    io.out8(COM1 + 2, 0xC7)
    io.out8(COM1 + 4, 0x0B)
}

unsafe fn serial_write_byte(value: u8) {
    io.out8(COM1, value)
    io.out8(0xE9, value)
}

unsafe fn init_gdt() {
    zero_region(GDT_BASE, 0x100)
    memory.write<u64>(GDT_BASE, 0)
    memory.write<u64>(GDT_BASE + 8, 0x00AF9A000000FFFF)
    memory.write<u64>(GDT_BASE + 16, 0x00AF92000000FFFF)
    memory.write<u16>(GDT_DESCRIPTOR, 23)
    memory.write<u64>(GDT_DESCRIPTOR + 2, GDT_BASE)
    cpu.load_gdt(GDT_DESCRIPTOR)
    cpu.reload_kernel_segments()
}

unsafe fn write_idt_gate(index: usize, handler: usize, attributes: u8) {
    let entry: usize = IDT_BASE + index * 16
    memory.write<u16>(entry, handler & 0xFFFF)
    memory.write<u16>(entry + 2, 0x08)
    memory.write<u8>(entry + 4, 0)
    memory.write<u8>(entry + 5, attributes)
    memory.write<u16>(entry + 6, (handler >> 16) & 0xFFFF)
    memory.write<u32>(entry + 8, (handler >> 32) & 0xFFFFFFFF)
    memory.write<u32>(entry + 12, 0)
}

unsafe fn init_idt() {
    zero_region(IDT_BASE, 4096)
    write_idt_gate(0, function.address(divide_by_zero), 0x8E)
    write_idt_gate(3, function.address(breakpoint_handler), 0x8F)
    write_idt_gate(6, function.address(invalid_opcode), 0x8E)
    write_idt_gate(8, function.address(double_fault), 0x8E)
    write_idt_gate(13, function.address(general_protection), 0x8E)
    write_idt_gate(14, function.address(page_fault), 0x8E)
    write_idt_gate(32, function.address(timer_interrupt), 0x8E)
    write_idt_gate(33, function.address(keyboard_interrupt), 0x8E)
    memory.write<u16>(IDT_DESCRIPTOR, 4095)
    memory.write<u64>(IDT_DESCRIPTOR + 2, IDT_BASE)
    cpu.load_idt(IDT_DESCRIPTOR)
}

unsafe fn init_identity_paging() {
    zero_region(PML4_BASE, PAGE_SIZE)
    zero_region(PDPT_BASE, PAGE_SIZE)
    zero_region(PAGE_DIRECTORIES_BASE, PAGE_DIRECTORY_COUNT * PAGE_SIZE)
    memory.write<u64>(PML4_BASE, PDPT_BASE | PTE_PRESENT | PTE_WRITABLE)
    let directory: usize = 0
    while directory < PAGE_DIRECTORY_COUNT {
        let directory_address: usize = PAGE_DIRECTORIES_BASE + directory * PAGE_SIZE
        memory.write<u64>(PDPT_BASE + directory * 8, directory_address | PTE_PRESENT | PTE_WRITABLE)
        let index: usize = 0
        while index < 512 {
            let frame: usize = directory * ONE_GIB + index * HUGE_PAGE_SIZE
            memory.write<u64>(directory_address + index * 8, frame | PTE_PRESENT | PTE_WRITABLE | PTE_HUGE)
            index += 1
        }
        directory += 1
    }
    let efer: u64 = cpu.read_msr(0xC0000080)
    cpu.write_msr(0xC0000080, efer | 0x800)
    let cr4: u64 = cpu.read_cr4()
    cpu.write_cr4(cr4 | 0x20)
    cpu.write_cr3(PML4_BASE)
}

unsafe fn page_table_pool_init() {
    PAGE_TABLE_NEXT = PAGE_TABLE_POOL
    PAGE_TABLE_END = PAGE_TABLE_POOL + PAGE_TABLE_POOL_SIZE
    zero_region(PAGE_TABLE_POOL, PAGE_TABLE_POOL_SIZE)
}

unsafe fn alloc_page_table() -> usize {
    if PAGE_TABLE_NEXT + PAGE_SIZE > PAGE_TABLE_END {
        return 0
    }
    let result: usize = PAGE_TABLE_NEXT
    PAGE_TABLE_NEXT += PAGE_SIZE
    zero_region(result, PAGE_SIZE)
    return result
}

unsafe fn next_page_table(table: usize, index: usize, create: bool) -> usize {
    let entry_address: usize = table + index * 8
    let entry: u64 = memory.read<u64>(entry_address)
    if (entry & PTE_PRESENT) != 0 {
        if (entry & PTE_HUGE) != 0 {
            return 0
        }
        let address: usize = entry & PTE_ADDRESS_MASK
        return address
    }
    if !create {
        return 0
    }
    let next: usize = alloc_page_table()
    if next == 0 {
        return 0
    }
    memory.write<u64>(entry_address, next | PTE_PRESENT | PTE_WRITABLE)
    return next
}

pub unsafe fn map_page(virtual_address: usize, physical_address: usize, flags: u64) -> bool {
    if (virtual_address & (PAGE_SIZE - 1)) != 0 || (physical_address & (PAGE_SIZE - 1)) != 0 {
        return false
    }
    let pml4_index: usize = (virtual_address >> 39) & 0x1FF
    let pdpt_index: usize = (virtual_address >> 30) & 0x1FF
    let pd_index: usize = (virtual_address >> 21) & 0x1FF
    let pt_index: usize = (virtual_address >> 12) & 0x1FF
    let pdpt: usize = next_page_table(PML4_BASE, pml4_index, true)
    if pdpt == 0 {
        return false
    }
    let pd: usize = next_page_table(pdpt, pdpt_index, true)
    if pd == 0 {
        return false
    }
    let pt: usize = next_page_table(pd, pd_index, true)
    if pt == 0 {
        return false
    }
    memory.write<u64>(pt + pt_index * 8, physical_address | flags | PTE_PRESENT)
    cpu.invalidate_page(virtual_address)
    return true
}

pub unsafe fn unmap_page(virtual_address: usize) -> usize {
    let pml4_index: usize = (virtual_address >> 39) & 0x1FF
    let pdpt_index: usize = (virtual_address >> 30) & 0x1FF
    let pd_index: usize = (virtual_address >> 21) & 0x1FF
    let pt_index: usize = (virtual_address >> 12) & 0x1FF
    let pdpt: usize = next_page_table(PML4_BASE, pml4_index, false)
    if pdpt == 0 {
        return 0
    }
    let pd: usize = next_page_table(pdpt, pdpt_index, false)
    if pd == 0 {
        return 0
    }
    let pt: usize = next_page_table(pd, pd_index, false)
    if pt == 0 {
        return 0
    }
    let entry_address: usize = pt + pt_index * 8
    let entry: u64 = memory.read<u64>(entry_address)
    if (entry & PTE_PRESENT) == 0 {
        return 0
    }
    memory.write<u64>(entry_address, 0)
    cpu.invalidate_page(virtual_address)
    let physical: usize = entry & PTE_ADDRESS_MASK
    return physical
}

pub unsafe fn translate_address(virtual_address: usize) -> usize {
    let pml4_index: usize = (virtual_address >> 39) & 0x1FF
    let pdpt_index: usize = (virtual_address >> 30) & 0x1FF
    let pd_index: usize = (virtual_address >> 21) & 0x1FF
    let pt_index: usize = (virtual_address >> 12) & 0x1FF
    let offset: usize = virtual_address & (PAGE_SIZE - 1)
    let pdpt: usize = next_page_table(PML4_BASE, pml4_index, false)
    if pdpt == 0 {
        return 0
    }
    let pd: usize = next_page_table(pdpt, pdpt_index, false)
    if pd == 0 {
        return 0
    }
    let pd_entry: u64 = memory.read<u64>(pd + pd_index * 8)
    if (pd_entry & PTE_PRESENT) == 0 {
        return 0
    }
    if (pd_entry & PTE_HUGE) != 0 {
        let huge_offset: usize = virtual_address & (HUGE_PAGE_SIZE - 1)
        let base: usize = pd_entry & 0x000FFFFFFFE00000
        return base + huge_offset
    }
    let pt: usize = pd_entry & PTE_ADDRESS_MASK
    let entry: u64 = memory.read<u64>(pt + pt_index * 8)
    if (entry & PTE_PRESENT) == 0 {
        return 0
    }
    let base: usize = entry & PTE_ADDRESS_MASK
    return base + offset
}

pub unsafe fn map_range(virtual_address: usize, physical_address: usize, bytes: usize, flags: u64) -> bool {
    let offset: usize = 0
    let success: bool = true
    let length: usize = align_up(bytes, PAGE_SIZE)
    while offset < length && success {
        success = map_page(virtual_address + offset, physical_address + offset, flags)
        offset += PAGE_SIZE
    }
    return success
}

unsafe fn bitmap_fill_used() {
    let offset: usize = 0
    while offset < FRAME_BITMAP_BYTES {
        memory.write<u64>(FRAME_BITMAP + offset, 0xFFFFFFFFFFFFFFFF)
        offset += 8
    }
    FREE_FRAMES = 0
    ALLOCATED_FRAMES = 0
    TOTAL_USABLE_BYTES = 0
    HIGHEST_PHYSICAL = 0
}

unsafe fn frame_mark_free(address: usize) {
    if address < FRAME_START || address >= MAX_PHYSICAL || (address & (PAGE_SIZE - 1)) != 0 {
        return
    }
    let index: usize = address / PAGE_SIZE
    let byte_address: usize = FRAME_BITMAP + index / 8
    let bit: u8 = 1 << (index & 7)
    let current: u8 = memory.read<u8>(byte_address)
    if (current & bit) != 0 {
        memory.write<u8>(byte_address, current & ~bit)
        FREE_FRAMES += 1
    }
}

unsafe fn frame_mark_used(address: usize) {
    if address < FRAME_START || address >= MAX_PHYSICAL || (address & (PAGE_SIZE - 1)) != 0 {
        return
    }
    let index: usize = address / PAGE_SIZE
    let byte_address: usize = FRAME_BITMAP + index / 8
    let bit: u8 = 1 << (index & 7)
    let current: u8 = memory.read<u8>(byte_address)
    if (current & bit) == 0 {
        memory.write<u8>(byte_address, current | bit)
        if FREE_FRAMES > 0 {
            FREE_FRAMES -= 1
        }
    }
}

unsafe fn release_usable_range(base: usize, length: usize) {
    let start: usize = align_up(base, PAGE_SIZE)
    let end: usize = align_down(base + length, PAGE_SIZE)
    if start < FRAME_START {
        start = FRAME_START
    }
    if end > MAX_PHYSICAL {
        end = MAX_PHYSICAL
    }
    if end > HIGHEST_PHYSICAL {
        HIGHEST_PHYSICAL = end
    }
    let frame: usize = start
    while frame < end {
        frame_mark_free(frame)
        TOTAL_USABLE_BYTES += PAGE_SIZE
        frame += PAGE_SIZE
    }
}

unsafe fn reserve_range(base: usize, length: usize) {
    let frame: usize = align_down(base, PAGE_SIZE)
    let end: usize = align_up(base + length, PAGE_SIZE)
    if frame < FRAME_START {
        frame = FRAME_START
    }
    if end > MAX_PHYSICAL {
        end = MAX_PHYSICAL
    }
    while frame < end {
        frame_mark_used(frame)
        frame += PAGE_SIZE
    }
}

unsafe fn parse_memory_map_tag(tag: usize) {
    let size: usize = memory.read<u32>(tag + 4)
    let entry_size: usize = memory.read<u32>(tag + 8)
    if entry_size < 24 || size < 16 {
        return
    }
    let entry: usize = tag + 16
    let end: usize = tag + size
    while entry + entry_size <= end {
        let base: usize = memory.read<u64>(entry)
        let length: usize = memory.read<u64>(entry + 8)
        let kind: u32 = memory.read<u32>(entry + 16)
        if kind == 1 && length >= PAGE_SIZE {
            release_usable_range(base, length)
        }
        entry += entry_size
    }
}

unsafe fn memory_init_from_multiboot(boot_info: usize) -> bool {
    bitmap_fill_used()
    if boot_info == 0 {
        release_usable_range(FRAME_START, FALLBACK_FRAME_END - FRAME_START)
        return false
    }
    let total_size: usize = memory.read<u32>(boot_info)
    if total_size < 16 || total_size > 0x1000000 {
        release_usable_range(FRAME_START, FALLBACK_FRAME_END - FRAME_START)
        return false
    }
    let found_map: bool = false
    let tag: usize = boot_info + 8
    let end: usize = boot_info + total_size
    while tag + 8 <= end {
        let kind: u32 = memory.read<u32>(tag)
        let size: usize = memory.read<u32>(tag + 4)
        if size < 8 {
            tag = end
        } else {
            if kind == 6 {
                parse_memory_map_tag(tag)
                found_map = true
            }
            if kind == 14 || kind == 15 {
                RSDP_ADDRESS = tag + 8
            }
            if kind == 0 {
                tag = end
            } else {
                tag += align_up(size, 8)
            }
        }
    }
    if !found_map {
        release_usable_range(FRAME_START, FALLBACK_FRAME_END - FRAME_START)
    }
    reserve_range(boot_info, total_size)
    tag = boot_info + 8
    while tag + 16 <= end {
        let kind: u32 = memory.read<u32>(tag)
        let size: usize = memory.read<u32>(tag + 4)
        if size < 8 {
            tag = end
        } else {
            if kind == 3 {
                let module_start: usize = memory.read<u32>(tag + 8)
                let module_end: usize = memory.read<u32>(tag + 12)
                if module_end > module_start {
                    reserve_range(module_start, module_end - module_start)
                }
            }
            if kind == 0 {
                tag = end
            } else {
                tag += align_up(size, 8)
            }
        }
    }
    FRAME_SCAN_INDEX = FRAME_START / PAGE_SIZE
    return found_map
}

pub unsafe fn frame_is_used(address: usize) -> bool {
    if address >= MAX_PHYSICAL {
        return true
    }
    let index: usize = address / PAGE_SIZE
    let byte: u8 = memory.read<u8>(FRAME_BITMAP + index / 8)
    let bit: u8 = 1 << (index & 7)
    return (byte & bit) != 0
}

pub unsafe fn alloc_frame() -> usize {
    let start_index: usize = FRAME_START / PAGE_SIZE
    let index: usize = FRAME_SCAN_INDEX
    let scanned: usize = 0
    let result: usize = 0
    while scanned < (MAX_FRAMES - start_index) && result == 0 {
        if index >= MAX_FRAMES {
            index = start_index
        }
        let address: usize = index * PAGE_SIZE
        if !frame_is_used(address) {
            frame_mark_used(address)
            result = address
            ALLOCATED_FRAMES += 1
        }
        index += 1
        scanned += 1
    }
    FRAME_SCAN_INDEX = index
    return result
}

pub unsafe fn free_frame(address: usize) -> bool {
    if address < FRAME_START || address >= MAX_PHYSICAL || (address & (PAGE_SIZE - 1)) != 0 {
        return false
    }
    if !frame_is_used(address) {
        return false
    }
    frame_mark_free(address)
    if ALLOCATED_FRAMES > 0 {
        ALLOCATED_FRAMES -= 1
    }
    if address / PAGE_SIZE < FRAME_SCAN_INDEX {
        FRAME_SCAN_INDEX = address / PAGE_SIZE
    }
    return true
}

pub fn free_frame_count() -> usize {
    return FREE_FRAMES
}

pub fn detected_memory_bytes() -> u64 {
    return TOTAL_USABLE_BYTES
}

unsafe fn block_size(block: usize) -> usize {
    let result: usize = memory.read<u64>(block)
    return result
}

unsafe fn block_next(block: usize) -> usize {
    let result: usize = memory.read<u64>(block + 8)
    return result
}

unsafe fn set_block(block: usize, size: usize, next: usize, magic: u64, requested: usize) {
    memory.write<u64>(block, size)
    memory.write<u64>(block + 8, next)
    memory.write<u64>(block + 16, magic)
    memory.write<u64>(block + 24, requested)
}

unsafe fn heap_init() {
    HEAP_FREE_HEAD = HEAP_BASE
    HEAP_USED_BYTES = 0
    HEAP_ALLOCATIONS = 0
    zero_region(HEAP_BASE, HEAP_SIZE)
    set_block(HEAP_BASE, HEAP_SIZE, 0, HEAP_MAGIC_FREE, 0)
}

pub unsafe fn heap_alloc(bytes: usize, alignment: usize) -> usize {
    if bytes == 0 {
        return 0
    }
    let align: usize = alignment
    if align < 16 {
        align = 16
    }
    if (align & (align - 1)) != 0 || align > PAGE_SIZE {
        return 0
    }
    let previous: usize = 0
    let current: usize = HEAP_FREE_HEAD
    let result: usize = 0
    while current != 0 && result == 0 {
        let size: usize = block_size(current)
        let next: usize = block_next(current)
        let payload: usize = align_up(current + HEAP_HEADER_SIZE + 8, align)
        let required: usize = align_up(payload + bytes - current, 16)
        if size >= required {
            let remainder: usize = size - required
            let replacement: usize = next
            if remainder >= HEAP_MIN_SPLIT {
                let split: usize = current + required
                set_block(split, remainder, next, HEAP_MAGIC_FREE, 0)
                replacement = split
            }
            if previous == 0 {
                HEAP_FREE_HEAD = replacement
            } else {
                memory.write<u64>(previous + 8, replacement)
            }
            set_block(current, required, 0, HEAP_MAGIC_USED, bytes)
            memory.write<u64>(payload - 8, current)
            HEAP_USED_BYTES += required
            HEAP_ALLOCATIONS += 1
            result = payload
            current = 0
        } else {
            previous = current
            current = next
        }
    }
    return result
}

pub unsafe fn heap_free(address: usize) -> bool {
    if address < HEAP_BASE + HEAP_HEADER_SIZE || address >= HEAP_BASE + HEAP_SIZE {
        return false
    }
    let block: usize = memory.read<u64>(address - 8)
    if block < HEAP_BASE || block >= HEAP_BASE + HEAP_SIZE {
        return false
    }
    if memory.read<u64>(block + 16) != HEAP_MAGIC_USED {
        return false
    }
    let size: usize = block_size(block)
    let previous: usize = 0
    let current: usize = HEAP_FREE_HEAD
    while current != 0 && current < block {
        previous = current
        current = block_next(current)
    }
    set_block(block, size, current, HEAP_MAGIC_FREE, 0)
    if previous == 0 {
        HEAP_FREE_HEAD = block
    } else {
        memory.write<u64>(previous + 8, block)
    }
    if current != 0 && block + block_size(block) == current {
        let combined: usize = block_size(block) + block_size(current)
        set_block(block, combined, block_next(current), HEAP_MAGIC_FREE, 0)
    }
    if previous != 0 && previous + block_size(previous) == block {
        let combined: usize = block_size(previous) + block_size(block)
        set_block(previous, combined, block_next(block), HEAP_MAGIC_FREE, 0)
    }
    if HEAP_USED_BYTES >= size {
        HEAP_USED_BYTES -= size
    }
    if HEAP_ALLOCATIONS > 0 {
        HEAP_ALLOCATIONS -= 1
    }
    return true
}

pub unsafe fn heap_calloc(count: usize, bytes: usize, alignment: usize) -> usize {
    let total: usize = count * bytes
    if count != 0 && total / count != bytes {
        return 0
    }
    let result: usize = heap_alloc(total, alignment)
    if result != 0 {
        zero_region(result, total)
    }
    return result
}

pub unsafe fn heap_realloc(address: usize, bytes: usize, alignment: usize) -> usize {
    if address == 0 {
        return heap_alloc(bytes, alignment)
    }
    if bytes == 0 {
        heap_free(address)
        return 0
    }
    let block: usize = memory.read<u64>(address - 8)
    if block < HEAP_BASE || block >= HEAP_BASE + HEAP_SIZE || memory.read<u64>(block + 16) != HEAP_MAGIC_USED {
        return 0
    }
    let old_bytes: usize = memory.read<u64>(block + 24)
    if bytes <= old_bytes {
        memory.write<u64>(block + 24, bytes)
        return address
    }
    let replacement: usize = heap_alloc(bytes, alignment)
    if replacement == 0 {
        return 0
    }
    copy_region(replacement, address, old_bytes)
    heap_free(address)
    return replacement
}

pub fn heap_used_bytes() -> usize {
    return HEAP_USED_BYTES
}

unsafe fn acpi_checksum(address: usize, bytes: usize) -> bool {
    let index: usize = 0
    let sum: u8 = 0
    while index < bytes {
        sum += memory.read<u8>(address + index)
        index += 1
    }
    return sum == 0
}

unsafe fn acpi_root_table() -> usize {
    if RSDP_ADDRESS == 0 || memory.read<u64>(RSDP_ADDRESS) != ACPI_RSDP_SIGNATURE {
        return 0
    }
    if !acpi_checksum(RSDP_ADDRESS, 20) {
        return 0
    }
    let revision: u8 = memory.read<u8>(RSDP_ADDRESS + 15)
    if revision >= 2 {
        let length: usize = memory.read<u32>(RSDP_ADDRESS + 20)
        if length >= 36 && acpi_checksum(RSDP_ADDRESS, length) {
            let xsdt: usize = memory.read<u64>(RSDP_ADDRESS + 24)
            if xsdt != 0 {
                return xsdt
            }
        }
    }
    let rsdt: usize = memory.read<u32>(RSDP_ADDRESS + 16)
    return rsdt
}

unsafe fn acpi_find_table(signature: u32) -> usize {
    let root: usize = acpi_root_table()
    if root == 0 {
        return 0
    }
    let root_signature: u32 = memory.read<u32>(root)
    let length: usize = memory.read<u32>(root + 4)
    if length < 36 || !acpi_checksum(root, length) {
        return 0
    }
    let entry_size: usize = 4
    if root_signature == 0x54445358 {
        entry_size = 8
    }
    let cursor: usize = root + 36
    let end: usize = root + length
    let result: usize = 0
    while cursor + entry_size <= end && result == 0 {
        let table: usize = memory.read<u32>(cursor)
        if entry_size == 8 {
            table = memory.read<u64>(cursor)
        }
        if table != 0 {
            let table_length: usize = memory.read<u32>(table + 4)
            if memory.read<u32>(table) == signature && table_length >= 36 && acpi_checksum(table, table_length) {
                result = table
            }
        }
        cursor += entry_size
    }
    return result
}

unsafe fn cpu_table_contains(apic_id: u32) -> bool {
    let index: u32 = 0
    let found: bool = false
    while index < CPU_COUNT && !found {
        if memory.read<u32>(CPU_TABLE + index * 4) == apic_id {
            found = true
        }
        index += 1
    }
    return found
}

unsafe fn cpu_table_add(apic_id: u32) {
    if CPU_COUNT * 4 >= CPU_TABLE_BYTES || cpu_table_contains(apic_id) {
        return
    }
    memory.write<u32>(CPU_TABLE + CPU_COUNT * 4, apic_id)
    CPU_COUNT += 1
}

unsafe fn irq_overrides_init() {
    let irq: usize = 0
    while irq < 16 {
        let entry: usize = IRQ_OVERRIDES + irq * 8
        memory.write<u32>(entry, irq)
        memory.write<u16>(entry + 4, 0)
        irq += 1
    }
}

unsafe fn parse_madt() -> bool {
    MADT_ADDRESS = acpi_find_table(ACPI_MADT_SIGNATURE)
    if MADT_ADDRESS == 0 {
        return false
    }
    CPU_COUNT = 0
    IOAPIC_BASE = 0
    IOAPIC_GSI_BASE = 0
    zero_region(CPU_TABLE, CPU_TABLE_BYTES)
    irq_overrides_init()
    LOCAL_APIC_BASE = memory.read<u32>(MADT_ADDRESS + 36)
    let length: usize = memory.read<u32>(MADT_ADDRESS + 4)
    let entry: usize = MADT_ADDRESS + 44
    let end: usize = MADT_ADDRESS + length
    while entry + 2 <= end {
        let kind: u8 = memory.read<u8>(entry)
        let size: usize = memory.read<u8>(entry + 1)
        if size < 2 || entry + size > end {
            entry = end
        } else {
            if kind == 0 && size >= 8 {
                let flags: u32 = memory.read<u32>(entry + 4)
                if (flags & 3) != 0 {
                    cpu_table_add(memory.read<u8>(entry + 3))
                }
            }
            if kind == 1 && size >= 12 && IOAPIC_BASE == 0 {
                IOAPIC_BASE = memory.read<u32>(entry + 4)
                IOAPIC_GSI_BASE = memory.read<u32>(entry + 8)
            }
            if kind == 2 && size >= 10 {
                let source: usize = memory.read<u8>(entry + 3)
                if source < 16 {
                    let override: usize = IRQ_OVERRIDES + source * 8
                    memory.write<u32>(override, memory.read<u32>(entry + 4))
                    memory.write<u16>(override + 4, memory.read<u16>(entry + 8))
                }
            }
            if kind == 5 && size >= 12 {
                LOCAL_APIC_BASE = memory.read<u64>(entry + 4)
            }
            if kind == 9 && size >= 16 {
                let flags: u32 = memory.read<u32>(entry + 8)
                let apic_id: u32 = memory.read<u32>(entry + 4)
                if (flags & 3) != 0 && apic_id <= 255 {
                    cpu_table_add(apic_id)
                }
            }
            entry += size
        }
    }
    return CPU_COUNT > 0
}

unsafe fn local_apic_read(register: usize) -> u32 {
    return memory.volatile_read<u32>(LOCAL_APIC_BASE + register)
}

unsafe fn local_apic_write(register: usize, value: u32) {
    memory.volatile_write<u32>(LOCAL_APIC_BASE + register, value)
    let barrier: u32 = memory.volatile_read<u32>(LOCAL_APIC_BASE + APIC_ID)
    if barrier == 0xFFFFFFFF {
        serial_write_byte(0)
    }
}

unsafe fn init_local_apic() -> bool {
    let msr: u64 = cpu.read_msr(APIC_BASE_MSR)
    cpu.write_msr(APIC_BASE_MSR, msr | APIC_ENABLE)
    if LOCAL_APIC_BASE == 0 {
        LOCAL_APIC_BASE = msr & 0xFFFFF000
    }
    if LOCAL_APIC_BASE == 0 || LOCAL_APIC_BASE >= MAX_PHYSICAL {
        return false
    }
    local_apic_write(APIC_SPURIOUS, 0x1FF)
    local_apic_write(APIC_EOI, 0)
    BSP_APIC_ID = local_apic_read(APIC_ID) >> 24
    return true
}

unsafe fn ioapic_read(register: u32) -> u32 {
    memory.volatile_write<u32>(IOAPIC_BASE, register)
    return memory.volatile_read<u32>(IOAPIC_BASE + 0x10)
}

unsafe fn ioapic_write(register: u32, value: u32) {
    memory.volatile_write<u32>(IOAPIC_BASE, register)
    memory.volatile_write<u32>(IOAPIC_BASE + 0x10, value)
}

unsafe fn ioapic_mask_all() {
    let maximum: u32 = (ioapic_read(1) >> 16) & 0xFF
    let index: u32 = 0
    while index <= maximum {
        ioapic_write(0x10 + index * 2, 0x10000)
        ioapic_write(0x11 + index * 2, 0)
        index += 1
    }
}

unsafe fn ioapic_route_isa_irq(irq: usize, vector: u8) -> bool {
    if irq >= 16 || IOAPIC_BASE == 0 {
        return false
    }
    let override: usize = IRQ_OVERRIDES + irq * 8
    let gsi: u32 = memory.read<u32>(override)
    let flags: u16 = memory.read<u16>(override + 4)
    if gsi < IOAPIC_GSI_BASE {
        return false
    }
    let pin: u32 = gsi - IOAPIC_GSI_BASE
    let maximum: u32 = (ioapic_read(1) >> 16) & 0xFF
    if pin > maximum {
        return false
    }
    let low: u32 = vector
    let polarity: u16 = flags & 3
    let trigger: u16 = (flags >> 2) & 3
    if polarity == 3 {
        low = low | 0x2000
    }
    if trigger == 3 {
        low = low | 0x8000
    }
    ioapic_write(0x11 + pin * 2, BSP_APIC_ID << 24)
    ioapic_write(0x10 + pin * 2, low)
    return true
}

unsafe fn pic_disable() {
    io.out8(PIC1_DATA, 0xFF)
    io.out8(PIC2_DATA, 0xFF)
}

unsafe fn init_pic() {
    io.out8(PIC1_COMMAND, 0x11)
    io.wait()
    io.out8(PIC2_COMMAND, 0x11)
    io.wait()
    io.out8(PIC1_DATA, 0x20)
    io.wait()
    io.out8(PIC2_DATA, 0x28)
    io.wait()
    io.out8(PIC1_DATA, 4)
    io.wait()
    io.out8(PIC2_DATA, 2)
    io.wait()
    io.out8(PIC1_DATA, 1)
    io.wait()
    io.out8(PIC2_DATA, 1)
    io.wait()
    io.out8(PIC1_DATA, 0xFC)
    io.out8(PIC2_DATA, 0xFF)
    INTERRUPT_MODE = 1
}

unsafe fn pic_eoi(irq: u8) {
    if irq >= 8 {
        io.out8(PIC2_COMMAND, 0x20)
    }
    io.out8(PIC1_COMMAND, 0x20)
}

unsafe fn interrupt_eoi(irq: u8) {
    if INTERRUPT_MODE == 2 {
        local_apic_write(APIC_EOI, 0)
    } else {
        pic_eoi(irq)
    }
}

unsafe fn platform_interrupts_init() {
    let acpi: bool = parse_madt()
    if PREFER_IOAPIC != 0 && acpi && IOAPIC_BASE != 0 && init_local_apic() {
        pic_disable()
        ioapic_mask_all()
        ioapic_route_isa_irq(0, 32)
        ioapic_route_isa_irq(1, 33)
        INTERRUPT_MODE = 2
    } else {
        init_pic()
        if acpi {
            init_local_apic()
        }
    }
}

unsafe fn smp_prepare_trampoline() {
    zero_region(AP_TRAMPOLINE_BASE, PAGE_SIZE)
${apTrampolineWrites()}
    zero_region(SMP_MAILBOX, PAGE_SIZE)
}

unsafe fn local_apic_wait_delivery() {
    let spins: usize = 0
    while spins < 1000000 && (local_apic_read(APIC_ICR_LOW) & 0x1000) != 0 {
        cpu.pause()
        spins += 1
    }
}

unsafe fn local_apic_send(apic_id: u32, command: u32) {
    local_apic_wait_delivery()
    local_apic_write(APIC_ICR_HIGH, apic_id << 24)
    local_apic_write(APIC_ICR_LOW, command)
    local_apic_wait_delivery()
}

unsafe fn short_delay(iterations: usize) {
    let index: usize = 0
    while index < iterations {
        cpu.pause()
        index += 1
    }
}

@link_name("kura_ap_main")
pub unsafe extern "C" fn application_processor_main(apic_id: u32) -> never {
    cpu.disable_interrupts()
    cpu.load_gdt(GDT_DESCRIPTOR)
    cpu.reload_kernel_segments()
    cpu.load_idt(IDT_DESCRIPTOR)
    init_local_apic()
    SMP_ONLINE_CPUS += 1
    memory.volatile_write<u32>(SMP_MAILBOX + 28, 1)
    serial_write_byte(0x41)
    cpu.enable_interrupts()
    while true {
        cpu.wait_for_interrupt()
    }
}

unsafe fn smp_start_processor(apic_id: u32) -> bool {
    if apic_id == BSP_APIC_ID || apic_id > 255 || LOCAL_APIC_BASE == 0 {
        return false
    }
    let stack: usize = heap_alloc(65536, 16)
    if stack == 0 {
        return false
    }
    memory.write<u64>(SMP_MAILBOX, cpu.read_cr3())
    memory.write<u64>(SMP_MAILBOX + 8, stack + 65536)
    memory.write<u64>(SMP_MAILBOX + 16, function.address(application_processor_main))
    memory.write<u32>(SMP_MAILBOX + 24, apic_id)
    memory.volatile_write<u32>(SMP_MAILBOX + 28, 0)
    local_apic_send(apic_id, 0x00004500)
    short_delay(100000)
    local_apic_send(apic_id, 0x00000500)
    short_delay(100000)
    local_apic_send(apic_id, 0x00000600 | AP_TRAMPOLINE_VECTOR)
    short_delay(200000)
    local_apic_send(apic_id, 0x00000600 | AP_TRAMPOLINE_VECTOR)
    let spins: usize = 0
    while spins < 5000000 && memory.volatile_read<u32>(SMP_MAILBOX + 28) == 0 {
        cpu.pause()
        spins += 1
    }
    return memory.volatile_read<u32>(SMP_MAILBOX + 28) != 0
}

unsafe fn smp_start_all() -> u32 {
    if ENABLE_SMP == 0 || INTERRUPT_MODE != 2 || CPU_COUNT <= 1 {
        return 0
    }
    smp_prepare_trampoline()
    let index: u32 = 0
    let started: u32 = 0
    while index < CPU_COUNT {
        let apic_id: u32 = memory.read<u32>(CPU_TABLE + index * 4)
        if smp_start_processor(apic_id) {
            started += 1
        }
        index += 1
    }
    return started
}

unsafe fn exception_stop(code: u8) -> never {
    serial_write_byte(0x45)
    serial_write_byte(code)
    cpu.disable_interrupts()
    cpu.halt()
}

@interrupt
pub unsafe extern "x86-interrupt" fn divide_by_zero(frame: *mut InterruptFrame) {
    exception_stop(0)
}

@interrupt
pub unsafe extern "x86-interrupt" fn breakpoint_handler(frame: *mut InterruptFrame) {
    serial_write_byte(3)
}

@interrupt
pub unsafe extern "x86-interrupt" fn invalid_opcode(frame: *mut InterruptFrame) {
    exception_stop(6)
}

@interrupt
pub unsafe extern "x86-interrupt" fn double_fault(frame: *mut InterruptFrame, error: u64) {
    exception_stop(8)
}

@interrupt
pub unsafe extern "x86-interrupt" fn general_protection(frame: *mut InterruptFrame, error: u64) {
    exception_stop(13)
}

@interrupt
pub unsafe extern "x86-interrupt" fn page_fault(frame: *mut InterruptFrame, error: u64) {
    let fault_address: u64 = cpu.read_cr2()
    serial_write_byte(14)
    if fault_address == 0 {
        serial_write_byte(0)
    }
    exception_stop(14)
}

@interrupt
pub unsafe extern "x86-interrupt" fn timer_interrupt(frame: *mut InterruptFrame) {
    TIMER_TICKS += 1
    interrupt_eoi(0)
}

@interrupt
pub unsafe extern "x86-interrupt" fn keyboard_interrupt(frame: *mut InterruptFrame) {
    let scan_code: u8 = io.in8(0x60)
    if scan_code == 0 {
        serial_write_byte(0)
    }
    interrupt_eoi(1)
}

@entry
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
    smp_start_all()
${mainTail}
}
`;
}
