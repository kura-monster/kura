# Security Shield

Kura v1 includes a hardened compiler and CLI security layer.

## Strict execution

```bash
kr run --secure
```

Strict mode enables the strongest built-in restrictions:

- Node permission model, when supported by the installed Node version
- no native addons
- project-scoped filesystem access
- sensitive environment variable filtering
- `NODE_OPTIONS` and `NODE_PATH` removal
- 256 MiB default heap limit
- 30-second default timeout
- dangerous Node module blocking
- third-party package blocking unless reviewed and vendored locally

Change the resource limits explicitly:

```bash
kr run --secure --timeout-ms 120000 --memory-mb 512
```

Preserve a required secret only after reviewing the program:

```bash
kr run --secure --allow-env DATABASE_URL
```

## Security audit

```bash
kr security audit
```

For CI:

```bash
kr security audit --json
```

High-severity findings return exit code 1.

## Cache integrity

Velocity Engine cache files are signed with a project-local HMAC key. Kura verifies the signature before importing cached JavaScript. Invalid or modified entries are deleted and rebuilt.

## Important boundary

`--secure` is defense in depth, not a replacement for OS isolation. Run unknown hostile code inside a disposable container or virtual machine without credentials or private files.
