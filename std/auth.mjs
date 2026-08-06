// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  webcrypto,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const encoder = new TextEncoder();

export class AuthError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'AuthError';
    this.code = options.code ?? 'KR-AUTH-0001';
    this.status = options.status ?? 401;
    this.details = options.details ?? null;
  }
}

export async function hashPassword(password, options = {}) {
  const value = validatePasswordInput(password, options);
  const salt = options.salt ? Buffer.from(options.salt, 'base64url') : randomBytes(options.saltBytes ?? 16);
  const keyLength = options.keyLength ?? 32;
  const cost = options.cost ?? 16_384;
  const blockSize = options.blockSize ?? 8;
  const parallelization = options.parallelization ?? 1;
  validateScryptParameters(cost, blockSize, parallelization, keyLength);
  const key = await scrypt(value, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: options.maxMemory ?? 64 * 1024 * 1024,
  });
  return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
}

export async function verifyPassword(password, encoded, options = {}) {
  const value = validatePasswordInput(password, options);
  const parts = String(encoded).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, costText, blockText, parallelText, saltText, hashText] = parts;
  const cost = Number(costText);
  const blockSize = Number(blockText);
  const parallelization = Number(parallelText);
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(hashText, 'base64url');
  try { validateScryptParameters(cost, blockSize, parallelization, expected.length); }
  catch { return false; }
  const actual = Buffer.from(await scrypt(value, salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: options.maxMemory ?? 64 * 1024 * 1024,
  }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function needsPasswordRehash(encoded, options = {}) {
  const parts = String(encoded).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < (options.cost ?? 16_384)
    || Number(parts[2]) !== (options.blockSize ?? 8)
    || Number(parts[3]) !== (options.parallelization ?? 1)
    || Buffer.from(parts[5], 'base64url').length < (options.keyLength ?? 32);
}

export function signJwt(payload, secret, options = {}) {
  const key = normalizeSecret(secret, 32);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const header = { alg: 'HS256', typ: 'JWT', ...(options.header ?? {}) };
  if (header.alg !== 'HS256') throw new AuthError('Only HS256 is supported by signJwt.', { code: 'KR-AUTH-0101', status: 500 });
  const body = {
    ...payload,
    ...(options.issuer ? { iss: options.issuer } : {}),
    ...(options.audience ? { aud: options.audience } : {}),
    iat: payload.iat ?? now,
    ...(options.notBefore !== undefined ? { nbf: now + durationSeconds(options.notBefore) } : {}),
    ...(options.expiresIn !== undefined ? { exp: now + durationSeconds(options.expiresIn) } : {}),
    ...(options.jwtId ? { jti: options.jwtId } : {}),
  };
  const encodedHeader = base64urlJson(header);
  const encodedPayload = base64urlJson(body);
  const signature = createHmac('sha256', key).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyJwt(token, secret, options = {}) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new AuthError('JWT must contain three segments.', { code: 'KR-AUTH-0102' });
  const [headerText, payloadText, signatureText] = parts;
  const header = decodeJsonSegment(headerText, 'JWT header');
  const payload = decodeJsonSegment(payloadText, 'JWT payload');
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new AuthError('JWT algorithm or type is not allowed.', { code: 'KR-AUTH-0103' });
  const expected = createHmac('sha256', normalizeSecret(secret, 32)).update(`${headerText}.${payloadText}`).digest();
  const actual = Buffer.from(signatureText, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AuthError('JWT signature is invalid.', { code: 'KR-AUTH-0104' });
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const tolerance = durationSeconds(options.clockTolerance ?? 0);
  if (payload.nbf !== undefined && now + tolerance < Number(payload.nbf)) throw new AuthError('JWT is not active yet.', { code: 'KR-AUTH-0105' });
  if (payload.exp !== undefined && now - tolerance >= Number(payload.exp)) throw new AuthError('JWT has expired.', { code: 'KR-AUTH-0106' });
  if (options.issuer && payload.iss !== options.issuer) throw new AuthError('JWT issuer is invalid.', { code: 'KR-AUTH-0107' });
  if (options.audience && !audienceMatches(payload.aud, options.audience)) throw new AuthError('JWT audience is invalid.', { code: 'KR-AUTH-0108' });
  if (options.subject && payload.sub !== options.subject) throw new AuthError('JWT subject is invalid.', { code: 'KR-AUTH-0109' });
  if (options.maxAge !== undefined && (!payload.iat || now - Number(payload.iat) > durationSeconds(options.maxAge) + tolerance)) throw new AuthError('JWT is older than the maximum allowed age.', { code: 'KR-AUTH-0110' });
  return Object.freeze(payload);
}

export function decodeJwt(token) {
  const [header, payload] = String(token).split('.');
  if (!header || !payload) throw new AuthError('JWT is malformed.', { code: 'KR-AUTH-0111' });
  return Object.freeze({ header: decodeJsonSegment(header, 'JWT header'), payload: decodeJsonSegment(payload, 'JWT payload') });
}

export class MemorySessionStore {
  constructor(options = {}) {
    this.sessions = new Map();
    this.defaultTtlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.maxSessions = options.maxSessions ?? 100_000;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    this.timer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    this.timer.unref?.();
  }

  async get(id) {
    const item = this.sessions.get(String(id));
    if (!item) return null;
    if (item.expiresAt <= Date.now()) { this.sessions.delete(String(id)); return null; }
    item.lastSeenAt = Date.now();
    return structuredClone(item.value);
  }

  async set(id, value, options = {}) {
    if (this.sessions.size >= this.maxSessions && !this.sessions.has(String(id))) this.cleanup(true);
    if (this.sessions.size >= this.maxSessions && !this.sessions.has(String(id))) throw new AuthError('Session store capacity reached.', { code: 'KR-AUTH-0201', status: 503 });
    const now = Date.now();
    this.sessions.set(String(id), {
      value: structuredClone(value),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + (options.ttlMs ?? this.defaultTtlMs),
    });
  }

  async touch(id, ttlMs = this.defaultTtlMs) {
    const item = this.sessions.get(String(id));
    if (!item) return false;
    item.expiresAt = Date.now() + ttlMs;
    item.lastSeenAt = Date.now();
    return true;
  }

  async delete(id) { return this.sessions.delete(String(id)); }
  async rotate(oldId, newId, options = {}) {
    const value = await this.get(oldId);
    if (value === null) return false;
    await this.set(newId, value, options);
    await this.delete(oldId);
    return true;
  }
  cleanup(aggressive = false) {
    const now = Date.now();
    for (const [id, item] of this.sessions) if (item.expiresAt <= now) this.sessions.delete(id);
    if (aggressive && this.sessions.size >= this.maxSessions) {
      const sorted = [...this.sessions.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      for (const [id] of sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.1)))) this.sessions.delete(id);
    }
    return this.sessions.size;
  }
  close() { clearInterval(this.timer); this.sessions.clear(); }
}

