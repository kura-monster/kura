# Kura Full-Stack Web Ecosystem

This layer builds on `std:web`, `std:http`, `std:browser`, and `kr-web` and adds the application services normally required by production Web systems.

## Included modules

| Module | Purpose |
| --- | --- |
| `std:db` | PostgreSQL, MySQL, SQLite, Turso/libSQL, pooling, transactions, query building, and SQL migrations |
| `std:schema` | Runtime input validation and JSON Schema generation |
| `std:auth` | Password hashing, JWT, server sessions, OAuth2/PKCE, CSRF, API keys, RBAC, and TOTP |
| `std:openapi` | OpenAPI 3.1 documents, Swagger UI, and generated fetch clients |
| `std:ssr` | Escaped HTML, components, documents, streaming, islands, routing, and static generation |
| `std:observe` | Structured logs, Prometheus metrics, tracing, health/readiness checks, and OTLP export |
| `std:ui` | Browser components, virtual DOM patching, keyed children, hooks, context, lazy components, and CSS injection |
| `std:webtest` | HTTP test client, load tests, security probes, and schema fuzzing |
| `std:fullstack` | Convenience namespace joining the server modules |

## Database

The database layer uses explicit parameters and never interpolates values into SQL text.

```kr
import { connect, values } from std:"db";
import { getEnv } from std:"env";

async fn main() {
  let database = connect(getEnv("DATABASE_URL", "sqlite:./app.db"));
  let user = await database.table("users")
    .select("id", "name")
    .where("id", 1)
    .maybeOne();

  await database.table("users")
    .insert(values("name", "Ada"))
    .run();

  await database.close();
}
```

Supported drivers:

- PostgreSQL through the optional `pg` package
- MySQL and MariaDB through the optional `mysql2` package
- SQLite through `node:sqlite` where available, with `better-sqlite3` as a fallback
- Turso/libSQL through the HTTPS pipeline API
- deterministic memory adapters for tests

### Transactions

```js
await database.transaction(async transaction => {
  await transaction.query('UPDATE accounts SET balance = balance - ? WHERE id = ?', [100, source]);
  await transaction.query('UPDATE accounts SET balance = balance + ? WHERE id = ?', [100, destination]);
}, { isolation: 'serializable' });
```

### Migrations

Migration files are ordered SQL files:

```sql
-- up
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE
);

-- down
DROP TABLE users;
```

Commands:

```bash
kr-web db create add-users
kr-web db status --url sqlite:./app.db
kr-web db migrate --url sqlite:./app.db
kr-web db rollback --url sqlite:./app.db --steps 1
```

Applied migrations are checksum protected. Editing an already-applied migration is rejected.

## Validation

`std:schema` validates untrusted request data and emits OpenAPI-compatible JSON Schema.

```js
const createUser = object({
  email: formats.email({ maxLength: 254 }),
  age: integer({ coerce: true, min: 13 }),
  roles: array(enumeration(['user', 'admin']), { min: 1, unique: true }),
}, { unknown: 'strict' });

const value = createUser.parse(input);
const schema = createUser.toJSONSchema({ title: 'CreateUser' });
```

Available schema types include strings, numbers, integers, booleans, bigints, dates, literals, enums, arrays, tuples, objects, records, unions, intersections, optional values, nullable values, defaults, transformations, refinements, and lazy recursive schemas.

`validationMiddleware()` can validate route parameters, query strings, headers, and request bodies and returns a normalized HTTP 422 response.

## Authentication and authorization

`std:auth` includes:

- scrypt password hashes with encoded cost parameters
- constant-time password, signature, API-key, and token comparisons
- HS256 JWT signing and verification with issuer, audience, subject, expiry, not-before, clock tolerance, and maximum age checks
- opaque server-side sessions with rotation and optional browser fingerprint binding
- signed and hardened cookies
- double-submit CSRF tokens bound to a session
- hashed API keys
- hierarchical permissions such as `projects:*`
- role mapping middleware
- OAuth2 authorization-code flow with PKCE and signed state
- TOTP generation and verification

Application secrets must contain at least 32 bytes. Production deployments should generate separate values for session, CSRF, OAuth state, JWT, and API-key peppers.

## OpenAPI

```js
const api = createOpenApi({ title: 'Example API', version: '1.0.0' })
  .server('https://api.example.com')
  .securityScheme('bearer', bearerAuth())
  .schema('User', userSchema)
  .get('/users/:id', {
    operationId: 'getUser',
    parameters: [parameter('id', 'path', string())],
    responses: { 200: jsonResponse('User') },
  });
```

