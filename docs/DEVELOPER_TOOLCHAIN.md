# Developer toolchain

The developer toolchain provides the infrastructure required for production compiler work and runtime debugging.

## Incremental compilation

`IncrementalCompilerCache` keys artifacts by source, target, options and dependency fingerprints. Entries are persistent, invalidatable by file and prunable by age or count.

## Debug information

- DWARF 5 compile-unit and subprogram metadata generation for LLVM modules;
- Version 3 source-map generation for JavaScript output;
- breakpoint, conditional-breakpoint, stack-frame, stepping and expression-evaluation debugger model.

## Profiling and sanitizers

- nested timing regions, counters and Chrome trace events;
- address sanitizer model with red zones, out-of-bounds checks, invalid free, use-after-free and uninitialized reads;
- race detector model using thread epochs and locksets.

```bash
kr-dev cache-stats
kr-dev cache-clear
kr-dev dwarf examples/language/native-complete.kr
kr-dev diagnose
```
