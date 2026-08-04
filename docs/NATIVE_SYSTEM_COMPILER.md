# Kura Native System Compiler

The native system compiler is the next freestanding compilation path for Kura. It is separate from the JavaScript backend and targets machines where Node.js and an operating system do not exist.

## Current target

```text
x86_64-unknown-none
```

The compiler emits LLVM IR with the x86_64 freestanding target triple and data layout.

## CLI

```bash
kr-system check examples/system/native-kernel.kr
kr-system emit-llvm examples/system/native-kernel.kr -o kernel.ll
kr-system layout examples/system/native-kernel.kr
kr-system ast examples/system/native-kernel.kr
```

`check` performs parsing, type checking, unsafe validation, structure layout validation, and LLVM lowering without writing an output file.

## Implemented source features

- `#![target("x86_64-unknown-none")]`
- `#![no_std]`
- `#![no_main]`
- `@entry`
- `@repr(C)` and `@repr(packed)`
- `pub`, `unsafe`, and `extern "C"` functions
- fixed-width integer types
- `usize`, `isize`, `bool`, `void`, and `never`
- `*const T` and `*mut T`
- local variables and immutable constants
- assignment and compound assignment
- integer arithmetic and comparisons
- `if` and `while`
- typed function calls and return values
- address-of and raw-pointer dereference
- structure field access through values and raw pointers
- C-compatible structure size, alignment, field offsets, and padding

## Memory operations

```kr
unsafe {
  let value: u32 = memory.read<u32>(0x1000)
  memory.write<u32>(0x1000, value)
  let status: u8 = memory.volatile_read<u8>(0x3F8)
  memory.volatile_write<u8>(0xB8000, 75)
}
```

Raw memory operations are rejected outside an unsafe block or unsafe function.

## Raw pointers

```kr
unsafe {
  let bytes: *mut u8 = pointer.from_address<u8>(0xB8000)
  bytes.write(75)
  bytes.offset(1).volatile_write(15)
  let first: u8 = bytes.read()
}
```

Supported pointer methods are:

- `read()`
- `volatile_read()`
- `write(value)`
- `volatile_write(value)`
- `offset(index)`

Writes through `*const T` are rejected.

## MMIO structures

```kr
@repr(C)
struct UartRegisters {
  data: u8,
  interrupt_enable: u8,
  interrupt_identification: u8,
  line_control: u8,
}

unsafe fn send(byte: u8) {
  let uart: *mut UartRegisters = pointer.from_address<UartRegisters>(0x3F8)
  uart.data = byte
}
```

Structure member access lowers to LLVM `getelementptr`. This provides the basis for typed memory-mapped device registers.

## CPU operations

```kr
unsafe {
  cpu.disable_interrupts()
  cpu.pause()
  cpu.enable_interrupts()
  cpu.breakpoint()
  cpu.halt()
}
```

These lower to the x86 instructions `cli`, `pause`, `sti`, `int3`, and `hlt` through side-effecting inline assembly.

## Example kernel

`examples/system/native-kernel.kr` demonstrates:

- a C-layout VGA cell structure
- pointer creation from the VGA text-memory address
- pointer arithmetic
- typed field stores
- normal Kura functions
- arithmetic and comparison
- an entry point that halts the CPU

## LLVM pipeline

```text
Kura source
  -> native tokenizer
  -> native AST
  -> type and unsafe validation
  -> structure layout
  -> typed control-flow lowering
  -> LLVM IR
```

The next compiler stage will invoke LLVM tools to produce freestanding object files and linkable ELF output. Following stages will add globals, constant evaluation, external declarations, interrupt calling conventions, linker scripts, and boot-image generation.
