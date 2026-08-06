# Kura Web Application Platform

Kura Web consists of three standard-library modules and the existing compiler/dev-server pipeline:

- `std:web` — Node.js HTTP application server, middleware, static files, SSE, and WebSocket
- `std:http` — production HTTP client with timeouts, size limits, retries, and JSON helpers
- `std:browser` — browser DOM helpers, reactive state, fetch, WebSocket, SSE, storage, and SPA routing

The server and browser APIs are dependency-free and use platform APIs shipped with Node.js and modern browsers.

## HTTP server

```kr
import {
  createApp,
  object,
  json,
  securityHeaders,
  cors,
  compression
} from std:"web";
import { getEnv } from std:"env";

fn health(context) {
  return json(object(
    "status", "ok",
    "path", context.path,
    "requestId", context.requestId
  ));
}

async fn main() {
  let app = createApp();
  app.use(securityHeaders());
  app.use(cors());
  app.use(compression());
  app.get("/health", health);

  let port = int(getEnv("PORT", "3000"));
  await app.listen(port, "0.0.0.0");
  println("Kura Web listening on port " + str(port));
}
```

Run it with:

```bash
kr run examples/web-server.kr --timeout-ms 0
```

`--timeout-ms 0` is required for a trusted long-running server because secure execution uses a finite timeout by default.

## Routes

Supported methods:

```kr
app.get("/users/:id", showUser);
app.post("/users", createUser);
app.put("/users/:id", replaceUser);
app.patch("/users/:id", updateUser);
app.delete("/users/:id", deleteUser);
app.any("/health", health);
```

Route patterns support:

- static paths: `/health`
- named parameters: `/users/:id`
- optional parameters: `/files/:name?`
- wildcards: `/assets/*`

Request values are available through the context:

```kr
let id = context.param("id");
let page = context.query("page", "1");
let token = context.header("authorization");
let session = context.cookie("session");
let ip = context.ip;
```

## Request bodies

```kr
async fn createUser(context) {
  let input = await context.json();
  return json(object("created", true, "name", input.name), 201);
}
```

Available readers:

- `context.bodyBytes()`
- `context.text()`
- `context.json()`
- `context.form()`
- `context.multipart()`

All readers enforce the configured body limit. JSON and form readers validate the request content type.

## Responses

```kr
return text("hello");
return html("<h1>Hello</h1>");
return json(object("ok", true));
return redirect("/login");
return empty(204);
return problem(400, "Bad Request", "A field is missing", "INVALID_INPUT");
```

Use `object()` when constructing JSON objects from Kura source:

```kr
let payload = object(
  "name", "Kura",
  "version", 1,
  "features", ["http", "websocket", "browser"]
);
```

Prototype-sensitive keys are rejected.

## Middleware

Middleware uses the conventional `context, next` shape. Applications can use the built-in middleware directly:

```kr
app.use(securityHeaders());
app.use(cors());
app.use(compression());
app.use(timeout(10000));
app.use(rateLimit());
app.use(requestLogger());
```

Included middleware:

- CORS and preflight handling
- secure response headers and HSTS
- request timeout
- in-memory rate limiting
- JSON request logging
- gzip and Brotli compression
- static-file serving

The in-memory rate limiter is suitable for one process. Multi-instance deployments should use an external distributed rate-limit store in a later adapter layer.

## Static files

```kr
app.use(staticFiles("public"));
```

The static middleware provides:

- path traversal and dotfile protection
- MIME detection
- `ETag` and `Last-Modified`
- conditional `304` responses
- byte ranges and `206` responses
- cache-control configuration
- index files

## WebSocket

```kr
fn chat(socket, context) {
  socket.onMessage(chatMessage);
}

fn chatMessage(value, messageType, socket) {
  socket.send("echo: " + str(value));
}

async fn main() {
  let app = createApp();
  app.websocket("/chat/:room", chat);
  await app.listen(3000, "0.0.0.0");
}
```

The implementation validates the RFC 6455 handshake, requires masked client frames, supports fragmentation, ping/pong, close frames, text/binary messages, and configured message-size limits.

## Server-Sent Events

```kr
fn events(stream, context) {
  stream.send(object("ready", true), "ready", "1");
}

app.get("/events", sse(events));
```

The SSE wrapper supplies `send`, `comment`, and `close` and can emit keep-alive comments.

## HTTP client

```kr
import { getJson, postJson, options, query } from std:"http";

async fn main() {
  let result = await getJson(
    "https://api.example.com/items",
    options(
      "timeoutMs", 10000,
      "retries", 2,
      "query", query("page", 1)
    )
  );
  println(result);
}
```

The client provides:

- request timeout and abort propagation
- maximum response size
- JSON and form encoding
- retry status/method policy
- exponential backoff with jitter
- `Retry-After` support
- response status, headers, elapsed time, bytes, text, and JSON helpers

Non-idempotent methods are not retried unless explicitly enabled.

## Browser applications

```kr
import {
  ready,
  byId,
  on,
  setText,
  signal,
  queryString
} from std:"browser";

let count = signal(0);

fn render(value, previous) {
  setText("#count", value);
}

fn increment(event) {
  count.set(count.get() + 1);
}

async fn main() {
  await ready();
  count.subscribe(render);
  on("#increment", "click", increment);
  println(queryString("screen", "counter"));
}
```

Start browser development mode:

```bash
kr dev examples/browser-app.kr --browser --public-dir examples/browser-public --open
```

The dev server compiles Kura to browser ESM, serves browser-safe `std:` modules, injects the application module, and reloads the page after source or asset changes.

### Browser module features

- DOM selection and construction
- safe attribute/event helpers
- append, replace, remove, clear, and mount
- signals, computed values, and effects
- local/session storage wrappers
- forms and query-string building
- fetch with JSON and timeout support
- WebSocket client wrapper
- EventSource/SSE wrapper
- history-based SPA router with route parameters

`setHtml()` intentionally accepts raw HTML. Use `setText()` for untrusted content, or call `escapeHtml()` before inserting generated markup.

## Deployment

A Kura HTTP server is a normal long-running Node.js application. Bind to `0.0.0.0` and read `PORT` from the environment on Render, Railway, Fly.io, containers, or similar platforms.

Minimum production practices:

1. Place TLS at a trusted reverse proxy or use `listenTls()` with managed certificates.
2. Enable `securityHeaders()`.
3. Configure explicit CORS origins when credentials are used.
4. Keep body and WebSocket size limits finite.
5. Use external session, queue, cache, and rate-limit stores for multi-instance deployment.
6. Validate all application input and authorization rules.
7. Handle graceful shutdown by closing the returned listener.
8. Keep Node.js and dependencies updated.

## Current compatibility

The platform targets Node.js 20 or newer and modern evergreen browsers.

This layer completes the dependency-free HTTP/WebSocket/browser foundation. Higher-level ecosystem work remains separate: database drivers and ORM adapters, authentication providers, OpenAPI generation, production browser bundling for npm dependencies, SSR, and framework integrations.