export function createSessionManager(options = {}) {
  const store = options.store ?? new MemorySessionStore(options);
  const cookieName = options.cookieName ?? '__Host-kura_session';
  const secret = normalizeSecret(options.secret ?? process.env.SESSION_SECRET, 32);
  const ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
  const cookieOptions = {
    httpOnly: true,
    secure: options.secure !== false,
    sameSite: options.sameSite ?? 'Lax',
    path: options.path ?? '/',
    domain: options.domain,
    maxAge: Math.floor(ttlMs / 1000),
  };

  return Object.freeze({
    store,
    cookieName,
    async create(value, context = null) {
      const id = randomBytes(32).toString('base64url');
      await store.set(id, { ...value, createdAt: Date.now(), fingerprint: context ? sessionFingerprint(context, options) : null }, { ttlMs });
      return Object.freeze({ id, cookie: serializeCookie(cookieName, signCookieValue(id, secret), cookieOptions) });
    },
    async read(cookieHeader, context = null) {
      const cookies = parseCookies(cookieHeader);
      const signed = cookies[cookieName];
      if (!signed) return null;
      const id = verifyCookieValue(signed, secret);
      if (!id) return null;
      const value = await store.get(id);
      if (!value) return null;
      if (context && value.fingerprint && !safeEqual(value.fingerprint, sessionFingerprint(context, options))) {
        await store.delete(id);
        return null;
      }
      if (options.rolling !== false) await store.touch(id, ttlMs);
      return Object.freeze({ id, value: Object.freeze(value) });
    },
    async rotate(id, value, context = null) {
      const newId = randomBytes(32).toString('base64url');
      await store.delete(id);
      await store.set(newId, { ...value, createdAt: Date.now(), fingerprint: context ? sessionFingerprint(context, options) : null }, { ttlMs });
      return Object.freeze({ id: newId, cookie: serializeCookie(cookieName, signCookieValue(newId, secret), cookieOptions) });
    },
    async destroy(id) {
      if (id) await store.delete(id);
      return serializeCookie(cookieName, '', { ...cookieOptions, maxAge: 0, expires: new Date(0) });
    },
    cookieFor(id) { return serializeCookie(cookieName, signCookieValue(id, secret), cookieOptions); },
  });
}

