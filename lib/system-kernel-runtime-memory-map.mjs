// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createX86_64BootstrapAssembly,
} from './system-kernel-runtime.mjs';

export {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createX86_64BootstrapAssembly,
};

function integer(name, value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function hex(value) {
  return `0x${value.toString(16).toUpperCase()}`;
}

function runtimeConstants(manifest) {
  const { layout, pageSize, hugePageSize, identityMappedBytes } = manifest;
  return `const GDT_BASE: usize = ${hex(layout.gdt)}
const GDT_DESCRIPTOR: usize = ${hex(layout.gdtDescriptor)}
const IDT_BASE: usize = ${hex(layout.idt)}
const IDT_DESCRIPTOR: usize = ${hex(layout.idtDescriptor)}
const PML4_BASE: usize = ${hex(layout.pml4)}
const PDPT_BASE: usize = ${hex(layout.pdpt)}
const PAGE_DIRECTORY_BASE: usize = ${hex(layout.pageDirectory)}
const PAGE_SIZE: usize = ${hex(pageSize)}
const HUGE_PAGE_SIZE: usize = ${hex(hugePageSize)}
const IDENTITY_MAPPED_BYTES: usize = ${hex(identityMappedBytes)}
const HEAP_BASE: usize = ${hex(layout.heap)}
const HEAP_SIZE: usize = ${hex(layout.heapSize)}
const FRAME_START: usize = ${hex(layout.frameStart)}
const FRAME_END: usize = ${hex(layout.frameEnd)}
const MULTIBOOT_TAG_END: u32 = 0
const MULTIBOOT_TAG_MEMORY_MAP: u32 = 6
const MULTIBOOT_MEMORY_AVAILABLE: u32 = 1
const MULTIBOOT_MEMORY_ENTRY_MIN_SIZE: usize = 24
const COM1: u16 = 0x3F8
const PIC1_COMMAND: u16 = 0x20
const PIC1_DATA: u16 = 0x21
const PIC2_COMMAND: u16 = 0xA0
const PIC2_DATA: u16 = 0xA1
const APIC_BASE_MSR: u32 = 0x1B
const APIC_ENABLE: u64 = 0x800
const APIC_SPURIOUS: usize = 0xF0
const APIC_EOI: usize = 0xB0`;
}

export function createKernelRuntimeSource(options = {}) {
  const manifest = createKernelArchitectureManifest(options);
  const smoke = Boolean(options.smoke);
  const smokeCode = integer('smokeExitCode', options.smokeExitCode ?? 0x10, 0);
  const enableApic = Boolean(options.enableApic);
  const mainTail = smoke
    ? `    serial_write_byte(0x53)\n    io.out32(0xF4, ${smokeCode})\n    cpu.halt()`
    : `    serial_write_byte(0x4B)\n    cpu.enable_interrupts()\n    while true {\n        cpu.wait_for_interrupt()\n    }`;
  const interruptControllerInit = enableApic ? 'init_local_apic()' : 'init_pic()';
  return `#![target("x86_64-unknown-none")]
#![no_std]
#![no_main]

${runtimeConstants(manifest)}

static mut NEXT_FRAME: usize = FRAME_START
static mut FRAME_LIMIT: usize = FRAME_END
static mut MEMORY_MAP_CURSOR: usize = 0
static mut MEMORY_MAP_END: usize = 0
static mut MEMORY_MAP_ENTRY_SIZE: usize = 0
static mut BOOT_INFO_START: usize = 0
static mut BOOT_INFO_END: usize = 0
static mut FRAME_MEMORY_MAP_ACTIVE: bool = false
static mut HEAP_NEXT: usize = HEAP_BASE
static mut HEAP_END: usize = HEAP_BASE + HEAP_SIZE
static mut TIMER_TICKS: u64 = 0

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
    let mask: usize = alignment - 1
    return (value + mask) & ~mask
}

fn align_down(value: usize, alignment: usize) -> usize {
    let mask: usize = alignment - 1
    return value & ~mask
}

fn ranges_overlap(left_start: usize, left_end: usize, right_start: usize, right_end: usize) -> bool {
    return left_start < right_end && right_start < left_end
}

unsafe fn zero_region(base: usize, bytes: usize) {
    let offset: usize = 0
    while offset < bytes {
        memory.write<u64>(base + offset, 0)
        offset += 8
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

unsafe fn init_pic() {
    let master_mask: u8 = io.in8(PIC1_DATA)
    let slave_mask: u8 = io.in8(PIC2_DATA)
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
    io.out8(PIC1_DATA, master_mask & 0xFC)
    io.out8(PIC2_DATA, slave_mask)
}

unsafe fn pic_eoi(irq: u8) {
    if irq >= 8 {
        io.out8(PIC2_COMMAND, 0x20)
    }
    io.out8(PIC1_COMMAND, 0x20)
}

unsafe fn init_local_apic() {
    let base: u64 = cpu.read_msr(APIC_BASE_MSR)
    cpu.write_msr(APIC_BASE_MSR, base | APIC_ENABLE)
    let apic: usize = base & 0xFFFFF000
    memory.write<u32>(apic + APIC_SPURIOUS, 0x1FF)
    memory.write<u32>(apic + APIC_EOI, 0)
}

unsafe fn init_identity_paging() {
    zero_region(PML4_BASE, PAGE_SIZE)
    zero_region(PDPT_BASE, PAGE_SIZE)
    zero_region(PAGE_DIRECTORY_BASE, PAGE_SIZE)
    memory.write<u64>(PML4_BASE, PDPT_BASE | 3)
    memory.write<u64>(PDPT_BASE, PAGE_DIRECTORY_BASE | 3)
    let index: usize = 0
    while index < 512 {
        let frame: usize = index * HUGE_PAGE_SIZE
        memory.write<u64>(PAGE_DIRECTORY_BASE + index * 8, frame | 0x83)
        index += 1
    }
    let cr4: u64 = cpu.read_cr4()
    cpu.write_cr4(cr4 | 0x20)
    cpu.write_cr3(PML4_BASE)
}

unsafe fn frame_allocator_init(start: usize, end: usize) {
    FRAME_MEMORY_MAP_ACTIVE = false
    NEXT_FRAME = align_up(start, PAGE_SIZE)
    if NEXT_FRAME < FRAME_START {
        NEXT_FRAME = FRAME_START
    }
    FRAME_LIMIT = align_down(end, PAGE_SIZE)
    if FRAME_LIMIT > FRAME_END {
        FRAME_LIMIT = FRAME_END
    }
}

unsafe fn parse_multiboot_memory_map(boot_info: usize) -> bool {
    if boot_info == 0 {
        return false
    }
    let total_size: usize = memory.read<u32>(boot_info)
    if total_size < 16 {
        return false
    }
    let information_end: usize = boot_info + total_size
    if information_end < boot_info {
        return false
    }
    BOOT_INFO_START = boot_info
    BOOT_INFO_END = align_up(information_end, 8)
    let tag: usize = boot_info + 8
    while tag + 8 <= information_end {
        let tag_type: u32 = memory.read<u32>(tag)
        let tag_size: usize = memory.read<u32>(tag + 4)
        if tag_size < 8 {
            return false
        }
        let tag_end: usize = tag + tag_size
        if tag_end < tag || tag_end > information_end {
            return false
        }
        if tag_type == MULTIBOOT_TAG_MEMORY_MAP {
            if tag_size < 16 {
                return false
            }
            let entry_size: usize = memory.read<u32>(tag + 8)
            if entry_size < MULTIBOOT_MEMORY_ENTRY_MIN_SIZE {
                return false
            }
            MEMORY_MAP_CURSOR = tag + 16
            MEMORY_MAP_END = tag_end
            MEMORY_MAP_ENTRY_SIZE = entry_size
            return MEMORY_MAP_CURSOR <= MEMORY_MAP_END
        }
        if tag_type == MULTIBOOT_TAG_END {
            return false
        }
        tag = align_up(tag_end, 8)
    }
    return false
}

unsafe fn frame_is_reserved(address: usize) -> bool {
    let frame_end: usize = address + PAGE_SIZE
    if address < FRAME_START {
        return true
    }
    if ranges_overlap(address, frame_end, BOOT_INFO_START, BOOT_INFO_END) {
        return true
    }
    return false
}

unsafe fn select_next_memory_map_region() -> bool {
    while MEMORY_MAP_CURSOR + MEMORY_MAP_ENTRY_SIZE <= MEMORY_MAP_END {
        let entry: usize = MEMORY_MAP_CURSOR
        MEMORY_MAP_CURSOR += MEMORY_MAP_ENTRY_SIZE
        let base: usize = memory.read<usize>(entry)
        let length: usize = memory.read<usize>(entry + 8)
        let entry_type: u32 = memory.read<u32>(entry + 16)
        if entry_type == MULTIBOOT_MEMORY_AVAILABLE && length >= PAGE_SIZE {
            let region_end_raw: usize = base + length
            let region_end: usize = region_end_raw
            if region_end < base || region_end > IDENTITY_MAPPED_BYTES {
                region_end = IDENTITY_MAPPED_BYTES
            }
            let region_start: usize = align_up(base, PAGE_SIZE)
            if region_start < FRAME_START {
                region_start = FRAME_START
            }
            region_end = align_down(region_end, PAGE_SIZE)
            if region_start < region_end {
                NEXT_FRAME = region_start
                FRAME_LIMIT = region_end
                return true
            }
        }
    }
    return false
}

unsafe fn frame_allocator_init_from_multiboot(boot_info: usize) -> bool {
    FRAME_MEMORY_MAP_ACTIVE = false
    if !parse_multiboot_memory_map(boot_info) {
        return false
    }
    FRAME_MEMORY_MAP_ACTIVE = true
    if !select_next_memory_map_region() {
        FRAME_MEMORY_MAP_ACTIVE = false
        return false
    }
    return true
}

pub unsafe fn frame_allocator_uses_memory_map() -> bool {
    return FRAME_MEMORY_MAP_ACTIVE
}

pub unsafe fn alloc_frame() -> usize {
    while true {
        if NEXT_FRAME + PAGE_SIZE <= FRAME_LIMIT {
            let current: usize = NEXT_FRAME
            NEXT_FRAME += PAGE_SIZE
            if !frame_is_reserved(current) {
                return current
            }
        } else {
            if !FRAME_MEMORY_MAP_ACTIVE {
                return 0
            }
            if !select_next_memory_map_region() {
                return 0
            }
        }
    }
}

unsafe fn heap_init(start: usize, bytes: usize) {
    HEAP_NEXT = start
    HEAP_END = start + bytes
}

pub unsafe fn heap_alloc(bytes: usize, alignment: usize) -> usize {
    let align: usize = alignment
    if align == 0 {
        align = 1
    }
    let mask: usize = align - 1
    let address: usize = (HEAP_NEXT + mask) & ~mask
    if address + bytes > HEAP_END {
        return 0
    }
    HEAP_NEXT = address + bytes
    return address
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
    pic_eoi(0)
}

@interrupt
pub unsafe extern "x86-interrupt" fn keyboard_interrupt(frame: *mut InterruptFrame) {
    let scan_code: u8 = io.in8(0x60)
    if scan_code == 0 {
        serial_write_byte(0)
    }
    pic_eoi(1)
}

@entry
pub unsafe extern "C" fn kernel_main() -> never {
    cpu.disable_interrupts()
    serial_init()
    serial_write_byte(0x42)
    init_gdt()
    init_idt()
    ${interruptControllerInit}
    init_identity_paging()
    let boot_info: usize = kura_boot_info()
    let memory_map_ready: bool = frame_allocator_init_from_multiboot(boot_info)
    if memory_map_ready {
        serial_write_byte(0x4D)
    } else {
        frame_allocator_init(FRAME_START, FRAME_END)
        serial_write_byte(0x46)
    }
    heap_init(HEAP_BASE, HEAP_SIZE)
    if boot_info == 0 {
        serial_write_byte(0)
    }
${mainTail}
}
`;
}
