# Kura x86_64 Kernel Runtime

Kura now has a generated early-kernel runtime for the `x86_64-unknown-none` target. It is intentionally small and explicit: every table address, selector, interrupt vector, page-table page, reserved range, and heap range is visible in generated Kura source.

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
- Multiboot2 information and memory-map tag validation
- page-aligned physical-frame allocation across discovered available-memory regions
- conservative reservation of low kernel memory and the Multiboot2 information block
- an aligned early-kernel heap bump allocator
- COM1 and QEMU/Bochs debug-port output
- a Multiboot2 bootstrap that transitions from 32-bit protected mode to 64-bit long mode

The frame allocator now consumes Multiboot2 memory-map entries whose type is `available`. It page-aligns every region, ignores memory below the configured `FRAME_START`, excludes the live Multiboot2 information block, and limits allocation to the currently identity-mapped first GiB. If the boot information or memory-map tag is missing or malformed, the runtime falls back to the configured fixed frame range instead of continuing with partially trusted data.

The heap allocator is still intentionally an early-boot bump allocator. It does not reclaim heap blocks yet. Physical frames are discovered dynamically, but frame deallocation is not implemented yet.

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

The generated kernel validates the Multiboot2 total size, walks 8-byte-aligned tags, finds tag type `6`, validates its entry size, and iterates type `1` memory entries. A successful memory-map allocator initialization writes `M` to the serial/debug stream; the validated fallback path writes `F`.

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

    let total_size: u32 = memory.read<u32>(boot_info)
    let region_base: usize = memory.read<usize>(memory_entry)

    io.wait()
    cpu.wait_for_interrupt()
}
```

All operations that can alter machine state or access raw physical memory require an `unsafe` context.

## Validation

The implementation is validated through both language-level and binary-level checks:

```bash
npm test
kr-system check examples/system/kernel-runtime.kr
kr-system check examples/system/qemu-smoke.kr
kr-system bootstrap -o /tmp/kura-bootstrap.S
kr-system build-bootable examples/system/qemu-smoke.kr --out-dir /tmp/kura-kernel-build
```

The kernel-runtime regression test compiles the generated Multiboot2 parser and region allocator through the native Kura frontend into LLVM IR. The validation pipeline also verifies that these files are non-empty:

```text
qemu-smoke.o
kura-bootstrap.o
qemu-smoke.elf
```

It inspects the final ELF header, section table, and symbol table, requiring both `kura_boot_entry` and `kernel_main` to be present. The package regression suite is executed on Ubuntu and Windows with Node.js 20, 22, and 24.

## Milestone status

Kura can now generate and link a kernel image with its own Multiboot2 entry bridge, enter x86_64 long mode, construct its initial descriptor and interrupt tables, initialize an interrupt controller, install initial paging, parse the bootloader-provided physical-memory map, filter reserved regions, allocate frames from discovered usable RAM, allocate early heap memory, and reach Kura-authored kernel code.

## Current boundary

This stage supplies a real boot bridge, early architecture runtime, and bootloader-informed physical-memory discovery. It does not yet provide:

- exact reservation of every ELF section, boot module, firmware table, and device-memory aperture
- reusable physical-frame deallocation and coalescing
- per-address-space page-table objects
- dynamic mapping beyond the initial identity-mapped first GiB
- a general-purpose heap allocator
- ACPI RSDP/XSDT and MADT discovery
- IOAPIC routing
- SMP application-processor startup
- userspace privilege transitions and system calls

The next layer builds reusable physical-frame free lists and page-table objects, then replaces the early bump heap with a reclaiming allocator before ACPI, IOAPIC, SMP, and userspace work begins.
