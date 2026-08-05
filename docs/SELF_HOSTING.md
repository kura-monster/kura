# Self-host bootstrap and Kura-authored frontend

Kura contains two connected bootstrap components.

1. A compact Kura-written module emitter reproduces itself through Stage 1, Stage 2 and Stage 3. Stage 2 and Stage 3 output must be byte-identical.
2. A larger frontend module written in Kura is compiled by the trusted Stage 0 compiler and executed during every bootstrap validation.

## Kura-authored frontend logic

The frontend module now performs executable compiler work:

- deterministic lexical scanning;
- line and column tracking;
- string, number, identifier, keyword and symbol tokens;
- comment skipping and escaped-string scanning;
- delimiter balancing;
- function declaration checks;
- duplicate function detection;
- bootstrap scalar type checking;
- simple move-after-use diagnostics;
- executable AST construction for functions, parameters, local declarations, returns, assignments, calls, `if` and `while`;
- module and function symbol-table construction;
- bootstrap initializer, return-type and call-arity checking.

To support this code, the typed Kura frontend now understands arrays, indexing, assignments, compound assignments, `while`, `break`, `continue` and `null`.

## Bootstrap sequence

1. trusted Stage 0 compiles the compact Kura module emitter;
2. Stage 1 reproduces the emitter;
3. Stage 2 reproduces it again and must match Stage 3;
4. Stage 0 compiles the larger Kura frontend module;
5. the Kura frontend scans and validates itself and the probe program;
6. the reproduced module emitter compiles and executes the probe.

```bash
kr-selfhost source
kr-selfhost frontend-source
kr-selfhost manifest
kr-selfhost compile app.kr -o app.mjs
kr-selfhost bootstrap build/self-host
kr-selfhost verify build/self-host
```

This is not yet a claim that the whole production compiler is self-hosted. The complete production expression/pattern parser, generic and trait solver, full NLL borrow dataflow, LLVM backend, package manager and LSP still use trusted JavaScript implementations. The migration manifest reports those remaining components explicitly.
