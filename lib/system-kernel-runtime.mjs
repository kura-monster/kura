// SPDX-License-Identifier: MIT OR Apache-2.0

const PAGE_SIZE = 0x1000;
const HUGE_PAGE_SIZE = 0x200000;
const IDT_BYTES = 256 * 16;

export const DEFAULT_KERNEL_MEMORY_LAYOUT = Object.freeze({
  gdt: 0x1000,
  gdtDescriptor: 0x1100,
  idt: 0x2000,
  idtDescriptor: 0x3000,
  pml4: 0x4000,
  pdpt: 0x5000,
  pageDirectory: 0x6000,
  heap: 0x1000000,
  heapSize: 0x200000,
  frameStart: 0x2000000,
  frameEnd: 0x8000000,
});

function integer(name, value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function aligned(name, value, alignment = PAGE_SIZE) {
  integer(name, value, alignment);
  if (value % alignment !== 0) throw new TypeError(`${name} must be aligned to ${alignment} bytes.`);
  return value;
}

function hex(value) {
  return `0x${value.toString(16).toUpperCase()}`;
}

export function createKernelArchitectureManifest(options = {}) {
  const source = { ...DEFAULT_KERNEL_MEMORY_LAYOUT, ...(options.layout ?? options) };
  const layout = {
    gdt: aligned('gdt', source.gdt, 8),
    gdtDescriptor: aligned('gdtDescriptor', source.gdtDescriptor, 2),
    idt: aligned('idt', source.idt, 16),
    idtDescriptor: aligned('idtDescriptor', source.idtDescriptor, 2),
    pml4: aligned('pml4', source.pml4),
    pdpt: aligned('pdpt', source.pdpt),
    pageDirectory: aligned('pageDirectory', source.pageDirectory),
    heap: aligned('heap', source.heap),
    heapSize: aligned('heapSize', source.heapSize),
    frameStart: aligned('frameStart', source.frameStart),
    frameEnd: aligned('frameEnd', source.frameEnd),
  };
  if (layout.frameEnd <= layout.frameStart) throw new TypeError('frameEnd must be greater than frameStart.');

  const regions = [
    { name: 'gdt', start: layout.gdt, end: layout.gdt + 0x100 },
    { name: 'gdtDescriptor', start: layout.gdtDescriptor, end: layout.gdtDescriptor + 16 },
    { name: 'idt', start: layout.idt, end: layout.idt + IDT_BYTES },
    { name: 'idtDescriptor', start: layout.idtDescriptor, end: layout.idtDescriptor + 16 },
    { name: 'pml4', start: layout.pml4, end: layout.pml4 + PAGE_SIZE },
    { name: 'pdpt', start: layout.pdpt, end: layout.pdpt + PAGE_SIZE },
    { name: 'pageDirectory', start: layout.pageDirectory, end: layout.pageDirectory + PAGE_SIZE },
    { name: 'heap', start: layout.heap, end: layout.heap + layout.heapSize },
    { name: 'frames', start: layout.frameStart, end: layout.frameEnd },
  ].sort((left, right) => left.start - right.start);

  for (let index = 1; index < regions.length; index++) {
    const previous = regions[index - 1];
    const current = regions[index];
    if (current.start < previous.end) {
      throw new TypeError(`Kernel memory regions overlap: ${previous.name} and ${current.name}.`);
    }
  }

  return Object.freeze({
    architecture: 'x86_64',
    target: 'x86_64-unknown-none',
    pageSize: PAGE_SIZE,
    hugePageSize: HUGE_PAGE_SIZE,
    identityMappedBytes: 0x40000000,
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
    }),
    layout: Object.freeze(layout),
    regions: Object.freeze(regions.map(region => Object.freeze(region))),
  });
}