The builder provides:

- OpenAPI 3.1 validation
- automatic path-parameter declarations
- request and response helpers
- security schemes
- Swagger UI HTML
- stable SHA-256 checksums
- generated browser fetch clients

## SSR and static generation

HTML interpolations are escaped by default. Deliberate raw HTML must use `raw()`.

```js
const page = html`<h1>${untrustedTitle}</h1>`;
```

The SSR layer provides:

- async components
- complete HTML documents
- safe serialized state
- Node streams
- path routing
- ETag-aware SSR handlers
- static-site generation
- island markers and a hydration runtime

## Browser components

`std:ui` is the lightweight first-party component layer for Kura browser applications.

```js
const Counter = createComponent(() => {
  const [count, setCount] = useState(0);
  return h('button', { onClick: () => setCount(count + 1) }, String(count));
});

mountApp('#app', Counter);
```

It includes:

- virtual nodes and fragments
- DOM patching
- keyed child movement
- state and reducer hooks
- effects and layout effects
- memoized values and callbacks
- refs and context
- lazy-loaded components
- portals
- scoped style injection

The browser production builder recursively copies the safe standard-library graph. `std:ui` automatically brings in `std:browser`; `std:schema` can also run in browsers. Node-only modules remain rejected.

## Observability

`std:observe` includes structured JSON logging with secret redaction, Prometheus counters/gauges/histograms, active-request metrics, request IDs, trace IDs, nested asynchronous spans, health checks, readiness checks, and an OTLP/HTTP trace exporter.

Recommended endpoints:

- `/health/live`: process is running
- `/health/ready`: required dependencies are ready
- `/metrics`: authenticated Prometheus endpoint

## Deployment

```bash
kr-web deploy docker
kr-web deploy render
kr-web deploy fly
kr-web deploy railway
kr-web deploy systemd
kr-web doctor
```

The generated Docker configuration uses a non-root user, a read-only runtime filesystem, a health check, dependency-only installation, and `no-new-privileges` in Compose.

Deployment files do not contain real secrets. `.env.example` documents required variables while `.dockerignore` excludes local environment files.

## Testing and hardening

`std:webtest` provides:

- isolated HTTP clients with cookie jars
- response assertions
- concurrent load testing with latency percentiles
- common traversal, malformed-path, method, and Host probes
- schema fuzz testing

Repository CI additionally runs real HTTP, WebSocket, SSE, static-file, compression, browser-build, SSR, authentication, database-query, migration-parser, deployment, and security-probe tests on Ubuntu and Windows with Node.js 20, 22, and 24.

## Remaining boundaries

This layer makes Kura suitable for normal full-stack Web application development. It does not claim that every possible production dependency has been independently security audited.

Important boundaries:

- PostgreSQL, MySQL, and fallback SQLite use optional third-party drivers and inherit their behavior.
- Turso support uses the remote pipeline endpoint; offline embedded libSQL requires a separate native driver.
- OAuth provider-specific profile and token-revocation behavior remains application-specific.
- The UI renderer is a compact Kura-native component system, not an implementation of React compatibility.
- Browser npm bundling remains intentionally blocked; third-party browser packages require a reviewed adapter or a future bundler layer.
- Security probes and fuzzing improve confidence but do not replace an independent penetration test for high-risk applications.

## Optional browser bundling and E2E

Kura keeps the default browser build dependency-free and rejects bare npm imports. Projects that need third-party browser packages can install the reviewed `esbuild` adapter:

```bash
kr add esbuild --dev
kr-web build --bundle --sourcemap
```

Bundled builds use ESM, tree shaking, content-hashed entry/chunk/asset names, optional source maps, and dynamic code splitting. The build manifest records every emitted artifact and SHA-256 digest.

Real-browser checks use a project-local Playwright installation:

```bash
kr add playwright --dev
npx playwright install
kr-web e2e --browser chromium
```

Example `kura-e2e.json`:

```json
{
  "browser": "chromium",
  "checks": [
    {
      "name": "home page",
      "path": "/",
      "status": 200,
      "title": "Kura",
      "selector": "#app",
      "noConsoleErrors": true
    }
  ]
}
```

The E2E runner supports click, fill, key press, checkbox, select, URL wait, text assertion, timeout, screenshots on failure, console-error detection, and Chromium/Firefox/WebKit selection.
