# Kura-authored trait and borrow analysis

Kura's bootstrap toolchain contains two additional analyzers written in Kura and compiled by the trusted Stage 0 compiler.

## Trait solver

The trait solver parses the shared frontend token stream. It records traits, associated types, local nominal types and implementations. It verifies associated type completeness, the orphan rule and implementation overlap. A concrete query returns the matching implementation and its associated type bindings.

## Borrow checker

The borrow checker accepts deterministic path plans derived from the frontend token stream. Each path is checked independently. Loans expire at the final reference use, so assignments after the last use are accepted. Paths are field-sensitive: borrowing `user.name` does not block assignment to `user.age`, while assignment to `user.name` remains prohibited until the loan expires.

## Trust boundary

The two analysis engines are Kura-authored. Stage 0 still performs their compilation, and production CFG/region construction remains in JavaScript. This boundary is reported in the self-host migration manifest and bootstrap report rather than being hidden behind a complete-self-hosting claim.

## CFG and region migration

The normal borrow-checking path now receives its plan from the Kura-authored CFG and region analyzer. It supports mutable reborrows, two-phase receiver borrows, closure-capture loan extension, suspension-point checks and inferred reference-return contracts. See `SELF_HOSTED_CFG_REGION.md` for the exact modeled subset and remaining trust boundary.

The trait solver also supports `for<a>` higher-ranked binder discovery and concrete associated-type projection substitution.