export function sessionMiddleware(manager, options = {}) {
  return async (context, next) => {
    const cookieHeader = context.request?.headers?.cookie ?? context.request?.headers?.get?.('cookie') ?? '';
    const current = await manager.read(cookieHeader, context);
    context.session = current;
    context.requireSession = () => {
      if (!context.session) throw new AuthError('Authentication is required.', { code: 'KR-AUTH-0202' });
      return context.session.value;
    };
    context.createSession = async value => {
      const created = await manager.create(value, context);
      context.responseHeaders ??= {};
      appendHeader(context.responseHeaders, 'set-cookie', created.cookie);
      context.session = { id: created.id, value };
      return created;
    };
    context.destroySession = async () => {
      const cookie = await manager.destroy(context.session?.id);
      context.responseHeaders ??= {};
      appendHeader(context.responseHeaders, 'set-cookie', cookie);
      context.session = null;
    };
    return next();
  };
}

export function createCsrf(options = {}) {
  const cookieName = options.cookieName ?? '__Host-kura_csrf';
  const headerName = String(options.headerName ?? 'x-csrf-token').toLowerCase();
  const secret = normalizeSecret(options.secret ?? process.env.CSRF_SECRET ?? process.env.SESSION_SECRET, 32);
  const ttlSeconds = durationSeconds(options.ttl ?? '2h');
  const safeMethods = new Set((options.safeMethods ?? ['GET', 'HEAD', 'OPTIONS', 'TRACE']).map(value => String(value).toUpperCase()));
  return Object.freeze({
    issue(sessionId = '') {
      const now = Math.floor(Date.now() / 1000);
      const nonce = randomBytes(24).toString('base64url');
      const body = `${now}.${nonce}.${hashText(sessionId)}`;
      const signature = createHmac('sha256', secret).update(body).digest('base64url');
      const token = `${body}.${signature}`;
      const cookie = serializeCookie(cookieName, token, { httpOnly: false, secure: options.secure !== false, sameSite: options.sameSite ?? 'Strict', path: options.path ?? '/', maxAge: ttlSeconds });
      return Object.freeze({ token, cookie });
    },
    verify(token, cookieToken, sessionId = '') {
      if (!token || !cookieToken || !safeEqual(String(token), String(cookieToken))) return false;
      const parts = String(token).split('.');
      if (parts.length !== 4) return false;
      const [timestamp, nonce, fingerprint, signature] = parts;
      if (!/^\d+$/.test(timestamp) || !nonce) return false;
      const age = Math.floor(Date.now() / 1000) - Number(timestamp);
      if (age < -60 || age > ttlSeconds) return false;
      if (!safeEqual(fingerprint, hashText(sessionId))) return false;
      const expected = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${fingerprint}`).digest('base64url');
      return safeEqual(signature, expected);
    },
    middleware() {
      return async (context, next) => {
        const method = String(context.request?.method ?? context.method ?? 'GET').toUpperCase();
        if (safeMethods.has(method)) return next();
        const cookies = parseCookies(context.request?.headers?.cookie ?? context.request?.headers?.get?.('cookie') ?? '');
        const token = context.request?.headers?.[headerName] ?? context.request?.headers?.get?.(headerName) ?? context.query?.('_csrf') ?? null;
        const sessionId = context.session?.id ?? '';
        if (!this.verify(token, cookies[cookieName], sessionId)) throw new AuthError('CSRF token is invalid or missing.', { code: 'KR-AUTH-0301', status: 403 });
        return next();
      };
    },
  });
}

export function createApiKey(prefix = 'kr') {
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(prefix)) throw new AuthError('API key prefix is invalid.', { code: 'KR-AUTH-0401', status: 500 });
  const secret = randomBytes(32).toString('base64url');
  const id = randomBytes(8).toString('hex');
  const token = `${prefix}_${id}_${secret}`;
  return Object.freeze({ id, token, hash: hashApiKey(token), preview: `${prefix}_${id}_${secret.slice(0, 4)}...` });
}

export function hashApiKey(token, pepper = '') {
  return createHmac('sha256', normalizeSecret(pepper || 'kura-api-key-hash', 16)).update(String(token)).digest('base64url');
}

export function verifyApiKey(token, expectedHash, pepper = '') {
  return safeEqual(hashApiKey(token, pepper), String(expectedHash));
}

export function apiKeyMiddleware(options = {}) {
  const header = String(options.header ?? 'authorization').toLowerCase();
  const scheme = options.scheme ?? 'Bearer';
  return async (context, next) => {
    const raw = context.request?.headers?.[header] ?? context.request?.headers?.get?.(header) ?? '';
    const token = scheme ? String(raw).startsWith(`${scheme} `) ? String(raw).slice(scheme.length + 1) : null : raw;
    if (!token) throw new AuthError('API key is required.', { code: 'KR-AUTH-0402' });
    const record = await options.lookup(token);
    if (!record || record.disabled || (record.expiresAt && new Date(record.expiresAt) <= new Date())) throw new AuthError('API key is invalid.', { code: 'KR-AUTH-0403' });
    const valid = record.hash ? verifyApiKey(token, record.hash, options.pepper) : Boolean(record.valid);
    if (!valid) throw new AuthError('API key is invalid.', { code: 'KR-AUTH-0403' });
    context.apiKey = Object.freeze(record);
    return next();
  };
}

export function authorize(required, options = {}) {
  const permissions = Array.isArray(required) ? required : [required];
  const mode = options.mode ?? 'all';
  return async (context, next) => {
    const principal = options.principal ? await options.principal(context) : context.session?.value ?? context.user ?? null;
    if (!principal) throw new AuthError('Authentication is required.', { code: 'KR-AUTH-0501' });
    const granted = new Set([...(principal.permissions ?? []), ...(principal.roles ?? []).flatMap(role => options.roles?.[role] ?? [])]);
    const allowed = mode === 'any' ? permissions.some(permission => matchesPermission(granted, permission)) : permissions.every(permission => matchesPermission(granted, permission));
    if (!allowed) throw new AuthError('Permission denied.', { code: 'KR-AUTH-0502', status: 403, details: permissions.join(', ') });
    context.principal = Object.freeze(principal);
    return next();
  };
}

export function requireRole(...roles) {
  const required = new Set(roles.flat().map(String));
  return async (context, next) => {
    const actual = new Set(context.session?.value?.roles ?? context.user?.roles ?? []);
    if (![...required].some(role => actual.has(role))) throw new AuthError('Required role is missing.', { code: 'KR-AUTH-0503', status: 403 });
    return next();
  };
}

export function createPkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return Object.freeze({ verifier, challenge, method: 'S256' });
}

export function createOAuthState(options = {}) {
  const secret = normalizeSecret(options.secret ?? process.env.OAUTH_STATE_SECRET ?? process.env.SESSION_SECRET, 32);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    nonce: randomBytes(24).toString('base64url'),
    iat: now,
    exp: now + durationSeconds(options.expiresIn ?? '10m'),
    redirect: options.redirect ?? null,
    data: options.data ?? null,
  };
  const encoded = base64urlJson(payload);
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyOAuthState(state, options = {}) {
  const secret = normalizeSecret(options.secret ?? process.env.OAUTH_STATE_SECRET ?? process.env.SESSION_SECRET, 32);
  const [encoded, signature] = String(state).split('.');
  if (!encoded || !signature) throw new AuthError('OAuth state is malformed.', { code: 'KR-AUTH-0601' });
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!safeEqual(signature, expected)) throw new AuthError('OAuth state signature is invalid.', { code: 'KR-AUTH-0602' });
  const payload = decodeJsonSegment(encoded, 'OAuth state');
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now || payload.iat > now + 60) throw new AuthError('OAuth state has expired.', { code: 'KR-AUTH-0603' });
  return Object.freeze(payload);
}

export function authorizationUrl(options = {}) {
  const url = new URL(requiredText(options.authorizationEndpoint, 'authorizationEndpoint'));
  url.searchParams.set('response_type', options.responseType ?? 'code');
  url.searchParams.set('client_id', requiredText(options.clientId, 'clientId'));
  url.searchParams.set('redirect_uri', requiredText(options.redirectUri, 'redirectUri'));
  url.searchParams.set('scope', Array.isArray(options.scope) ? options.scope.join(' ') : options.scope ?? 'openid');
  if (options.state) url.searchParams.set('state', options.state);
  if (options.pkce?.challenge) {
    url.searchParams.set('code_challenge', options.pkce.challenge);
    url.searchParams.set('code_challenge_method', options.pkce.method ?? 'S256');
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  return url.toString();
}

export async function exchangeAuthorizationCode(options = {}) {
  if (process.env.KURA_SECURITY_MODE === 'strict') throw new AuthError('Strict security mode blocks OAuth token network exchange.', { code: 'KR-AUTH-STRICT-0001', status: 403 });
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: requiredText(options.code, 'code'),
    client_id: requiredText(options.clientId, 'clientId'),
    redirect_uri: requiredText(options.redirectUri, 'redirectUri'),
    ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
    ...(options.codeVerifier ? { code_verifier: options.codeVerifier } : {}),
  });
  const response = await fetch(requiredText(options.tokenEndpoint, 'tokenEndpoint'), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', ...(options.headers ?? {}) },
    body,
    signal: options.signal,
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { error: text }; }
  if (!response.ok) throw new AuthError(`OAuth token exchange failed with HTTP ${response.status}.`, { code: 'KR-AUTH-0604', status: 502, details: payload });
  return Object.freeze(payload);
}

export function generateTotpSecret(bytes = 20) { return base32Encode(randomBytes(bytes)); }
export function generateTotp(secret, options = {}) {
  const step = options.step ?? 30;
  const digits = options.digits ?? 6;
  const counter = BigInt(Math.floor((options.time ?? Date.now()) / 1000 / step));
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const digest = createHmac(options.algorithm ?? 'sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest.at(-1) & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(value).padStart(digits, '0');
}

export function verifyTotp(token, secret, options = {}) {
  const window = options.window ?? 1;
  const step = options.step ?? 30;
  const now = options.time ?? Date.now();
  for (let offset = -window; offset <= window; offset++) {
    const expected = generateTotp(secret, { ...options, step, time: now + offset * step * 1000 });
    if (safeEqual(String(token), expected)) return true;
  }
  return false;
}

export function parseCookies(header) {
  const output = Object.create(null);
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) continue;
    try { output[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch { output[name] = part.slice(index + 1).trim(); }
  }
  return output;
}

export function serializeCookie(name, value, options = {}) {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(String(name))) throw new AuthError('Cookie name is invalid.', { code: 'KR-AUTH-0701', status: 500 });
  let output = `${name}=${encodeURIComponent(String(value))}`;
  if (options.maxAge !== undefined) output += `; Max-Age=${Math.max(0, Math.floor(options.maxAge))}`;
  if (options.domain) output += `; Domain=${options.domain}`;
  if (options.path) output += `; Path=${options.path}`;
  if (options.expires) output += `; Expires=${new Date(options.expires).toUTCString()}`;
  if (options.httpOnly) output += '; HttpOnly';
  if (options.secure) output += '; Secure';
  if (options.sameSite) output += `; SameSite=${normalizeSameSite(options.sameSite)}`;
  if (options.partitioned) output += '; Partitioned';
  if (options.priority) output += `; Priority=${options.priority}`;
  return output;
}

export function signCookieValue(value, secret) {
  const text = String(value);
  const signature = createHmac('sha256', normalizeSecret(secret, 32)).update(text).digest('base64url');
  return `${text}.${signature}`;
}

export function verifyCookieValue(value, secret) {
  const text = String(value);
  const index = text.lastIndexOf('.');
  if (index <= 0) return null;
  const body = text.slice(0, index);
  const signature = text.slice(index + 1);
  const expected = createHmac('sha256', normalizeSecret(secret, 32)).update(body).digest('base64url');
  return safeEqual(signature, expected) ? body : null;
}

function validatePasswordInput(password, options) {
  const value = String(password ?? '');
  const minimum = options.minimumLength ?? 8;
  const maximum = options.maximumLength ?? 1024;
  if (value.length < minimum || value.length > maximum) throw new AuthError(`Password length must be from ${minimum} to ${maximum} characters.`, { code: 'KR-AUTH-0002', status: 400 });
  return value;
}
function validateScryptParameters(cost, blockSize, parallelization, keyLength) {
  if (!Number.isInteger(cost) || cost < 1024 || cost > 1_048_576 || (cost & (cost - 1)) !== 0) throw new AuthError('scrypt cost must be a power of two from 1024 to 1048576.', { code: 'KR-AUTH-0003', status: 500 });
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 32) throw new AuthError('scrypt block size is invalid.', { code: 'KR-AUTH-0004', status: 500 });
  if (!Number.isInteger(parallelization) || parallelization < 1 || parallelization > 16) throw new AuthError('scrypt parallelization is invalid.', { code: 'KR-AUTH-0005', status: 500 });
  if (!Number.isInteger(keyLength) || keyLength < 16 || keyLength > 128) throw new AuthError('scrypt key length is invalid.', { code: 'KR-AUTH-0006', status: 500 });
}
function normalizeSecret(secret, minimumBytes) {
  if (secret === undefined || secret === null || secret === '') throw new AuthError('Authentication secret is required.', { code: 'KR-AUTH-0007', status: 500 });
  const buffer = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret));
  if (buffer.length < minimumBytes) throw new AuthError(`Authentication secret must be at least ${minimumBytes} bytes.`, { code: 'KR-AUTH-0008', status: 500 });
  return buffer;
}
function durationSeconds(value) {
  if (typeof value === 'number') return value;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(String(value));
  if (!match) throw new AuthError(`Invalid duration '${value}'.`, { code: 'KR-AUTH-0009', status: 500 });
  const number = Number(match[1]);
  const multiplier = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }[match[2]?.toLowerCase() ?? 's'];
  return Math.floor(number * multiplier);
}
function base64urlJson(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeJsonSegment(value, label) { try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch (error) { throw new AuthError(`${label} is invalid JSON.`, { code: 'KR-AUTH-0010', cause: error }); } }
function audienceMatches(actual, expected) { const values = Array.isArray(actual) ? actual : actual === undefined ? [] : [actual]; const requirements = Array.isArray(expected) ? expected : [expected]; return requirements.every(item => values.includes(item)); }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
function hashText(value) { return createHash('sha256').update(String(value)).digest('base64url').slice(0, 22); }
function sessionFingerprint(context, options) { const userAgent = context.request?.headers?.['user-agent'] ?? context.request?.headers?.get?.('user-agent') ?? ''; const ip = options.bindIp ? context.ip ?? context.request?.socket?.remoteAddress ?? '' : ''; return hashText(`${userAgent}\0${ip}`); }
function appendHeader(headers, name, value) { const key = String(name).toLowerCase(); const current = headers[key]; headers[key] = current ? Array.isArray(current) ? [...current, value] : [current, value] : value; }
function matchesPermission(granted, required) { if (granted.has('*') || granted.has(required)) return true; const parts = String(required).split(':'); for (let index = parts.length - 1; index > 0; index--) if (granted.has(`${parts.slice(0, index).join(':')}:*`)) return true; return false; }
function normalizeSameSite(value) { const text = String(value).toLowerCase(); if (!['strict', 'lax', 'none'].includes(text)) throw new AuthError('SameSite must be Strict, Lax, or None.', { code: 'KR-AUTH-0702', status: 500 }); return text[0].toUpperCase() + text.slice(1); }
function requiredText(value, name) { if (!value || typeof value !== 'string') throw new AuthError(`${name} is required.`, { code: 'KR-AUTH-0600', status: 500 }); return value; }
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer) { let bits = 0; let value = 0; let output = ''; for (const byte of buffer) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { output += base32Alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31]; return output; }
function base32Decode(text) { let bits = 0; let value = 0; const output = []; for (const char of String(text).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')) { const index = base32Alphabet.indexOf(char); if (index < 0) throw new AuthError('TOTP secret is invalid base32.', { code: 'KR-AUTH-0801', status: 400 }); value = (value << 5) | index; bits += 5; if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(output); }
