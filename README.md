# Kura v1.0.0

Install:

```powershell
npm install -g https://kr.klyn.site/Kura-v1.tgz
kr --version
kr new hello
cd hello
kr run
```

Commands: `new`, `run`, `build`, `check`, `fmt`, `bindgen`, `sql-check`, `gpu doctor`, `gpu init`, `doctor`, `version`.

## Security Shield

Run trusted projects normally:

```bash
kr check
kr run
```

Use strict mode for reviewed code that should receive minimal capabilities:

```bash
kr check --secure
kr run --secure
kr security audit
```

Kura blocks remote executable imports, unsafe configuration paths, symbolic-link output attacks, cache tampering, `NODE_OPTIONS` injection, and oversized compiler inputs. Strict mode also uses Node permissions, filters sensitive environment variables, disables native addons, and applies time and memory limits.

Strict mode is defense in depth rather than a complete OS sandbox. Use a disposable container or virtual machine for hostile code.

## Friendly error messages

```bash
kr check
kr check --json
kr check --verbose
```

Human diagnostics include a stable error code, source location, code frame, caret, explanation, and repair hint. JSON mode is suitable for editors and CI.

- [Security guide](docs/SECURITY.md)
- [Diagnostics guide](docs/DIAGNOSTICS.md)
