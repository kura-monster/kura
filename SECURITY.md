# Kura Security Policy

Kura v1 uses defense in depth. No compiler or runtime can make untrusted programs completely harmless, but the toolchain is designed to block common compiler, filesystem, cache, configuration, and child-process attacks before execution.

## Supported versions

| Version | Security updates |
|---|---|
| Kura v1.x | Supported |
| Earlier prototypes | Unsupported |

## Built-in protections

- No `eval()` or `Function()` in compile-time constant folding.
- Remote, `data:`, `javascript:`, `file:`, and absolute-path imports are blocked.
- `kr run --secure` restricts risky Node modules, third-party packages, sensitive globals, filesystem permissions, native addons, secrets inherited through the environment, memory use, and execution time.
- `NODE_OPTIONS` and `NODE_PATH` are never inherited by generated programs.
- Source, configuration, schema, header, and generated-file size limits prevent unbounded memory consumption.
- `kura.json` is schema-checked, prototype-related keys are rejected, and its entry must remain inside the project.
- Generated files use atomic writes and refuse symbolic-link targets.
- Velocity cache files are stored in an owner-only directory and authenticated with an HMAC before execution.
- Recursive scanning has file-count and nesting limits and skips symbolic links.
- Friendly diagnostics redact common secret formats.
- `kr security audit` reports dangerous process, filesystem, network, dynamic-code, remote-import, and hard-coded-secret patterns.

## Security modes

### Standard mode

```bash
kr check
kr run
```

Standard mode blocks malformed and remote imports, unsafe configuration, unsafe output paths, cache tampering, and environment injection while retaining normal Node and npm interoperability.

### Strict mode

```bash
kr check --secure
kr run --secure
```

Strict mode additionally enables Node's permission model when available, blocks sensitive Node modules and unreviewed package imports, filters sensitive environment variables, disables native addons, uses a 256 MiB heap limit, and stops execution after 30 seconds unless configured otherwise.

Strict execution is not a complete operating-system sandbox. Use containers, virtual machines, disposable users, or an isolated host for hostile code.

## Project audit

```bash
kr security audit
kr security audit --json
```

A high-severity finding causes a non-zero exit status so the audit can be enforced in CI.

## Reporting a vulnerability

Do not disclose exploitable details in a public issue. Contact the repository owner privately through GitHub and include:

- affected Kura version and operating system
- minimal reproduction steps
- expected security impact
- whether the issue works in standard mode, strict mode, or both
- suggested remediation, when available

Do not include access tokens, private keys, personal data, or attacks against systems you do not own or have explicit permission to test.

## Coordinated disclosure

Maintainers will validate the report, determine affected releases, prepare a fix and regression test, and publish an advisory after users have a reasonable opportunity to update.