export function createX86_64BootstrapAssembly(options = {}) {
  const kernelEntry = options.kernelEntry ?? 'kernel_main';
  const bootEntry = options.bootEntry ?? 'kura_boot_entry';
  if (!/^[A-Za-z_.$][A-Za-z0-9_.$-]*$/.test(kernelEntry)) throw new TypeError('Invalid kernel entry symbol.');
  if (!/^[A-Za-z_.$][A-Za-z0-9_.$-]*$/.test(bootEntry)) throw new TypeError('Invalid boot entry symbol.');
  return `/* SPDX-License-Identifier: MIT OR Apache-2.0 */
.section .multiboot2,"a"
.align 8
mb2_header_start:
  .long 0xE85250D6
  .long 0
  .long mb2_header_end - mb2_header_start
  .long -(0xE85250D6 + 0 + (mb2_header_end - mb2_header_start))
  .short 0
  .short 0
  .long 8
mb2_header_end:

.section .bootstrap,"ax"
.code32
.global ${bootEntry}
.type ${bootEntry}, @function
.extern ${kernelEntry}
${bootEntry}:
  cli
  movl %ebx, boot_info_pointer
  movl $boot_stack_top, %esp

  xorl %ecx, %ecx
1:
  movl %ecx, %eax
  shll $21, %eax
  orl $0x83, %eax
  movl %eax, page_directory(,%ecx,8)
  movl $0, page_directory+4(,%ecx,8)
  incl %ecx
  cmpl $512, %ecx
  jne 1b

  movl $page_directory, %eax
  orl $0x03, %eax
  movl %eax, pdpt_table
  movl $0, pdpt_table+4

  movl $pdpt_table, %eax
  orl $0x03, %eax
  movl %eax, pml4_table
  movl $0, pml4_table+4

  movl %cr4, %eax
  orl $0x20, %eax
  movl %eax, %cr4

  movl $0xC0000080, %ecx
  rdmsr
  orl $0x00000100, %eax
  wrmsr

  movl $pml4_table, %eax
  movl %eax, %cr3

  movl %cr0, %eax
  orl $0x80000000, %eax
  movl %eax, %cr0

  lgdt gdt64_pointer
  ljmp $0x08, $long_mode_entry

.code64
long_mode_entry:
  movw $0x10, %ax
  movw %ax, %ds
  movw %ax, %es
  movw %ax, %ss
  xorq %rbp, %rbp
  movq $boot_stack_top, %rsp
  call ${kernelEntry}
2:
  cli
  hlt
  jmp 2b

.global kura_boot_info
.type kura_boot_info, @function
kura_boot_info:
  movl boot_info_pointer(%rip), %eax
  ret

.section .rodata
.align 8
gdt64:
  .quad 0
  .quad 0x00AF9A000000FFFF
  .quad 0x00AF92000000FFFF
gdt64_end:
gdt64_pointer:
  .word gdt64_end - gdt64 - 1
  .quad gdt64

.section .bss
.align 8
boot_info_pointer:
  .long 0
.align 16
boot_stack_bottom:
  .skip 65536
boot_stack_top:
.align 4096
pml4_table:
  .skip 4096
pdpt_table:
  .skip 4096
page_directory:
  .skip 4096
`;
}

function runtimeConstants(manifest) {
  const { layout, pageSize, hugePageSize } = manifest;
  return `const GDT_BASE: usize = ${hex(layout.gdt)}
const GDT_DESCRIPTOR: usize = ${hex(layout.gdtDescriptor)}
const IDT_BASE: usize = ${hex(layout.idt)}
const IDT_DESCRIPTOR: usize = ${hex(layout.idtDescriptor)}
const PML4_BASE: usize = ${hex(layout.pml4)}
const PDPT_BASE: usize = ${hex(layout.pdpt)}
const PAGE_DIRECTORY_BASE: usize = ${hex(layout.pageDirectory)}
const PAGE_SIZE: usize = ${hex(pageSize)}
const HUGE_PAGE_SIZE: usize = ${hex(hugePageSize)}
const HEAP_BASE: usize = ${hex(layout.heap)}
const HEAP_SIZE: usize = ${hex(layout.heapSize)}
const FRAME_START: usize = ${hex(layout.frameStart)}
const FRAME_END: usize = ${hex(layout.frameEnd)}
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
    NEXT_FRAME = start
    if NEXT_FRAME < FRAME_START {
        NEXT_FRAME = FRAME_START
    }
    FRAME_LIMIT = end
    if FRAME_LIMIT > FRAME_END {
        FRAME_LIMIT = FRAME_END
    }
}

pub unsafe fn alloc_frame() -> usize {
    let current: usize = NEXT_FRAME
    if current + PAGE_SIZE > FRAME_LIMIT {
        return 0
    }
    NEXT_FRAME += PAGE_SIZE
    return current
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
    frame_allocator_init(FRAME_START, FRAME_END)
    heap_init(HEAP_BASE, HEAP_SIZE)
    if boot_info == 0 {
        serial_write_byte(0)
    }
${mainTail}
}
`;
}
