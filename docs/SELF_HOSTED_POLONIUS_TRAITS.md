# Kura-authored Polonius-style regions and advanced trait selection

Kura's bootstrap compiler now contains Kura-authored analysis for region facts, loop-carried state, variance, pinned generator fields, negative implementations, specialization ordering and recursive associated-type projection.

## Region facts

The CFG/region analyzer emits deterministic facts for each modeled execution path:

- `loan_issued`;
- `loan_live`;
- `loan_killed`;
- `requires`;
- `invalidates`;
- `cfg_edge`;
- `suspends`;
- `pinned`.

A monotone closure pass propagates live loans across CFG points until no new fact is produced or the safety limit is reached. The report includes the number of iterations and whether the closure converged.

This is Polonius-inspired bootstrap analysis, not a claim of full rustc/Polonius equivalence. Universal regions, placeholder loans, subset errors across arbitrary MIR, unwind edges and irreducible graphs remain production work.

## Loop fixed points

Structured `while` bodies are unfolded through a second modeled iteration and then passed through a state transfer loop. Move and pin state is repeatedly transferred until stable. A value moved in one iteration and moved again in a later iteration is diagnosed.

```kr
pub fn broken(mut value: String, condition: bool) -> String {
  while condition {
    move value
  }
  return value
}
```

The bootstrap graph remains structured and conservative. It does not yet model arbitrary backedges, `break` values, exception edges or production-equivalent loop widening.

## Variance and lifetime substitutions

Generic fields are classified in the bootstrap subset:

```kr
struct Shared<T> { value: &T }      // T is covariant
struct Unique<T> { value: &mut T }  // T is invariant
```

Reference-returning function contracts also produce output-to-input lifetime substitutions. Shared output references are covariant; mutable output references are invariant.

## Pinned generator borrows

`pin(value)` is recognized as a bootstrap analysis intrinsic. A reference to the pinned path may cross an `await`, and the analyzer records the reference as a generator field with stable storage.

```kr
pub async fn pinned(mut value: String) -> String {
  pin(value)
  let view = &value
  await task()
  print(view)
  return value
}
```

This proves only the bootstrap model. Native generator layout, address stability after lowering, projection safety and a complete `Pin` API remain separate compiler work.

## Negative implementations and specialization

The trait solver supports negative implementations and a deterministic default/specific selection subset:

```kr
trait Show { type Out }
struct Box<T> { value: T }

default impl<T> Show for Box<T> { type Out = T }
impl Show for Box<i32> { type Out = String }

trait Send { type Marker }
struct Never {}
impl !Send for Never {}
```

A non-default, more-specific implementation wins over a default blanket implementation. Equal-ranked overlaps are rejected. Positive/negative overlap is rejected rather than silently ordered.

## Recursive associated-type projection

The bootstrap normalization syntax is:

```kr
Iterator::Item<Box<T>>
```

Projection normalization substitutes generic implementation parameters and recursively resolves nested projection values with a depth limit.

```bash
kr-selfhost traits app.kr --trait Wrapper --type 'Box<i32>' --assoc Output
kr-selfhost cfg app.kr
kr-selfhost regions app.kr
kr-selfhost borrow app.kr
```

## Trust boundary

The fact generator, closure pass, loop state transfer, variance classifier, generator layout model, negative implementation handling, specialization ranking and recursive projection normalization are authored in Kura and compiled by trusted Stage 0. The production parser, full MIR, complete Polonius relations, Chalk-style canonicalization, native generator lowering and LLVM emission are not yet fully self-hosted.
