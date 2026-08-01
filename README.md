# Kura

Kura is a statically typed programming language and compiler toolchain targeting Node.js, browsers, WebAssembly, and native platforms.

This repository is the open-source distribution home for Kura v1.0.0.

## Source archive

Download and extract `Kura-v1.0.0-OPEN-SOURCE.zip`. It contains:

- CLI source (`bin/kr.mjs`)
- compiler and diagnostics (`lib/compiler.mjs`)
- C binding generator (`lib/bindgen.mjs`)
- compile-time SQL checks (`lib/sql.mjs`)
- GPU runtime helpers
- project templates
- smoke tests and GitHub Actions CI
- contribution and security policies

## Validate

```bash
unzip Kura-v1.0.0-OPEN-SOURCE.zip
cd kura-open-source
npm test
node bin/kr.mjs --version
node bin/kr.mjs doctor
```

## Documentation

- https://kr.klyn.site/docs
- https://kr.klyn.site/learn
- https://kr.klyn.site/llms-full.txt

## License

Kura is dual-licensed under **MIT OR Apache-2.0**, at your option.

See `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`, and `NOTICE`.

Copyright 2026 Kura contributors.
