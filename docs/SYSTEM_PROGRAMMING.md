# Kura System Programming

Kura System is the freestanding compilation path for kernels, boot code, device drivers, embedded software, and other programs that run without Node.js or an operating-system runtime.

The first supported target is:

```text
x86_64-unknown-none
```

## Current foundation

The `@kura-lang/compiler/system` module currently provides:

- fixed-width signed and unsigned integer type definitions
- `usize`, `isize`, `bool`, `never`, pointers, and fixed-size arrays
- target-specific size and alignment calculation
- an initial Kura IR function builder
- volatile stores
- integer-to-pointer conversion
- inline assembly nodes
- LLVM IR text emission
- a minimal VGA example module

This is intentionally separate from the existing JavaScript backend. The next compiler stage will connect Kura source syntax to these system types and Kura IR operations.

## API example

```js
import {
  buildHelloVgaModule,
  emitLlvmIr,
} from '@kura-lang/compiler/system';

const llvm = emitLlvmIr(buildHelloVgaModule());
console.log(llvm);
```

The emitted module targets freestanding x86-64 and writes `K` plus a VGA text attribute to addresses `0xB8000` and `0xB8001`, then executes `hlt`.

## Intended Kura syntax

The source-language integration will support code in this direction:

```kr
#![no_std]
#![no_main]
#![target("x86_64-unknown-none")]

@entry
pub extern "C" fn kernel_main() -> never {
    unsafe {
        memory.volatile_write<u8>(0xB8000, 75)
        memory.volatile_write<u8>(0xB8001, 0x0f)
        cpu.halt()
    }

    unreachable()
}
```

The syntax above is the target design. Not every construct is parsed by the main compiler yet.

## Safety boundary

Raw pointers, volatile memory, port I/O, control registers, interrupt state, and inline assembly will require an `unsafe` context. Safe Kura code will not gain ambient access to these operations merely because a freestanding target is selected.

## Planned integration order

1. Add system keywords and structured type nodes to the parser.
2. Add `unsafe` blocks and unsafe functions.
3. Add freestanding target attributes and `extern "C"` functions.
4. Lower typed AST into Kura IR.
5. expose `kr emit llvm-ir --target x86_64-unknown-none`.
6. invoke LLVM and LLD to produce an ELF kernel.
7. add `kr run --target x86_64-unknown-none` using QEMU.
8. add interrupt ABI, port I/O, GDT, IDT, and paging primitives.
