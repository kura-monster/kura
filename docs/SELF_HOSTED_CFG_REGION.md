# Kura-authored CFG, region and advanced borrow analysis

Kura's bootstrap toolchain now compiles a control-flow and region analyzer written in Kura. The normal self-hosted borrow-checking path no longer relies on the older JavaScript path-plan builder.

## Control-flow graph

The analyzer receives the deterministic token stream produced by the Kura-authored frontend. For each function it constructs:

- basic blocks with source token ranges;
- fallthrough edges;
- `if` true and false execution paths;
- zero-iteration and one-iteration loop paths;
- a deterministic operation plan for every reachable modeled path.

The current graph builder covers structured Kura control flow. Irreducible graphs, exception/unwind edges and production-equivalent loop fixed points remain outside this bootstrap subset.

## Region inference

Reference declarations are connected to their last reference use independently on each path. This permits assignment after the final use rather than retaining every loan until the enclosing lexical block ends.

Reference-returning functions also receive inferred lifetime contracts. A contract records which reference parameter supplies the returned reference and whether the source is shared or mutable.

```kr
pub fn identity(value: &String) -> &String {
    return value
}
```

For the example above, the inferred output region is tied to `value`.

## Reborrows

A mutable reborrow suspends its parent mutable reference until the child region ends. Using the parent while the child remains live is rejected, while using it after the child's last use is accepted.

```kr
let root = &mut value
let child = &mut root
print(child)
print(root)
```

## Two-phase mutable receiver borrows

Known mutating receiver methods such as `push`, `insert`, `update`, `write` and `send` are modeled with separate reservation and activation operations.

```kr
values.push(values.length)
```

The receiver is reserved before argument evaluation and activated after the arguments have been evaluated. This permits reading `values.length` during the reservation phase while still rejecting conflicting mutable loans.

## Closure captures

A closure that captures a reference extends the underlying loan to the closure region. A `move` closure moves the reference into the closure; it does not silently end the referenced loan.

## Borrowing across await

A reference whose final use occurs after an `await` crosses a suspension point. The bootstrap checker rejects such a loan unless the target belongs to an explicitly stable `static.*` or `global.*` region.

This is a safety-first subset. Pinning, generator-field placement and full async state-machine region proof remain future production work.

## Trait integration

The Kura-authored trait solver now records `for<a>` higher-ranked binders and can normalize a concrete associated-type projection by substituting generic implementation parameters.

```kr
trait Iterator { type Item }
impl<T> Iterator for Box<T> { type Item = T }
```

A projection query for `Box<i32>` and `Iterator::Item` resolves to `i32`.

## CLI

```bash
kr-selfhost cfg app.kr
kr-selfhost borrow app.kr
kr-selfhost traits app.kr --trait Iterator --type 'Box<i32>' --assoc Item
kr-selfhost cfg-region-source
```

## Trust boundary

The CFG, region plan, reborrow logic, two-phase state, capture handling, await checks, HRTB parsing and projection substitution are authored in Kura and compiled by trusted Stage 0. The complete production compiler still uses JavaScript for the main parser, full MIR construction, irreducible CFG handling, Polonius-equivalent region solving, async generator lowering and LLVM emission.
