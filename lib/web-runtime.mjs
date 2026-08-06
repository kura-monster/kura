// SPDX-License-Identifier: MIT OR Apache-2.0
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { brotliCompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);
const EMPTY_BODY_STATUS = new Set([101, 204, 205, 304]);
const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_HEADER_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 65_000;
const DEFAULT_STATIC_MAX_AGE = 3600;
const DEFAULT_WS_MAX_BYTES = 1024 * 1024;

const MIME_TYPES = new Map([
  ['.aac', 'audio/aac'], ['.avif', 'image/avif'], ['.bin', 'application/octet-stream'],
  ['.bmp', 'image/bmp'], ['.css', 'text/css; charset=utf-8'], ['.csv', 'text/csv; charset=utf-8'],
  ['.eot', 'application/vnd.ms-fontobject'], ['.gif', 'image/gif'], ['.gz', 'application/gzip'],
  ['.htm', 'text/html; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp3', 'audio/mpeg'], ['.mp4', 'video/mp4'], ['.oga', 'audio/ogg'], ['.ogg', 'audio/ogg'],
  ['.ogv', 'video/ogg'], ['.otf', 'font/otf'], ['.pdf', 'application/pdf'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.tar', 'application/x-tar'],
  ['.txt', 'text/plain; charset=utf-8'], ['.wasm', 'application/wasm'], ['.webm', 'video/webm'],
  ['.webp', 'image/webp'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'], ['.zip', 'application/zip'],
]);

export class WebError extends Error {
  constructor(status, message, options = {}) {
    super(String(message ?? http.STATUS_CODES[status] ?? 'Web error'), { cause: options.cause });
    this.name = 'WebError';
    this.status = normalizeStatus(status, 500);
    this.code = options.code ?? `HTTP_${this.status}`;
    this.expose = options.expose ?? this.status < 500;
    this.headers = normalizeHeaders(options.headers);
    this.details = options.details ?? null;
  }
}

export function object(...entries) {
  if (entries.length === 1 && Array.isArray(entries[0])) return objectFrom(entries[0]);
  if (entries.length % 2 !== 0) throw new TypeError('object() expects key/value pairs');
  const output = Object.create(null);
  for (let index = 0; index < entries.length; index += 2) {
    const key = String(entries[index]);
    assertSafeObjectKey(key);
    output[key] = entries[index + 1];
  }
  return output;
}

export function objectFrom(entries) {
  if (!Array.isArray(entries)) throw new TypeError('objectFrom() expects an array');
  const output = Object.create(null);
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('Each objectFrom() entry must be [key, value]');
    const key = String(entry[0]);
    assertSafeObjectKey(key);
    output[key] = entry[1];
  }
  return output;
}

export function header(name, value) { return [String(name), String(value)]; }
export function headers(...pairs) { return normalizeHeaders(pairs); }

export function response(body = null, status = 200, responseHeaders = null) {
  return { __kuraWebResponse: true, status: normalizeStatus(status, 200), headers: normalizeHeaders(responseHeaders), body };
}

export function text(value, status = 200, responseHeaders = null) {
  const result = response(String(value ?? ''), status, responseHeaders);
  setHeaderIfMissing(result.headers, 'content-type', 'text/plain; charset=utf-8');
  return result;
}

export function html(value, status = 200, responseHeaders = null) {
  const result = response(String(value ?? ''), status, responseHeaders);
  setHeaderIfMissing(result.headers, 'content-type', 'text/html; charset=utf-8');
  return result;
}

export function json(value, status = 200, responseHeaders = null) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch (error) { throw new WebError(500, 'Response value is not JSON serializable', { code: 'WEB_JSON_ENCODE', cause: error }); }
  const result = response(encoded, status, responseHeaders);
  setHeaderIfMissing(result.headers, 'content-type', 'application/json; charset=utf-8');
  return result;
}

export function bytes(value, status = 200, responseHeaders = null) {
  const result = response(toBuffer(value), status, responseHeaders);
  setHeaderIfMissing(result.headers, 'content-type', 'application/octet-stream');
  return result;
}

export function empty(status = 204, responseHeaders = null) { return response(null, status, responseHeaders); }

export function redirect(location, status = 302, responseHeaders = null) {
  const safeStatus = normalizeStatus(status, 302);
  if (![301, 302, 303, 307, 308].includes(safeStatus)) throw new RangeError('redirect() requires status 301, 302, 303, 307, or 308');
  const result = response(null, safeStatus, responseHeaders);
  result.headers.set('location', String(location));
  return result;
}

export function problem(status, title, detail = null, code = null, extra = null) {
  const payload = object('type', 'about:blank', 'title', String(title), 'status', normalizeStatus(status, 500));
  if (detail !== null) payload.detail = String(detail);
  if (code !== null) payload.code = String(code);
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      assertSafeObjectKey(key);
      payload[key] = value;
    }
  }
  const result = json(payload, payload.status);
  result.headers.set('content-type', 'application/problem+json; charset=utf-8');
  return result;
}

export function cookie(name, value, options = {}) {
  const safeName = String(name);
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(safeName)) throw new TypeError('Invalid cookie name');
  let output = `${safeName}=${encodeURIComponent(String(value))}`;
  if (options.maxAge !== undefined) output += `; Max-Age=${Math.max(0, Math.floor(Number(options.maxAge)))}`;
  if (options.expires !== undefined) output += `; Expires=${new Date(options.expires).toUTCString()}`;
  if (options.domain) output += `; Domain=${options.domain}`;
  output += `; Path=${options.path ?? '/'}`;
  if (options.httpOnly ?? true) output += '; HttpOnly';
  if (options.secure ?? true) output += '; Secure';
  const sameSite = String(options.sameSite ?? 'Lax');
  if (!['Strict', 'Lax', 'None'].includes(sameSite)) throw new TypeError('sameSite must be Strict, Lax, or None');
  output += `; SameSite=${sameSite}`;
  if (options.partitioned) output += '; Partitioned';
  return output;
}

export function clearCookie(name, options = {}) {
  return cookie(name, '', { ...options, expires: new Date(0), maxAge: 0 });
}

export function sign(value, secret) {
  const raw = String(value);
  const mac = createHmac('sha256', String(secret)).update(raw).digest('base64url');
  return `${raw}.${mac}`;
}

