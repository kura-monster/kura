# High-level native LLVM backend

`lib/language-native-backend.mjs` lowers the typed application-language AST to LLVM IR independently of the freestanding kernel parser.

Implemented lowering:

- primitive integer, boolean, floating-point, string-pointer, reference and raw-pointer types;
- native struct layouts with alignment and field GEP operations;
- tagged algebraic enums with computed payload sizes;
- exhaustive `match` lowering through LLVM `switch` and `phi` nodes;
- explicit generic monomorphization for recorded type specializations;
- static trait implementation tables and native VTable constants;
- closure environment layouts and callable closure symbols;
- `Drop` implementation lookup and return-path destructor calls;
- `Result` construction and `?` propagation control flow;
- await-site calls connected to the native async state-machine runtime.

Commands:

```bash
kr-native-language check examples/language/native-complete.kr
kr-native-language emit examples/language/native-complete.kr -o build/native.ll
kr-native-language object examples/language/native-complete.kr -o build/native.o
kr-native-language manifest examples/language/native-complete.kr --json
```

The backend emits ordinary textual LLVM IR and can be assembled by Clang. The manifest records computed layouts, monomorphizations, VTables, closure environments, await sites and destructors.
