# Kura x86_64 Kernel Runtime

Kura now has a generated early-kernel runtime for the `x86_64-unknown-none` target. It is intentionally small and explicit: every table address, selector, interrupt vector, page-table page, frame range, and heap range is visible in generated Kura source.

## Generate a kernel project

```bash
kr-system kernel-init my-kura-os
cd my-kura-os
kr-system build-bootable kernel.kr --out-dir build/system
```

`kernel-init` creates:

```text
kernel.kr
kura-kernel.json
README.md
```

Use `--apic` to initialize the local xAPIC instead of remapping the legacy 8259 PIC. Use `--smoke` to generate a kernel that exits through QEMU's `isa-debug-exit` device after initialization.

## Runtime components

The generated runtime currently contains:

- a long-mode GDT and descriptor loader
- a 256-entry IDT
- handlers for divide-by-zero, breakpoint, invalid opcode, double fault, general protection, page fault, timer, and keyboard interrupts
- 8259 PIC remapping and EOI handling
- optional xAPIC MSR/MMIO initialization
- an identity-mapped first GiB using 2 MiB pages
- CR2/CR3/CR4 and TLB-control intrinsics
- a page-aligned physical-frame bump allocator
- an aligned early-kernel heap bump allocator
- COM1 and QEMU/Bochs debug-port output
- a Multiboot2 bootstrap that transitions from 32-bit protected mode to 64-bit long mode

The allocator is intentionally an early-boot allocator. It does not reclaim frames or heap blocks yet.

## Boot pipeline

`build-bootable` produces two objects and links them together:

```text
kernel.ll
kernel.o
kura-bootstrap.S
kura-bootstrap.o
kura-linker.ld
kernel.elf
```

The generated bootstrap performs the minimum machine transition:

1. receives the Multiboot2 boot information pointer from GRUB
2. creates an initial 1 GiB identity map
3. enables PAE and IA-32e mode
4. loads a temporary 64-bit GDT
5. enters long mode
6. installs a 64 KiB bootstrap stack
7. calls Kura's `kernel_main`

Kura code can read the saved Multiboot2 pointer through:

```kr
extern "C" fn kura_boot_info() -> usize;
```

## QEMU smoke boot

Generate a smoke kernel and run it:

```bash
kr-system kernel-init smoke-kernel --smoke
kr-system qemu-smoke smoke-kernel/kernel.kr --out-dir smoke-kernel/build/smoke
```

This requires:

- `clang` or `llc`
- `clang` or GNU `as`
- `ld.lld` or GNU `ld`
- `grub-mkrescue`
- `qemu-system-x86_64`

The smoke kernel writes progress bytes to port `0xE9` and exits through port `0xF4`. A successful QEMU debug-exit is treated as a passing test rather than a command failure.

Use `--dry-run --json` to inspect every external command without executing it.

## New low-level intrinsics

```kr
unsafe {
    let handler: usize = function.address(page_fault)

    cpu.load_gdt(gdt_descriptor_address)
    cpu.load_idt(idt_descriptor_address)
    cpu.reload_kernel_segments()
    cpu.load_task_register(0x18)

    let fault: u64 = cpu.read_cr2()
    let page_table: u64 = cpu.read_cr3()
    cpu.write_cr3(page_table)
    cpu.invalidate_page(virtual_address)

    let apic_base: u64 = cpu.read_msr(0x1B)
    cpu.write_msr(0x1B, apic_base | 0x800)

    io.wait()
    cpu.wait_for_interrupt()
}
```

All operations that can alter machine state require an `unsafe` context.

## Validation

The implementation is validated through both language-level and binary-level checks:

```bash
npm test
kr-system check examples/system/kernel-runtime.kr
kr-system check examples/system/qemu-smoke.kr
kr-system bootstrap -o /tmp/kura-bootstrap.S
kr-system build-bootable examples/system/qemu-smoke.kr --out-dir /tmp/kura-kernel-build
```

The validation pipeline verifies that these files are non-empty:

```text
qemu-smoke.o
kura-bootstrap.o
qemu-smoke.elf
```

It also inspects the final ELF header, section table, and symbol table, requiring both `kura_boot_entry` and `kernel_main` to be present. The package regression suite is executed on Ubuntu and Windows with Node.js 20, 22, and 24.

## Current boundary

This stage supplies a real boot bridge and early architecture runtime. It does not yet provide:

- Multiboot2 memory-map parsing and reserved-region filtering
- reusable physical-frame deallocation
- per-address-space page-table objects
- a general-purpose heap allocator
- ACPI RSDP/XSDT and MADT discovery
- IOAPIC routing
- SMP application-processor startup
- userspace privilege transitions and system calls

The next layer starts with the Multiboot2 memory map, replaces fixed allocator ranges with discovered usable memory, and then builds reusable virtual-memory and heap allocators on top of it.