export function verifySigned(value, secret) {
  const raw = String(value);
  const separator = raw.lastIndexOf('.');
  if (separator < 1) return null;
  const payload = raw.slice(0, separator);
  const supplied = raw.slice(separator + 1);
  const expected = createHmac('sha256', String(secret)).update(payload).digest('base64url');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? payload : null;
}

export function createApp(options = {}) {
  return new KuraWebApp(options);
}

export class KuraWebApp {
  constructor(options = {}) {
    this.options = {
      bodyLimit: positiveInteger(options.bodyLimit, DEFAULT_BODY_LIMIT),
      headerLimit: positiveInteger(options.headerLimit, DEFAULT_HEADER_LIMIT),
      timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS),
      idleTimeoutMs: positiveInteger(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
      trustProxy: Boolean(options.trustProxy),
      exposeErrors: Boolean(options.exposeErrors),
      requestIdHeader: String(options.requestIdHeader ?? 'x-request-id').toLowerCase(),
      poweredBy: options.poweredBy === false ? null : String(options.poweredBy ?? 'Kura'),
      websocketMaxBytes: positiveInteger(options.websocketMaxBytes, DEFAULT_WS_MAX_BYTES),
    };
    this.routes = [];
    this.middlewares = [];
    this.websocketRoutes = [];
    this.errorHandler = null;
    this.notFoundHandler = null;
    this.server = null;
    this.connections = new Set();
    this.websockets = new Set();
    this.closed = false;
  }

  use(middleware) {
    if (typeof middleware !== 'function') throw new TypeError('app.use() expects a function');
    this.middlewares.push(middleware);
    return this;
  }

  route(method, routePath, handler, options = {}) {
    const normalizedMethod = String(method).toUpperCase();
    if (!METHODS.has(normalizedMethod) && normalizedMethod !== 'ANY') throw new TypeError(`Unsupported HTTP method: ${method}`);
    if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
    const compiled = compileRoute(routePath, options);
    this.routes.push({ method: normalizedMethod, path: String(routePath), handler, ...compiled });
    return this;
  }

  any(routePath, handler, options) { return this.route('ANY', routePath, handler, options); }
  get(routePath, handler, options) { return this.route('GET', routePath, handler, options); }
  head(routePath, handler, options) { return this.route('HEAD', routePath, handler, options); }
  post(routePath, handler, options) { return this.route('POST', routePath, handler, options); }
  put(routePath, handler, options) { return this.route('PUT', routePath, handler, options); }
  patch(routePath, handler, options) { return this.route('PATCH', routePath, handler, options); }
  delete(routePath, handler, options) { return this.route('DELETE', routePath, handler, options); }
  optionsRoute(routePath, handler, options) { return this.route('OPTIONS', routePath, handler, options); }

  websocket(routePath, handler, options = {}) {
    if (typeof handler !== 'function') throw new TypeError('WebSocket handler must be a function');
    const compiled = compileRoute(routePath, options);
    this.websocketRoutes.push({ path: String(routePath), handler, ...compiled });
    return this;
  }

  onError(handler) {
    if (typeof handler !== 'function') throw new TypeError('Error handler must be a function');
    this.errorHandler = handler;
    return this;
  }

  onNotFound(handler) {
    if (typeof handler !== 'function') throw new TypeError('Not-found handler must be a function');
    this.notFoundHandler = handler;
    return this;
  }

  mount(prefix, child) {
    if (!(child instanceof KuraWebApp)) throw new TypeError('app.mount() expects another Kura web app');
    const normalized = normalizeMountPrefix(prefix);
    for (const route of child.routes) this.route(route.method, `${normalized}${route.path === '/' ? '' : route.path}`, route.handler);
    for (const route of child.websocketRoutes) this.websocket(`${normalized}${route.path === '/' ? '' : route.path}`, route.handler);
    for (const middleware of child.middlewares) this.use(async (context, next) => {
      if (context.path === normalized || context.path.startsWith(`${normalized}/`)) return middleware(context, next);
      return next();
    });
    return this;
  }

  async handle(request, responseObject) {
    const context = createContext(this, request, responseObject);
    try {
      const routeMatch = matchRoute(this.routes, context.method, context.path);
      context.route = routeMatch?.route?.path ?? null;
      context.params = routeMatch?.params ?? Object.create(null);
      const finalHandler = routeMatch
        ? () => routeMatch.route.handler(context)
        : async () => this.notFoundHandler ? this.notFoundHandler(context) : problem(404, 'Not Found', `No route matches ${context.method} ${context.path}`, 'WEB_NOT_FOUND');
      const result = await runMiddleware(this.middlewares, context, finalHandler);
      await sendResult(context, result);
    } catch (error) {
      await this.#sendError(context, error);
    }
  }

