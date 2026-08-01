# Kura v1.0.0

Kura is a security-focused programming language and toolchain for `.kr` files. The v1 line combines the compiler CLI, Security Shield, friendly diagnostics, Velocity Engine, package management, batteries-included standard libraries, formatter, test runner, AI primitives, hot reload, standalone builds, and Language Server support.

## Install the hosted stable CLI

```powershell
npm uninstall -g @kura-lang/compiler
npm cache clean --force
npm install -g "https://kr.klyn.site/Kura-v1.0.0-security.tgz"

kr --version
kr doctor
```

## VS Code

The Kura VS Code LSP MVP provides syntax highlighting, completion, real-time diagnostics, hover, signature help, go to definition, symbols, formatting, and Run/Check commands.

```powershell
$vsix = "$HOME\Downloads\Kura-VSCode-LSP-MVP-0.1.0.vsix"
Invoke-WebRequest `
  "https://kr.klyn.site/releases/Kura-VSCode-LSP-MVP-0.1.0.vsix" `
  -OutFile $vsix
code --install-extension $vsix --force
```

VSIX SHA-256:

```text
8f8bcc1cff6109a4bef154677add4db7e04cc3d1b0d34fd11109913b72e06d16
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
- `kr lsp --stdio`
- VS Code LSP MVP

## Development

Requirements: Node.js 20 or newer.

```bash
npm test
node bin/kr.mjs --version
node bin/kr.mjs doctor
```

The repository is the public development home for Kura. Complete reviewed source snapshots are also distributed as ZIP archives with SHA-256 checksums.

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
- [VS Code documentation](https://kr.klyn.site/vscode)
- [Downloads](https://kr.klyn.site/download)

## License

Kura is dual-licensed under **MIT OR Apache-2.0**. See `LICENSE`, `LICENSE-MIT`, `LICENSE-APACHE`, and `NOTICE`.
