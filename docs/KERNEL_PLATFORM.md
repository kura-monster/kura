# Kura x86_64 Kernel Platform

Kura's native backend now includes a second-stage kernel platform for real operating-system work. The earlier runtime established long mode, GDT/IDT, basic paging, PIC/xAPIC access, and bump allocators. This platform adds firmware discovery, reusable memory management, virtual-page mapping, a coalescing heap, IOAPIC routing, and application-processor startup.

## Create a kernel

```bash
kr-kernel init my-kura-os
cd my-kura-os
kr-kernel build kernel.kr --out-dir build/system
```

The generated project enables ACPI, IOAPIC, and SMP by default. Compatibility options are available:

```bash
kr-kernel init pic-kernel --pic --no-smp
kr-kernel emit --smoke -o kernel-smoke.kr
```

## Automated smoke boot

```bash
kr-kernel smoke --cpus 4 --memory 256 --out-dir build/smoke
```

The smoke command performs the complete pipeline:

1. generate or read Kura kernel source
2. lower it to LLVM IR
3. emit the freestanding x86_64 object
4. assemble the Multiboot2 bootstrap
5. link the kernel ELF
6. create a GRUB ISO
7. boot QEMU with the requested CPU count
8. verify the `isa-debug-exit` result

Use `--dry-run` to inspect all external commands.

## Multiboot2 memory discovery

The runtime parses the Multiboot2 tag list and consumes memory-map tag type `6`. Usable regions are page-aligned and loaded into a physical-frame bitmap. Module ranges and the Multiboot information block are reserved after discovery.

If no valid memory map is supplied, the runtime uses a conservative fallback range so diagnostics remain possible.

Public Kura APIs:

```kr
unsafe {
    let frame: usize = alloc_frame()
    let used: bool = frame_is_used(frame)
    let returned: bool = free_frame(frame)
}

let available: usize = free_frame_count()
let discovered: u64 = detected_memory_bytes()
```

The current bitmap tracks the first 4 GiB of physical address space. Frames below the platform's reserved boundary remain unavailable to the allocator.

## Four-level paging

The bootstrap's temporary 1 GiB map is replaced by a 4 GiB identity map after `kernel_main` starts. This makes standard xAPIC and IOAPIC MMIO addresses directly accessible.

A dedicated low-memory page-table pool supports normal 4 KiB mappings outside the identity-mapped PML4 branch:

```kr
unsafe {
    let ok: bool = map_page(
        0xFFFF800000000000,
        physical_frame,
        PTE_WRITABLE | PTE_GLOBAL | PTE_NO_EXECUTE,
    )

    let physical: usize = translate_address(0xFFFF800000000000)
    let removed: usize = unmap_page(0xFFFF800000000000)
}
```

`map_range` maps a page-aligned range and invalidates affected TLB entries. The NX bit is enabled through EFER.NXE.

## Reusable heap

The previous monotonic heap is replaced by an address-ordered free list. Allocations support power-of-two alignment up to one page. Freed blocks are inserted in address order and coalesced with adjacent blocks.

```kr
unsafe {
    let buffer: usize = heap_alloc(4096, 64)
    let zeroed: usize = heap_calloc(128, 32, 16)
    let larger: usize = heap_realloc(buffer, 8192, 64)

    heap_free(larger)
    heap_free(zeroed)
}
```

This allocator is suitable for early kernel objects and driver initialization. It is currently BSP-owned and does not yet use a cross-core lock.

## ACPI and MADT

Multiboot2 ACPI tags `14` and `15` are recognized. The runtime validates RSDP and SDT checksums, selects XSDT when available, and locates the MADT.

MADT entries currently handled:

- Processor Local APIC
- IOAPIC
- Interrupt Source Override
- Local APIC Address Override
- Processor Local x2APIC entries with IDs representable by xAPIC startup

The processor table, IOAPIC address, GSI base, and ISA interrupt overrides are stored in reserved platform memory.

## IOAPIC routing

When ACPI and an IOAPIC are available, the runtime:

1. enables the local APIC
2. masks the legacy PIC
3. masks all IOAPIC redirection entries
4. applies MADT interrupt-source overrides
5. routes timer IRQ 0 to vector 32
6. routes keyboard IRQ 1 to vector 33
7. sends EOI through the local APIC

If discovery fails, it falls back to the remapped 8259 PIC.

## SMP startup

Kura embeds a 182-byte real-mode AP trampoline. The BSP copies it to physical address `0xA000`, writes a shared mailbox at `0xB000`, and starts each enabled processor with the standard INIT-SIPI-SIPI sequence.

The AP trampoline:

1. begins in 16-bit real mode
2. loads a temporary GDT
3. enters 32-bit protected mode
4. enables PAE and IA-32e mode
5. loads the shared CR3 value
6. enters 64-bit long mode
7. loads its assigned stack
8. calls Kura's `kura_ap_main`

Each application processor then loads the shared kernel GDT and IDT, enables its local APIC, reports online status, and enters an interrupt-driven idle loop.

Current SMP limits:

- xAPIC destination IDs are limited to `0..255`
- AP startup is sequential
- the general heap is not yet cross-core locked
- scheduler and per-CPU run queues are not implemented

## JavaScript tooling API

The package exports the platform tooling through:

```js
import {
  createKernelPlatformManifest,
  createKernelPlatformSource,
  decodeMultiboot2,
  createPhysicalFrameBitmap,
  parseAcpiMadt,
  createApTrampolineBytes,
} from '@kura-lang/compiler/system/kernel-platform';
```

These helpers are also used by regression tests to validate firmware structures without booting a virtual machine.

## Validation

The platform update is validated as a real native build rather than only as generated text. The verification pipeline runs the complete package regression suite, generates an SMP smoke kernel, checks it with the Kura native frontend, lowers it to LLVM, emits both kernel and bootstrap objects, and links a freestanding ELF64 image.

The final ELF is required to contain all three entry symbols:

```text
kura_boot_entry
kernel_main
kura_ap_main
```

The QEMU command plan is also generated with two virtual CPUs to verify SMP-related toolchain arguments, while pure JavaScript fixtures validate Multiboot2 tags, the physical-frame bitmap, ACPI MADT records, IOAPIC overrides, and the AP trampoline byte image.

## Next layer

The platform is now ready for:

- spinlocks and interrupt-safe synchronization
- per-CPU storage and scheduler state
- timer calibration through HPET/APIC timer
- slab and object caches
- kernel threads and context switching
- user address spaces
- syscall entry/exit
- ELF process loading
- VFS and block-device drivers