  async #sendError(context, error) {
    if (context.responded || context.rawResponse.headersSent) {
      context.rawResponse.destroy(error instanceof Error ? error : undefined);
      return;
    }
    try {
      let result;
      if (this.errorHandler) result = await this.errorHandler(error, context);
      if (result === undefined) {
        const webError = normalizeError(error);
        const message = webError.expose || this.options.exposeErrors ? webError.message : 'Internal Server Error';
        result = problem(webError.status, http.STATUS_CODES[webError.status] ?? 'Error', message, webError.code, webError.details ? { details: webError.details } : null);
        for (const [name, value] of webError.headers) result.headers.set(name, value);
      }
      await sendResult(context, result);
    } catch (nested) {
      context.rawResponse.statusCode = 500;
      context.rawResponse.setHeader('content-type', 'text/plain; charset=utf-8');
      context.rawResponse.end('Internal Server Error');
      if (nested instanceof Error) process.nextTick(() => { throw nested; });
    }
  }

  async listen(port = 3000, host = '0.0.0.0') {
    return this.#listenWith(http.createServer(), port, host);
  }

  async listenTls(port, certificateFile, keyFile, host = '0.0.0.0') {
    const [cert, key] = await Promise.all([readFile(certificateFile), readFile(keyFile)]);
    return this.#listenWith(https.createServer({ cert, key }), port, host);
  }

  async #listenWith(server, port, host) {
    if (this.server) throw new Error('Kura web app is already listening');
    this.closed = false;
    this.server = server;
    server.requestTimeout = this.options.timeoutMs;
    server.headersTimeout = Math.max(this.options.timeoutMs + 1000, 5000);
    server.keepAliveTimeout = this.options.idleTimeoutMs;
    server.maxHeadersCount = this.options.headerLimit;
    server.on('request', (request, responseObject) => this.handle(request, responseObject));
    server.on('connection', socket => {
      this.connections.add(socket);
      socket.on('close', () => this.connections.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => this.#upgrade(request, socket, head));
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(normalizePort(port), String(host));
    });
    const address = server.address();
    return {
      app: this,
      server,
      address,
      port: typeof address === 'object' && address ? address.port : normalizePort(port),
      host: typeof address === 'object' && address ? address.address : String(host),
      close: timeout => this.close(timeout),
    };
  }

  async #upgrade(request, socket, head) {
    try {
      const base = `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host ?? 'localhost'}`;
      const url = new URL(request.url ?? '/', base);
      const match = matchPath(this.websocketRoutes, decodePathname(url.pathname));
      if (!match) return rejectUpgrade(socket, 404, 'WebSocket route not found');
      if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') return rejectUpgrade(socket, 400, 'Invalid Upgrade header');
      if (!headerHasToken(request.headers.connection, 'upgrade')) return rejectUpgrade(socket, 400, 'Invalid Connection header');
      if (request.headers['sec-websocket-version'] !== '13') return rejectUpgrade(socket, 426, 'Unsupported WebSocket version', { 'Sec-WebSocket-Version': '13' });
      const key = request.headers['sec-websocket-key'];
      if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return rejectUpgrade(socket, 400, 'Invalid WebSocket key');
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      const protocol = selectWebSocketProtocol(request.headers['sec-websocket-protocol'], match.route.protocols);
      const responseLines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
      if (protocol) responseLines.push(`Sec-WebSocket-Protocol: ${protocol}`);
      responseLines.push('\r\n');
      socket.write(responseLines.join('\r\n'));
      const connection = new WebSocketConnection(socket, {
        maxBytes: positiveInteger(match.route.maxBytes, this.options.websocketMaxBytes),
        protocol,
        request,
        url,
        params: match.params,
      });
      this.websockets.add(connection);
      connection.onClose(() => this.websockets.delete(connection));
      if (head?.length) connection.feed(head);
      await match.route.handler(connection, createUpgradeContext(request, url, match.params));
    } catch {
      if (!socket.destroyed) rejectUpgrade(socket, 500, 'WebSocket upgrade failed');
    }
  }

  async close(timeoutMs = 10_000) {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.closed = true;
    for (const websocket of this.websockets) websocket.close(1001, 'Server shutting down');
    const closePromise = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const timer = setTimeout(() => {
      for (const socket of this.connections) socket.destroy();
      server.closeAllConnections?.();
    }, positiveInteger(timeoutMs, 10_000));
    timer.unref?.();
    try { await closePromise; } finally { clearTimeout(timer); }
  }
}

function createContext(app, request, responseObject) {
  const encrypted = Boolean(request.socket.encrypted);
  const forwardedProto = firstForwarded(request.headers['x-forwarded-proto']);
  const protocol = app.options.trustProxy && forwardedProto ? forwardedProto : encrypted ? 'https' : 'http';
  const authority = request.headers.host ?? 'localhost';
  let url;
  try { url = new URL(request.url ?? '/', `${protocol}://${authority}`); }
  catch (error) { throw new WebError(400, 'Invalid request URL', { code: 'WEB_BAD_URL', cause: error }); }
  const method = String(request.method ?? 'GET').toUpperCase();
  const requestId = sanitizeRequestId(request.headers[app.options.requestIdHeader]) ?? randomBytes(12).toString('hex');
  const cookies = parseCookies(request.headers.cookie);
  const state = new Map();
  let bodyPromise = null;

  const context = {
    app,
    requestId,
    method,
    url,
    path: decodePathname(url.pathname),
    rawPath: url.pathname,
    queryParams: url.searchParams,
    params: Object.create(null),
    route: null,
    protocol,
    host: url.hostname,
    port: url.port || (protocol === 'https' ? '443' : '80'),
    ip: resolveIp(request, app.options.trustProxy),
    ips: resolveIps(request, app.options.trustProxy),
    secure: protocol === 'https',
    rawRequest: request,
    rawResponse: responseObject,
    responded: false,
    cookies,
    state,
    startedAt: process.hrtime.bigint(),
    header(name, fallback = null) {
      const value = request.headers[String(name).toLowerCase()];
      if (Array.isArray(value)) return value.join(', ');
      return value === undefined ? fallback : String(value);
    },
    query(name, fallback = null) { return url.searchParams.get(String(name)) ?? fallback; },
    queryAll(name) { return url.searchParams.getAll(String(name)); },
    param(name, fallback = null) { return context.params[String(name)] ?? fallback; },
    cookie(name, fallback = null) { return cookies[String(name)] ?? fallback; },
    set(name, value) { state.set(String(name), value); return value; },
    get(name, fallback = null) { return state.has(String(name)) ? state.get(String(name)) : fallback; },
    has(name) { return state.has(String(name)); },
    bodyBytes(limit = app.options.bodyLimit) {
      bodyPromise ??= readRequestBody(request, positiveInteger(limit, app.options.bodyLimit));
      return bodyPromise;
    },
    async text(limit = app.options.bodyLimit, encoding = 'utf8') { return (await context.bodyBytes(limit)).toString(encoding); },
    async json(limit = app.options.bodyLimit) {
      const contentType = parseContentType(context.header('content-type', ''));
      if (contentType.type && contentType.type !== 'application/json' && !contentType.type.endsWith('+json')) throw new WebError(415, 'Expected a JSON request body', { code: 'WEB_EXPECTED_JSON' });
      const source = await context.text(limit, contentType.charset ?? 'utf8');
      if (!source.trim()) throw new WebError(400, 'JSON request body is empty', { code: 'WEB_EMPTY_JSON' });
      try { return JSON.parse(source); }
      catch (error) { throw new WebError(400, 'JSON request body is invalid', { code: 'WEB_INVALID_JSON', cause: error }); }
    },
    async form(limit = app.options.bodyLimit) {
      const contentType = parseContentType(context.header('content-type', ''));
      if (contentType.type !== 'application/x-www-form-urlencoded') throw new WebError(415, 'Expected an URL-encoded form body', { code: 'WEB_EXPECTED_FORM' });
      return new URLSearchParams(await context.text(limit, contentType.charset ?? 'utf8'));
    },
    async multipart(limit = app.options.bodyLimit) {
      const contentType = parseContentType(context.header('content-type', ''));
      if (contentType.type !== 'multipart/form-data' || !contentType.parameters.boundary) throw new WebError(415, 'Expected a multipart/form-data body with a boundary', { code: 'WEB_EXPECTED_MULTIPART' });
      return parseMultipart(await context.bodyBytes(limit), contentType.parameters.boundary);
    },
    accepts(type) { return acceptsType(request.headers.accept, String(type)); },
    elapsedMs() { return Number(process.hrtime.bigint() - context.startedAt) / 1_000_000; },
  };

  responseObject.setHeader(app.options.requestIdHeader, requestId);
  if (app.options.poweredBy) responseObject.setHeader('x-powered-by', app.options.poweredBy);
  return context;
}

