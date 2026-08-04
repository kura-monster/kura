# Kura v1.0.0

Kura is a programming language and complete CLI toolchain for `.kr` files. The v1 line combines the compiler, Security Shield, friendly diagnostics, Velocity Engine, package management, batteries-included standard libraries, formatter, test runner, AI primitives, hot reload, standalone builds, and an editor-independent Language Server.

## Install

Kura is officially distributed as the npm package `@kura-lang/compiler`.
Until the public npm Registry release is published, install the verified package tarball through npm:

```bash
npm uninstall -g @kura-lang/compiler
npm install -g "https://kr.klyn.site/releases/kura-lang-compiler-1.0.0.tgz"

kr --version
kr doctor
```

Official package metadata:

```text
Package: @kura-lang/compiler@1.0.0
File: kura-lang-compiler-1.0.0.tgz
Size: 79,259 bytes
SHA-256: 3378cd9f0a58d3f27edbb6af1c526e58c0939dceb55f387a709780822ec93d3f
```

## First project

```bash
kr new hello
cd hello
kr check
kr run
kr test
```

## Implemented v1 toolchain

- Compiler and `kr` CLI
- Security Shield and `kr run --secure`
- Friendly diagnostics with stable error codes
- Velocity Engine and `kr bench`
- Script-free package manager with lockfile and integrity verification
- Batteries-included `std:` modules
- Built-in formatter and test runner
- `Kura.ai` and `std:"ai"`
- `kr dev` hot reload server
- `kr build --standalone`
- Editor-independent Language Server through `kr lsp --stdio`

## Editor integration

Kura officially supports the CLI and generic Language Server rather than a specific editor extension.
Configure the following command in an LSP-compatible editor:

```bash
kr lsp --stdio
```

The former Kura VS Code 0.1.0 and 0.1.1 extensions are preserved only as archived experiments on the official website.

## Development

Requirements: Node.js 20 or newer.

```bash
npm test
node bin/kr.mjs --version
node bin/kr.mjs doctor
```

The repository is the public development home for Kura. Release tarballs are reproducibly generated, SHA-256 verified, synchronized to managed storage, and exposed through the official Download Center.

## Security

```bash
kr check --secure
kr run --secure
kr security audit
```

Strict mode is defense in depth rather than a complete operating-system sandbox. Use a disposable container or virtual machine for hostile code.

- [Security guide](docs/SECURITY.md)
- [Diagnostics guide](docs/DIAGNOSTICS.md)
- [Official documentation](https://kr.klyn.site/docs)
- [Download Center](https://kr.klyn.site/download)
- [VS Code experiment archive](https://kr.klyn.site/vscode)

## Native hardware drivers and expanded self-hosting

Kura can generate a bootable scheduler/userspace kernel with NVMe, xHCI/HID, VirtIO-Net, and framebuffer driver foundations:

```bash
kr-hardware manifest --json
kr-hardware kernel -o kernel-hardware.kr
kr-hardware build --out-dir build/hardware
```

The Kura-written self-host compiler now emits multi-function modules, handles scalar type annotations, async function syntax, and mutable/immutable bindings, and verifies a Stage 2/Stage 3 fixed point:

```bash
kr-selfhost manifest
kr-selfhost compile app.kr -o app.mjs
kr-selfhost bootstrap build/self-host
```

See `docs/HARDWARE_DRIVERS.md` and `docs/SELF_HOSTING.md` for the exact supported scope.

## License

Kura is dual-licensed under **MIT OR Apache-2.0**. See `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`, and `NOTICE`.


## Native ownership and safety

Kura native code can enable strict move, borrow, lifetime, Send/Sync, shared-memory, and unsafe-contract checking:

```kr
#![ownership("strict")]
#![deny_undocumented_unsafe]
```

Use `kr-safety check <file.kr>` for strict validation and `kr-safety audit <file.kr>` for migration reports. See `docs/NATIVE_SAFETY.md`.
