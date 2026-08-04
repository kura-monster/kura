# Self-host bootstrap

Kura now includes a compiler written in Kura that can reproduce its own Stage 1 JavaScript compiler.

Bootstrap sequence:

1. the existing trusted Stage 0 compiler compiles `examples/self-host/compiler.kr`;
2. the resulting Stage 1 compiler compiles its own Kura source;
3. the reproduced Stage 2 compiler compiles the same source again;
4. Stage 2 and Stage 3 output hashes must match exactly;
5. the reproduced compiler compiles and executes a separate probe.

```bash
kr-selfhost bootstrap build/self-host
kr-selfhost verify build/self-host
```

This is a real fixed-point bootstrap for the documented bootstrap subset. It does not yet mean every production compiler subsystem has been rewritten in Kura. The bootstrap subset intentionally remains small enough to audit and is the base for progressively migrating the full parser, analyzer and code generators.