async function runMiddleware(middlewares, context, finalHandler) {
  let cursor = -1;
  const dispatch = async index => {
    if (index <= cursor) throw new Error('Middleware called next() more than once');
    cursor = index;
    const middleware = index === middlewares.length ? finalHandler : middlewares[index];
    if (!middleware) return undefined;
    return middleware(context, () => dispatch(index + 1));
  };
  return dispatch(0);
}

async function sendResult(context, result) {
  if (context.responded || context.rawResponse.writableEnded) return;
  const responseObject = context.rawResponse;
  const normalized = await normalizeResponse(result);
  responseObject.statusCode = normalized.status;
  for (const [name, value] of normalized.headers) {
    if (name === 'set-cookie' && Array.isArray(value)) responseObject.setHeader(name, value);
    else responseObject.setHeader(name, value);
  }
  let body = normalized.body;
  if (context.method === 'HEAD' || EMPTY_BODY_STATUS.has(normalized.status)) body = null;
  if (body === null || body === undefined) {
    if (!responseObject.hasHeader('content-length')) responseObject.setHeader('content-length', '0');
    context.responded = true;
    responseObject.end();
    return;
  }
  if (isReadable(body)) {
    context.responded = true;
    body.on('error', error => responseObject.destroy(error));
    body.pipe(responseObject);
    return;
  }
  if (isAsyncIterable(body)) {
    context.responded = true;
    try {
      for await (const chunk of body) {
        if (!responseObject.write(toBuffer(chunk))) await onceDrain(responseObject);
      }
      responseObject.end();
    } catch (error) { responseObject.destroy(error); }
    return;
  }
  const buffer = toBuffer(body);
  if (!responseObject.hasHeader('content-length')) responseObject.setHeader('content-length', String(buffer.length));
  context.responded = true;
  responseObject.end(buffer);
}

async function normalizeResponse(result) {
  if (result?.__kuraWebResponse === true) return result;
  if (result instanceof Response) {
    const responseHeaders = new Map();
    result.headers.forEach((value, key) => responseHeaders.set(key.toLowerCase(), value));
    return response(Buffer.from(await result.arrayBuffer()), result.status, responseHeaders);
  }
  if (result === undefined || result === null) return empty(204);
  if (Buffer.isBuffer(result) || result instanceof Uint8Array || result instanceof ArrayBuffer) return bytes(result);
  if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean' || typeof result === 'bigint') return text(result);
  if (isReadable(result) || isAsyncIterable(result)) return response(result, 200);
  return json(result);
}

export function cors(options = {}) {
  const origins = normalizeAllowedOrigins(options.origin ?? '*');
  const methods = normalizeList(options.methods ?? ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
  const allowedHeaders = normalizeList(options.allowedHeaders ?? ['content-type', 'authorization']);
  const exposedHeaders = normalizeList(options.exposedHeaders ?? []);
  const credentials = Boolean(options.credentials);
  const maxAge = positiveInteger(options.maxAge, 600);
  return async (context, next) => {
    const origin = context.header('origin');
    if (origin && originAllowed(origin, origins)) {
      context.rawResponse.setHeader('access-control-allow-origin', origins === '*' && !credentials ? '*' : origin);
      appendVary(context.rawResponse, 'Origin');
      if (credentials) context.rawResponse.setHeader('access-control-allow-credentials', 'true');
      if (exposedHeaders.length) context.rawResponse.setHeader('access-control-expose-headers', exposedHeaders.join(', '));
    }
    if (context.method === 'OPTIONS' && context.header('access-control-request-method')) {
      context.rawResponse.setHeader('access-control-allow-methods', methods.join(', '));
      context.rawResponse.setHeader('access-control-allow-headers', allowedHeaders.join(', '));
      context.rawResponse.setHeader('access-control-max-age', String(maxAge));
      return empty(204);
    }
    return next();
  };
}

export function securityHeaders(options = {}) {
  const csp = options.contentSecurityPolicy ?? "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
  return async (context, next) => {
    const responseObject = context.rawResponse;
    responseObject.setHeader('x-content-type-options', 'nosniff');
    responseObject.setHeader('x-frame-options', options.frameOptions ?? 'DENY');
    responseObject.setHeader('referrer-policy', options.referrerPolicy ?? 'no-referrer');
    responseObject.setHeader('cross-origin-opener-policy', options.crossOriginOpenerPolicy ?? 'same-origin');
    responseObject.setHeader('cross-origin-resource-policy', options.crossOriginResourcePolicy ?? 'same-origin');
    responseObject.setHeader('permissions-policy', options.permissionsPolicy ?? 'camera=(), microphone=(), geolocation=()');
    if (csp) responseObject.setHeader('content-security-policy', String(csp));
    if (context.secure && options.hsts !== false) responseObject.setHeader('strict-transport-security', options.hsts ?? 'max-age=31536000; includeSubDomains');
    return next();
  };
}

export function requestLogger(options = {}) {
  const write = typeof options.write === 'function' ? options.write : line => console.log(line);
  return async (context, next) => {
    let status = 500;
    try {
      const result = await next();
      status = result?.status ?? context.rawResponse.statusCode ?? 200;
      return result;
    } finally {
      write(JSON.stringify({
        time: new Date().toISOString(), requestId: context.requestId, method: context.method,
        path: context.path, route: context.route, status, elapsedMs: Number(context.elapsedMs().toFixed(3)), ip: context.ip,
      }));
    }
  };
}

export function timeout(milliseconds = DEFAULT_TIMEOUT_MS) {
  const timeoutMs = positiveInteger(milliseconds, DEFAULT_TIMEOUT_MS);
  return async (context, next) => {
    let timer;
    try {
      return await Promise.race([
        next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new WebError(504, 'Request timed out', { code: 'WEB_TIMEOUT' })), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally { clearTimeout(timer); }
  };
}

export function rateLimit(options = {}) {
  const windowMs = positiveInteger(options.windowMs, 60_000);
  const maximum = positiveInteger(options.max, 60);
  const key = typeof options.key === 'function' ? options.key : context => context.ip;
  const stores = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [entryKey, value] of stores) if (value.reset <= now) stores.delete(entryKey);
  }, Math.min(windowMs, 60_000));
  sweep.unref?.();
  return async (context, next) => {
    const now = Date.now();
    const entryKey = String(await key(context));
    let entry = stores.get(entryKey);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      stores.set(entryKey, entry);
    }
    entry.count += 1;
    context.rawResponse.setHeader('ratelimit-limit', String(maximum));
    context.rawResponse.setHeader('ratelimit-remaining', String(Math.max(0, maximum - entry.count)));
    context.rawResponse.setHeader('ratelimit-reset', String(Math.ceil(entry.reset / 1000)));
    if (entry.count > maximum) {
      context.rawResponse.setHeader('retry-after', String(Math.max(1, Math.ceil((entry.reset - now) / 1000))));
      return problem(429, 'Too Many Requests', 'Rate limit exceeded', 'WEB_RATE_LIMIT');
    }
    return next();
  };
}

