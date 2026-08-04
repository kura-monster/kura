# Kura Native Safety

Kura's native backend includes an opt-in strict ownership profile that checks moves, borrows, lexical lifetimes, thread-transfer traits, mutable-global contracts, and unsafe documentation before LLVM IR is emitted.

## Enable strict checking

```kr
#![no_std]
#![ownership("strict")]
```

Existing freestanding projects without the directive remain in compatibility mode. They still receive the ordinary native type and unsafe checks, while `kr-safety audit` can inspect them without forcing an immediate migration.

To require written safety justifications:

```kr
#![deny_undocumented_unsafe]
```

## Move semantics

Named structs are non-Copy by default. Passing one by value, assigning it into another owner, returning it, or calling `ownership.move` consumes the previous binding.

```kr
struct Buffer {
  pointer: *mut u8,
  length: usize,
}

extern "C" fn allocate_buffer() -> Buffer;
fn consume(buffer: Buffer) {}

fn example() {
  let buffer: Buffer = allocate_buffer()
  consume(ownership.move(buffer))
  // buffer cannot be used here
}
```

Primitive integers, booleans, and raw pointers are Copy. A struct may opt into Copy only when every field is Copy:

```kr
@copy
struct Point {
  x: i32,
  y: i32,
}
```

## Borrow checking

`&value` creates a shared borrow and `&mut value` creates an exclusive mutable borrow. Shared borrows may overlap. A mutable borrow cannot overlap another borrow.

```kr
fn inspect(buffer: *const Buffer) {}
fn modify(buffer: *mut Buffer) {}

fn example() {
  let buffer: Buffer = allocate_buffer()
  inspect(&buffer)
  modify(&mut buffer)
}
```

Borrow bindings remain active until their lexical scope ends or until explicitly ended:

```kr
let view: *const Buffer = &buffer
inspect(view)
ownership.end_borrow(view)
```

A value cannot be moved, reassigned, or mutably borrowed while a conflicting borrow is active.

## Lifetime contracts

Borrowed references cannot escape the stack value they reference. Returning a local borrow is rejected.

A function that returns one of its pointer parameters must identify the source parameter:

```kr
@returns_borrow("input")
fn identity(input: *const Buffer) -> *const Buffer {
  return input
}
```

The checker propagates a borrow returned from a function call when the argument was itself a checked borrow.

## Explicit ownership operations

```kr
ownership.move(value)
ownership.borrow(value)
ownership.borrow_mut(value)
ownership.end_borrow(reference)
ownership.drop(value)
ownership.clone_copy(value)
```

These operations have no hidden runtime allocator. They describe ownership intent to the checker and lower to normal native values or pointers.

## Send and Sync

Kura infers three traits for native structures:

- `Copy`: values may be duplicated without transferring ownership.
- `Send`: ownership may cross a thread boundary.
- `Sync`: shared references may be used from multiple threads.

Integers and booleans are Copy, Send, and Sync. Raw pointers are Copy but are not Send or Sync by default.

Unsafe trait assertions require a safety contract:

```kr
@unsafe_contract("the pointer is uniquely owned and transferred once")
@send
struct TransferBuffer {
  pointer: *mut u8,
  length: usize,
}
```

Negative assertions are also supported:

```kr
@no_send
@no_sync
struct DeviceGuard {
  register: *mut u32,
}
```

## Shared mutable memory

Mutable statics must be accessed inside `unsafe`. The audit also requires the storage policy to be explicit:

```kr
@synchronized
static mut READY_QUEUE: usize = 0

@thread_local
static mut CURRENT_CPU: u32 = 0
```

Unannotated mutable statics produce a memory-model audit finding.

## Unsafe contracts

Unsafe functions use `@unsafe_contract`:

```kr
@unsafe_contract("the caller guarantees the address is mapped and aligned")
unsafe fn write_register(address: usize, value: u32) {
  memory.volatile_write<u32>(address, value)
}
```

Unsafe blocks can carry a local justification:

```kr
unsafe("the VGA page is identity-mapped and exclusively owned during boot") {
  memory.write<u8>(0xB8000, 75)
}
```

With `#![deny_undocumented_unsafe]`, undocumented unsafe blocks, functions, and operations fail compilation.

## CLI

```bash
kr-safety check kernel.kr
kr-safety audit kernel.kr
kr-safety audit kernel.kr --json
kr-safety traits kernel.kr
kr-safety explain KR-SAFE-OWN-0002
```

`check` forces strict checking even when the source has not yet added an ownership directive. `audit` reports findings without blocking compatibility-mode projects.

## Migration strategy

1. Run `kr-safety audit` on an existing project.
2. Annotate shared mutable statics and unsafe contracts.
3. Add explicit borrows around non-owning calls.
4. Add `#![ownership("strict")]`.
5. Add `#![deny_undocumented_unsafe]` after every unsafe boundary has a written invariant.

This safety layer is intentionally conservative. Partial moves from individual struct fields and moving an outer owned value inside a repeating loop are rejected until the compiler has full place-based dataflow and drop-flag lowering.
