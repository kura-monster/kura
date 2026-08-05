# Self-host bootstrap and Kura-authored frontend

Kura contains two connected bootstrap components.

1. A compact Kura-written module emitter reproduces itself through Stage 1, Stage 2 and Stage 3. Stage 2 and Stage 3 output must be byte-identical.
2. A larger semantic frontend module written in Kura is compiled by the trusted Stage 0 compiler and executed during every bootstrap validation.

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
- precedence-climbing expression ASTs for literals, names, calls, arrays, indexing, unary and binary operators;
- enum-style, binding, wildcard, literal, alternative and `@` patterns;
- generic parameter and `where`-clause parsing;
- trait declaration, implementation and bound validation;
- branch-join and conservative loop move-state dataflow;
- module and function symbol-table construction;
- expression-driven initializer and return-type inference plus call-arity checking.

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
kr-selfhost semantic app.kr
kr-selfhost expression "1 + 2 * 3"
kr-selfhost pattern "Option::Some(value) | Option::None"
kr-selfhost bootstrap build/self-host
kr-selfhost verify build/self-host
```

This is not yet a claim that the whole production compiler is self-hosted. The Kura-authored frontend now owns a meaningful subset of expression parsing, pattern parsing, generic constraints and move dataflow. The complete production declaration/pattern grammar, associated types and coherence solver, path-sensitive NLL, LLVM backend, package manager and LSP still use trusted JavaScript implementations. The migration manifest reports those remaining components explicitly.

## Associated types and coherence

The bootstrap now compiles a separate trait solver authored in Kura. It consumes the frontend token stream and performs executable validation for:

- associated type declarations and implementation bindings;
- missing, duplicate and unknown associated type bindings;
- local trait and local type discovery for the orphan rule;
- exact and generic-shape implementation matching;
- overlapping implementation detection;
- concrete trait obligation lookup with associated type results.

```bash
kr-selfhost trait-solver-source
kr-selfhost traits examples/language/associated-borrow.kr --trait Iterator --type Numbers
```

The solver is intentionally smaller than the production solver. It does not yet normalize recursive projections such as `T::Item::Output`, prove higher-ranked bounds, or implement specialization ordering. Those remain in the trusted production frontend.

## Path-sensitive NLL borrow core

A second Kura-authored module now evaluates normalized control-flow paths. The JavaScript bootstrap currently constructs the path plan from the Kura token stream; the actual loan state, field-path overlap, move state and last-use expiration are evaluated by Kura code.

Supported checks include:

- shared-versus-mutable and mutable-versus-any-loan conflicts;
- field-sensitive paths such as `user.name` versus `user.age`;
- moves and assignments while a loan remains live;
- use-after-move and repeated moves;
- assignment-based reinitialization;
- separate `if`/`else` paths and zero/one-iteration loop paths;
- non-lexical loan expiration at the final use of a reference on each path.

```bash
kr-selfhost borrow examples/language/associated-borrow.kr
```

This is the start of the production borrow-checker migration, not a full replacement. Complete CFG construction, region-variable inference, reborrowing, two-phase borrows, closure captures, async suspension points and interprocedural lifetime constraints still use trusted implementations.

## CFG/region bootstrap artifacts

Bootstrap output now includes `cfg-region.kr` and `cfg-region-stage0.mjs`. Verification reloads this analyzer and checks that it builds a valid function CFG and region plan before the Kura-authored borrow checker runs.