export function compression(options = {}) {
  const threshold = positiveInteger(options.threshold, 1024);
  return async (context, next) => {
    const result = await next();
    const normalized = await normalizeResponse(result);
    if (normalized.body === null || normalized.body === undefined || isReadable(normalized.body) || isAsyncIterable(normalized.body)) return normalized;
    if (normalized.headers.has('content-encoding') || normalized.status < 200 || EMPTY_BODY_STATUS.has(normalized.status)) return normalized;
    const source = toBuffer(normalized.body);
    if (source.length < threshold) return normalized;
    const acceptEncoding = context.header('accept-encoding', '');
    let encoded = null;
    let encoding = null;
    if (headerHasToken(acceptEncoding, 'br')) { encoded = await brotliAsync(source); encoding = 'br'; }
    else if (headerHasToken(acceptEncoding, 'gzip')) { encoded = await gzipAsync(source); encoding = 'gzip'; }
    if (!encoded || encoded.length >= source.length) return normalized;
    normalized.body = encoded;
    normalized.headers.set('content-encoding', encoding);
    normalized.headers.set('content-length', String(encoded.length));
    normalized.headers.set('vary', mergeVary(normalized.headers.get('vary'), 'Accept-Encoding'));
    return normalized;
  };
}

export function staticFiles(rootDirectory, options = {}) {
  const root = path.resolve(String(rootDirectory));
  const indexFiles = options.index === false ? [] : normalizeList(options.index ?? ['index.html']);
  const maxAge = Math.max(0, Number(options.maxAge ?? DEFAULT_STATIC_MAX_AGE));
  const immutable = Boolean(options.immutable);
  const fallthrough = options.fallthrough !== false;
  const dotfiles = options.dotfiles ?? 'ignore';
  return async (context, next) => {
    if (context.method !== 'GET' && context.method !== 'HEAD') return next();
    let relative;
    try { relative = decodeURIComponent(context.rawPath).replaceAll('\\', '/'); }
    catch { throw new WebError(400, 'Invalid URL encoding', { code: 'WEB_BAD_PATH_ENCODING' }); }
    const segments = relative.split('/').filter(Boolean);
    if (segments.some(segment => segment === '..' || (segment.startsWith('.') && dotfiles !== 'allow'))) {
      if (dotfiles === 'deny') return problem(403, 'Forbidden', 'Dotfiles are not public', 'WEB_DOTFILE');
      return fallthrough ? next() : problem(404, 'Not Found');
    }
    let candidate = path.resolve(root, ...segments);
    if (!isInside(root, candidate)) return problem(403, 'Forbidden', 'Path traversal blocked', 'WEB_PATH_TRAVERSAL');
    let info = await stat(candidate).catch(() => null);
    if (info?.isDirectory()) {
      let found = null;
      for (const indexName of indexFiles) {
        const indexPath = path.join(candidate, indexName);
        const indexInfo = await stat(indexPath).catch(() => null);
        if (indexInfo?.isFile()) { found = { path: indexPath, info: indexInfo }; break; }
      }
      if (found) { candidate = found.path; info = found.info; }
    }
    if (!info?.isFile()) return fallthrough ? next() : problem(404, 'Not Found');
    const etag = weakEtag(info);
    if (context.header('if-none-match') === etag) return response(null, 304, headers('etag', etag));
    const modified = info.mtime.toUTCString();
    const ifModifiedSince = context.header('if-modified-since');
    if (ifModifiedSince && new Date(ifModifiedSince).getTime() >= Math.floor(info.mtimeMs / 1000) * 1000) return response(null, 304, headers('etag', etag, 'last-modified', modified));
    const responseHeaders = new Map([
      ['content-type', mimeType(candidate)], ['accept-ranges', 'bytes'], ['etag', etag], ['last-modified', modified],
      ['cache-control', `public, max-age=${Math.floor(maxAge)}${immutable ? ', immutable' : ''}`],
    ]);
    const range = parseRange(context.header('range'), info.size);
    if (range?.invalid) {
      responseHeaders.set('content-range', `bytes */${info.size}`);
      return response(null, 416, responseHeaders);
    }
    if (range) {
      responseHeaders.set('content-range', `bytes ${range.start}-${range.end}/${info.size}`);
      responseHeaders.set('content-length', String(range.end - range.start + 1));
      return response(createReadStream(candidate, { start: range.start, end: range.end }), 206, responseHeaders);
    }
    responseHeaders.set('content-length', String(info.size));
    return response(createReadStream(candidate), 200, responseHeaders);
  };
}

