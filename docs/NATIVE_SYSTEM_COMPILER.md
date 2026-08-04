# Kura Native System Compiler

Kura now contains a freestanding x86_64 compilation path that is independent from Node.js at runtime.

## Supported target

```text
x86_64-unknown-none
```

## Source features

- `#![no_std]`, `#![no_main]`, `#![target(...)]`, and `#![multiboot2]`
- `@entry`, `@repr(C)`, `@repr(packed)`, `@section`, `@align`, `@link_name`, and `@interrupt`
- fixed-width integers, `usize`, `isize`, bool, arrays, named structures, and raw pointers
- compile-time constants with arithmetic, comparison, shifts, and bitwise operations
- immutable and mutable global statics
- external function declarations
- C and x86 interrupt ABIs
- local variables, branches, loops, function calls, and typed returns
- raw and volatile memory operations
- typed MMIO structure access
- x86 CPU and I/O-port intrinsics

## CLI

```bash
kr-system check kernel.kr
kr-system emit-llvm kernel.kr -o kernel.ll
kr-system emit-object kernel.kr -o kernel.o
kr-system link-elf kernel.o -o kernel.elf
kr-system build kernel.kr --out-dir build/system
kr-system emit-iso kernel.elf -o kernel.iso
kr-system run-qemu kernel.elf
kr-system toolchain
```

`build` runs the complete Kura source -> LLVM IR -> object -> ELF pipeline.

## Compile-time constants

```kr
const VGA_BASE: usize = 0xB8000
const COLOR: u8 = (1 << 4) | 15
```

Constant evaluation supports integer arithmetic, bitwise operations, shifts, comparisons, and references to other constants. Cycles and division by zero are rejected before LLVM lowering.

## Globals

```kr
@section(".data.boot")
@align(8)
static mut TICKS: u64 = 0
```

Mutable statics lower to LLVM globals. Immutable statics lower to LLVM constants. Global assignments are type checked.

## External and interrupt functions

```kr
@link_name("firmware_probe")
extern "C" fn probe(value: u32) -> u32;

@interrupt
pub extern "x86-interrupt" fn timer(frame: *mut InterruptFrame) {
  unsafe { io.out8(0x20, 0x20) }
}
```

Interrupt handlers lower with LLVM's `x86_intrcc` calling convention and cannot be called as ordinary functions.

## I/O ports

Inside an unsafe context:

```kr
let byte: u8 = io.in8(0x60)
io.out8(0x3F8, byte)
io.out16(0x1F0, 0x1234)
io.out32(0xCF8, 0x80000000)
```

## Multiboot2 and linking

`#![multiboot2]` emits a valid Multiboot2 header in `.multiboot2`. The generated linker script keeps that section first, places the kernel at 1 MiB, aligns code/data sections to 4 KiB, and discards host-only metadata.

The toolchain uses `llc` when available and falls back to `clang`. ELF linking uses `ld.lld` or GNU `ld`. ISO creation requires `grub-mkrescue`; QEMU execution requires `qemu-system-x86_64`.
