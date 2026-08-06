# Kura v1.0.0

Kura is a programming language and complete CLI toolchain for `.kr` files. The v1 line combines the compiler, Web application platform, Security Shield, friendly diagnostics, Velocity Engine, package management, batteries-included standard libraries, formatter, test runner, AI primitives, hot reload, standalone builds, and an editor-independent Language Server.

## Install

Kura is officially distributed as the npm package `@kura-lang/compiler`.

```bash
npm uninstall -g @kura-lang/compiler
npm install -g "https://kr.klyn.site/releases/kura-lang-compiler-1.0.0.tgz"
kr --version
kr doctor
```

## First project

```bash
kr new hello
cd hello
kr check
kr run
kr test
```

## Web project

```bash
kr-web new my-app --type browser
cd my-app
kr-web dev --open
kr-web build
kr-web preview
kr-web db create add-users
kr-web deploy docker
kr-web doctor
```

Create an HTTP API instead:

```bash
kr-web new my-api --type api
cd my-api
kr run --timeout-ms 0
```

The Web platform includes:

- `std:web` HTTP routing, middleware, JSON/forms/multipart, static files, compression, SSE, WebSocket, TLS, and graceful shutdown
- `std:http` timeout-aware HTTP client with size limits, JSON helpers, retries, exponential backoff, and `Retry-After`
- `std:browser` DOM helpers, reactive signals, storage, browser fetch, WebSocket/EventSource clients, and SPA routing
- `std:ui` Kura-native browser components, hooks, context, lazy loading, keyed DOM patching, and CSS injection
- `std:db` PostgreSQL, MySQL, SQLite, and Turso support with pooling, transactions, query building, and migrations
- `std:schema`, `std:auth`, and `std:openapi` for typed validation, sessions/OAuth/JWT/CSRF, API documentation, and generated clients
- `std:ssr`, `std:observe`, and `std:webtest` for SSR/static generation, metrics/tracing/health, load tests, and security probes
- `kr-web` browser/full-stack scaffolding, production builds, database migrations, deployment generation, and production readiness checks

See [Web platform](docs/WEB.md), [Browser builds](docs/WEB_BUILD.md), and [Full-stack ecosystem](docs/WEB_ECOSYSTEM.md).

## Implemented v1 toolchain

- Compiler and `kr` CLI
- `kr-web` Web application workflow
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

## Development

Requirements: Node.js 20 or newer.

```bash
npm test
npm run test:web
node bin/kr.mjs --version
node bin/kr-web.mjs --version
node bin/kr.mjs doctor
```

## Security

Strict mode is defense in depth rather than a complete operating-system sandbox. Use a disposable container or virtual machine for hostile code.

- [Security guide](docs/SECURITY.md)
- [Diagnostics guide](docs/DIAGNOSTICS.md)
- [Web platform](docs/WEB.md)
- [Browser builds](docs/WEB_BUILD.md)
- [Full-stack ecosystem](docs/WEB_ECOSYSTEM.md)

## License

Kura is dual-licensed under **MIT OR Apache-2.0**.