export function sse(handler, options = {}) {
  if (typeof handler !== 'function') throw new TypeError('sse() expects a handler');
  return async context => {
    const responseObject = context.rawResponse;
    responseObject.statusCode = 200;
    responseObject.setHeader('content-type', 'text/event-stream; charset=utf-8');
    responseObject.setHeader('cache-control', 'no-cache, no-transform');
    responseObject.setHeader('connection', 'keep-alive');
    responseObject.setHeader('x-accel-buffering', 'no');
    responseObject.flushHeaders?.();
    context.responded = true;
    const stream = {
      send(data, event = null, id = null, retry = null) {
        if (responseObject.writableEnded) return false;
        let output = '';
        if (event !== null) output += `event: ${sanitizeSseField(event)}\n`;
        if (id !== null) output += `id: ${sanitizeSseField(id)}\n`;
        if (retry !== null) output += `retry: ${Math.max(0, Math.floor(Number(retry)))}\n`;
        const encoded = typeof data === 'string' ? data : JSON.stringify(data);
        for (const line of String(encoded).split(/\r?\n/)) output += `data: ${line}\n`;
        return responseObject.write(`${output}\n`);
      },
      comment(value = '') { return responseObject.write(`: ${String(value).replace(/[\r\n]/g, ' ')}\n\n`); },
      close() { responseObject.end(); },
      get closed() { return responseObject.writableEnded; },
    };
    const keepAliveMs = positiveInteger(options.keepAliveMs, 15_000);
    const timer = setInterval(() => stream.comment('keep-alive'), keepAliveMs);
    timer.unref?.();
    try { await handler(stream, context); }
    finally { clearInterval(timer); if (!responseObject.writableEnded && options.autoClose !== false) responseObject.end(); }
    return undefined;
  };
}

export class WebSocketConnection {
  constructor(socket, options) {
    this.socket = socket;
    this.maxBytes = options.maxBytes;
    this.protocol = options.protocol ?? null;
    this.request = options.request;
    this.url = options.url;
    this.params = options.params;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.messageHandlers = new Set();
    this.closeHandlers = new Set();
    this.errorHandlers = new Set();
    socket.on('data', chunk => this.feed(chunk));
    socket.on('error', error => { for (const handler of this.errorHandlers) handler(error, this); });
    socket.on('close', () => this.#finishClose(1006, 'Connection closed'));
  }

  onMessage(handler) { if (typeof handler !== 'function') throw new TypeError('onMessage() expects a function'); this.messageHandlers.add(handler); return () => this.messageHandlers.delete(handler); }
  onClose(handler) { if (typeof handler !== 'function') throw new TypeError('onClose() expects a function'); this.closeHandlers.add(handler); return () => this.closeHandlers.delete(handler); }
  onError(handler) { if (typeof handler !== 'function') throw new TypeError('onError() expects a function'); this.errorHandlers.add(handler); return () => this.errorHandlers.delete(handler); }

  send(value) {
    if (typeof value === 'string') return this.#sendFrame(0x1, Buffer.from(value));
    return this.#sendFrame(0x2, toBuffer(value));
  }

  sendJson(value) { return this.send(JSON.stringify(value)); }
  ping(value = '') { return this.#sendFrame(0x9, toBuffer(value)); }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBytes = Buffer.from(String(reason));
    if (reasonBytes.length > 123) throw new RangeError('WebSocket close reason exceeds 123 bytes');
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(Number(code), 0);
    reasonBytes.copy(payload, 2);
    this.#sendFrame(0x8, payload);
    this.closed = true;
    this.socket.end();
  }

  feed(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    try {
      while (this.#parseFrame()) {}
    } catch (error) {
      for (const handler of this.errorHandlers) handler(error, this);
      this.close(1002, 'Protocol error');
    }
  }

  #parseFrame() {
    if (this.buffer.length < 2) return false;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const final = (first & 0x80) !== 0;
    const reserved = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (reserved !== 0 || !masked) throw new WebError(400, 'Invalid WebSocket frame');
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2); offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      const big = this.buffer.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebError(413, 'WebSocket frame is too large');
      length = Number(big); offset = 10;
    }
    const control = opcode >= 0x8;
    if (control && (!final || length > 125)) throw new WebError(400, 'Invalid WebSocket control frame');
    if (length > this.maxBytes || this.fragmentBytes + length > this.maxBytes) throw new WebError(413, 'WebSocket message exceeds the configured limit');
    if (this.buffer.length < offset + 4 + length) return false;
    const mask = this.buffer.subarray(offset, offset + 4); offset += 4;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      if (!this.closed) this.#sendFrame(0x8, payload);
      this.closed = true; this.socket.end(); this.#finishClose(code, reason); return true;
    }
    if (opcode === 0x9) { this.#sendFrame(0xA, payload); return true; }
    if (opcode === 0xA) return true;
    if (opcode === 0x0) {
      if (this.fragmentOpcode === null) throw new WebError(400, 'Unexpected WebSocket continuation frame');
      this.fragments.push(payload); this.fragmentBytes += payload.length;
      if (final) {
        const complete = Buffer.concat(this.fragments, this.fragmentBytes);
        const type = this.fragmentOpcode === 0x1 ? 'text' : 'binary';
        this.fragmentOpcode = null; this.fragments = []; this.fragmentBytes = 0;
        this.#emitMessage(type === 'text' ? complete.toString('utf8') : complete, type);
      }
      return true;
    }
    if (opcode !== 0x1 && opcode !== 0x2) throw new WebError(400, 'Unsupported WebSocket opcode');
    if (!final) { this.fragmentOpcode = opcode; this.fragments = [payload]; this.fragmentBytes = payload.length; return true; }
    this.#emitMessage(opcode === 0x1 ? payload.toString('utf8') : payload, opcode === 0x1 ? 'text' : 'binary');
    return true;
  }

  #emitMessage(value, type) {
    for (const handler of this.messageHandlers) Promise.resolve(handler(value, type, this)).catch(error => {
      for (const errorHandler of this.errorHandlers) errorHandler(error, this);
    });
  }

  #sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const data = toBuffer(payload);
    let header;
    if (data.length < 126) { header = Buffer.alloc(2); header[1] = data.length; }
    else if (data.length <= 0xffff) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(data.length, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    header[0] = 0x80 | opcode;
    return this.socket.write(Buffer.concat([header, data]));
  }

  #finishClose(code, reason) {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.closed = true;
    for (const handler of this.closeHandlers) handler(code, reason, this);
  }
}

