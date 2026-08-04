# Self-host bootstrap

Kura includes a compiler written in Kura that reproduces its own Stage 1 JavaScript module compiler.

The current module-compiler stage supports:

- multiple exported and private functions;
- cross-function calls;
- synchronous and async function declarations;
- `String`, `bool`, `i32`, `u32`, and `usize` annotation erasure;
- immutable and mutable local binding lowering;
- arithmetic expressions, returns, method calls, and ordinary JavaScript-compatible function bodies.

Bootstrap sequence:

1. the existing trusted Stage 0 compiler compiles `examples/self-host/compiler.kr`;
2. the resulting Stage 1 compiler compiles its own complete Kura module;
3. the reproduced Stage 2 compiler compiles the same module again;
4. Stage 2 and Stage 3 output hashes must match exactly;
5. the reproduced compiler compiles and executes a separate multi-function probe.

```bash
kr-selfhost source
kr-selfhost manifest
kr-selfhost compile app.kr -o app.mjs
kr-selfhost bootstrap build/self-host
kr-selfhost verify build/self-host
```

This is a real fixed-point bootstrap for the documented module-compiler subset. `kr-selfhost manifest` reports the exact migrated and remaining compiler subsystems. The typed tokenizer, full parser, trait solver, borrow checker, LLVM backend, and package manager still use the trusted JavaScript implementation and will be migrated incrementally rather than being falsely reported as self-hosted.