function compileRoute(routePath, options = {}) {
  const source = normalizeRoutePath(routePath);
  const names = [];
  let pattern = '^';
  if (source === '/') pattern += '/';
  else {
    const segments = source.split('/').slice(1);
    for (const segment of segments) {
      pattern += '/';
      if (segment === '*') { names.push('wildcard'); pattern += '(.*)'; continue; }
      if (segment.startsWith(':')) {
        const optional = segment.endsWith('?');
        const rawName = segment.slice(1, optional ? -1 : undefined);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawName)) throw new TypeError(`Invalid route parameter: ${segment}`);
        names.push(rawName);
        pattern += optional ? '([^/]*)' : '([^/]+)';
        continue;
      }
      pattern += escapeRegex(segment);
    }
  }
  pattern += options.trailingSlash === true ? '/?$' : '$';
  return { regexp: new RegExp(pattern), names, protocols: options.protocols ?? null, maxBytes: options.maxBytes };
}

function matchRoute(routes, method, pathname) {
  const automaticOptions = [];
  for (const route of routes) {
    const match = route.regexp.exec(pathname);
    if (!match) continue;
    if (route.method === method || route.method === 'ANY' || (method === 'HEAD' && route.method === 'GET')) return { route, params: routeParams(route, match) };
    automaticOptions.push(route.method);
  }
  if (method === 'OPTIONS' && automaticOptions.length) {
    const route = { path: pathname, handler: () => response(null, 204, headers('allow', [...new Set([...automaticOptions, 'OPTIONS'])].join(', '))) };
    return { route, params: Object.create(null) };
  }
  return null;
}

function matchPath(routes, pathname) {
  for (const route of routes) {
    const match = route.regexp.exec(pathname);
    if (match) return { route, params: routeParams(route, match) };
  }
  return null;
}

function routeParams(route, match) {
  const output = Object.create(null);
  route.names.forEach((name, index) => { output[name] = decodeURIComponent(match[index + 1] ?? ''); });
  return output;
}

function normalizeRoutePath(value) {
  let output = String(value || '/');
  if (!output.startsWith('/')) output = `/${output}`;
  if (output.length > 1 && output.endsWith('/')) output = output.slice(0, -1);
  if (output.includes('\0')) throw new TypeError('Route path contains a null byte');
  return output;
}

function normalizeMountPrefix(value) {
  const output = normalizeRoutePath(value);
  return output === '/' ? '' : output;
}

function readRequestBody(request, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return reject(new WebError(413, `Request body exceeds ${limit} bytes`, { code: 'WEB_BODY_TOO_LARGE' }));
    const chunks = [];
    let total = 0;
    request.on('data', chunk => {
      total += chunk.length;
      if (total > limit) {
        reject(new WebError(413, `Request body exceeds ${limit} bytes`, { code: 'WEB_BODY_TOO_LARGE' }));
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => resolve(Buffer.concat(chunks, total)));
    request.on('error', reject);
    request.on('aborted', () => reject(new WebError(400, 'Request body was aborted', { code: 'WEB_BODY_ABORTED' })));
  });
}

function parseMultipart(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(marker);
  if (cursor < 0) throw new WebError(400, 'Multipart boundary was not found', { code: 'WEB_MULTIPART_BOUNDARY' });
  cursor += marker.length;
  while (cursor < buffer.length) {
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) throw new WebError(400, 'Multipart headers are incomplete', { code: 'WEB_MULTIPART_HEADERS' });
    const rawHeaders = buffer.subarray(cursor, headerEnd).toString('utf8');
    const partHeaders = new Map();
    for (const line of rawHeaders.split('\r\n')) {
      const separator = line.indexOf(':');
      if (separator <= 0) throw new WebError(400, 'Multipart header is invalid', { code: 'WEB_MULTIPART_HEADER' });
      partHeaders.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    const nextBoundary = buffer.indexOf(marker, headerEnd + 4);
    if (nextBoundary < 0) throw new WebError(400, 'Multipart body is incomplete', { code: 'WEB_MULTIPART_INCOMPLETE' });
    let dataEnd = nextBoundary;
    if (dataEnd >= 2 && buffer.subarray(dataEnd - 2, dataEnd).equals(Buffer.from('\r\n'))) dataEnd -= 2;
    const data = Buffer.from(buffer.subarray(headerEnd + 4, dataEnd));
    const disposition = parseDisposition(partHeaders.get('content-disposition'));
    parts.push({
      name: disposition.name ?? null,
      filename: disposition.filename ?? null,
      contentType: partHeaders.get('content-type') ?? 'application/octet-stream',
      headers: partHeaders,
      data,
      text(encoding = 'utf8') { return data.toString(encoding); },
      json() { return JSON.parse(data.toString('utf8')); },
    });
    cursor = nextBoundary + marker.length;
  }
  return parts;
}

function parseDisposition(value = '') {
  const output = Object.create(null);
  for (const item of String(value).split(';').slice(1)) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim().toLowerCase();
    let data = item.slice(separator + 1).trim();
    if (data.startsWith('"') && data.endsWith('"')) data = data.slice(1, -1).replace(/\\(["\\])/g, '$1');
    output[key] = data;
  }
  return output;
}

function parseContentType(value) {
  const [type = '', ...parameters] = String(value).split(';');
  const output = { type: type.trim().toLowerCase(), charset: null, parameters: Object.create(null) };
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator < 0) continue;
    const key = parameter.slice(0, separator).trim().toLowerCase();
    let data = parameter.slice(separator + 1).trim();
    if (data.startsWith('"') && data.endsWith('"')) data = data.slice(1, -1);
    output.parameters[key] = data;
  }
  output.charset = output.parameters.charset ?? null;
  return output;
}

function parseCookies(value) {
  const output = Object.create(null);
  for (const entry of String(value ?? '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    if (!key || Object.hasOwn(output, key)) continue;
    try { output[key] = decodeURIComponent(entry.slice(separator + 1).trim()); }
    catch { output[key] = entry.slice(separator + 1).trim(); }
  }
  return output;
}

function normalizeHeaders(input) {
  const output = new Map();
  if (!input) return output;
  if (input instanceof Map) {
    for (const [name, value] of input) output.set(normalizeHeaderName(name), normalizeHeaderValue(value));
    return output;
  }
  if (input instanceof Headers) {
    input.forEach((value, name) => output.set(normalizeHeaderName(name), value));
    return output;
  }
  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index++) {
      const item = input[index];
      if (Array.isArray(item) && item.length >= 2) output.set(normalizeHeaderName(item[0]), normalizeHeaderValue(item[1]));
      else if (index + 1 < input.length) output.set(normalizeHeaderName(item), normalizeHeaderValue(input[++index]));
      else throw new TypeError('headers() expects pairs');
    }
    return output;
  }
  if (typeof input === 'object') {
    for (const [name, value] of Object.entries(input)) output.set(normalizeHeaderName(name), normalizeHeaderValue(value));
    return output;
  }
  throw new TypeError('Unsupported header collection');
}

function normalizeHeaderName(name) {
  const output = String(name).toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(output)) throw new TypeError(`Invalid HTTP header name: ${name}`);
  return output;
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) return value.map(normalizeHeaderValue);
  const output = String(value);
  if (/\r|\n/.test(output)) throw new TypeError('HTTP header values cannot contain CR or LF');
  return output;
}

function setHeaderIfMissing(headerMap, name, value) { if (!headerMap.has(name)) headerMap.set(name, value); }
function normalizeStatus(value, fallback) { const status = Number(value); return Number.isInteger(status) && status >= 100 && status <= 999 ? status : fallback; }
function normalizePort(value) { const port = Number(value); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Port must be an integer from 0 to 65535'); return port; }
function positiveInteger(value, fallback) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : fallback; }
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(String(value));
}
function isReadable(value) { return value && typeof value.pipe === 'function' && typeof value.on === 'function'; }
function isAsyncIterable(value) { return value && typeof value[Symbol.asyncIterator] === 'function'; }
function onceDrain(stream) { return new Promise((resolve, reject) => { stream.once('drain', resolve); stream.once('error', reject); }); }
function assertSafeObjectKey(key) { if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new TypeError(`Unsafe object key: ${key}`); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function decodePathname(value) { try { return decodeURIComponent(value); } catch { throw new WebError(400, 'Invalid URL path encoding', { code: 'WEB_BAD_PATH_ENCODING' }); } }
function headerHasToken(value, token) { return String(value ?? '').split(',').some(item => item.trim().toLowerCase() === token.toLowerCase()); }
function acceptsType(value, expected) { const source = String(value ?? '*/*').toLowerCase(); const type = expected.toLowerCase(); return source.split(',').some(item => { const candidate = item.split(';', 1)[0].trim(); return candidate === '*/*' || candidate === type || (candidate.endsWith('/*') && type.startsWith(candidate.slice(0, -1))); }); }
function firstForwarded(value) { return String(Array.isArray(value) ? value[0] : value ?? '').split(',', 1)[0].trim().toLowerCase() || null; }
function resolveIp(request, trustProxy) { return trustProxy ? firstForwarded(request.headers['x-forwarded-for']) ?? request.socket.remoteAddress ?? '' : request.socket.remoteAddress ?? ''; }
function resolveIps(request, trustProxy) { return trustProxy ? String(request.headers['x-forwarded-for'] ?? '').split(',').map(item => item.trim()).filter(Boolean) : [request.socket.remoteAddress ?? '']; }
function sanitizeRequestId(value) { const output = Array.isArray(value) ? value[0] : value; return typeof output === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(output) ? output : null; }
function normalizeList(value) { return Array.isArray(value) ? value.map(String) : String(value).split(',').map(item => item.trim()).filter(Boolean); }
function normalizeAllowedOrigins(value) { if (value === '*') return '*'; return new Set(normalizeList(value)); }
function originAllowed(origin, allowed) { return allowed === '*' || allowed.has(origin); }
function appendVary(responseObject, value) { responseObject.setHeader('vary', mergeVary(responseObject.getHeader('vary'), value)); }
function mergeVary(current, value) { const items = new Set(String(current ?? '').split(',').map(item => item.trim()).filter(Boolean)); items.add(value); return [...items].join(', '); }
function sanitizeSseField(value) { return String(value).replace(/[\r\n]/g, ' '); }
function mimeType(file) { return MIME_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'; }
function weakEtag(info) { return `W/\"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}\"`; }
function isInside(root, candidate) { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match) return { invalid: true };
  let start; let end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true }; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}
function normalizeError(error) {
  if (error instanceof WebError) return error;
  if (error?.name === 'AbortError') return new WebError(408, 'Request was aborted', { code: 'WEB_ABORTED', cause: error });
  return new WebError(500, error instanceof Error ? error.message : String(error), { code: 'WEB_INTERNAL', expose: false, cause: error });
}
function selectWebSocketProtocol(value, allowed) {
  if (!allowed) return null;
  const requested = normalizeList(value ?? '');
  const accepted = new Set(normalizeList(allowed));
  return requested.find(item => accepted.has(item)) ?? null;
}
function rejectUpgrade(socket, status, message, extraHeaders = null) {
  const body = Buffer.from(String(message));
  const lines = [`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}`, 'Connection: close', 'Content-Type: text/plain; charset=utf-8', `Content-Length: ${body.length}`];
  if (extraHeaders) for (const [name, value] of Object.entries(extraHeaders)) lines.push(`${name}: ${value}`);
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
}
function createUpgradeContext(request, url, params) {
  return {
    rawRequest: request, url, path: decodePathname(url.pathname), params,
    query(name, fallback = null) { return url.searchParams.get(String(name)) ?? fallback; },
    param(name, fallback = null) { return params[String(name)] ?? fallback; },
    header(name, fallback = null) { const value = request.headers[String(name).toLowerCase()]; return value === undefined ? fallback : Array.isArray(value) ? value.join(', ') : String(value); },
    cookies: parseCookies(request.headers.cookie),
  };
}
