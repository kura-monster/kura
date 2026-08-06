// SPDX-License-Identifier: MIT OR Apache-2.0
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(message, options = {}) {
    super(String(message), { cause: options.cause });
    this.name = 'HttpError';
    this.code = options.code ?? 'HTTP_ERROR';
    this.status = options.status ?? null;
    this.url = options.url ?? null;
    this.method = options.method ?? null;
    this.response = options.response ?? null;
    this.attempt = options.attempt ?? null;
    this.retryable = Boolean(options.retryable);
  }
}

export class HttpResponse {
  constructor(response, body, elapsedMs) {
    this.url = response.url;
    this.status = response.status;
    this.statusText = response.statusText;
    this.ok = response.ok;
    this.redirected = response.redirected;
    this.type = response.type;
    this.headers = response.headers;
    this.body = body;
    this.elapsedMs = elapsedMs;
  }

  header(name, fallback = null) { return this.headers.get(String(name)) ?? fallback; }
  bytes() { return Buffer.from(this.body); }
  text(encoding = 'utf8') { return this.body.toString(encoding); }
  json() {
    try { return JSON.parse(this.text()); }
    catch (error) { throw new HttpError('HTTP response is not valid JSON', { code: 'HTTP_INVALID_JSON', status: this.status, url: this.url, response: this, cause: error }); }
  }
}

export function options(...pairs) {
  if (pairs.length % 2 !== 0) throw new TypeError('http.options() expects key/value pairs');
  const output = Object.create(null);
  for (let index = 0; index < pairs.length; index += 2) {
    const key = String(pairs[index]);
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new TypeError(`Unsafe option key: ${key}`);
    output[key] = pairs[index + 1];
  }
  return output;
}

export function query(...pairs) {
  if (pairs.length % 2 !== 0) throw new TypeError('http.query() expects key/value pairs');
  const output = new URLSearchParams();
  for (let index = 0; index < pairs.length; index += 2) {
    const key = String(pairs[index]);
    const value = pairs[index + 1];
    if (Array.isArray(value)) for (const item of value) output.append(key, String(item));
    else if (value !== null && value !== undefined) output.append(key, String(value));
  }
  return output;
}

export function headers(...pairs) {
  if (pairs.length % 2 !== 0) throw new TypeError('http.headers() expects key/value pairs');
  const output = new Headers();
  for (let index = 0; index < pairs.length; index += 2) output.set(String(pairs[index]), String(pairs[index + 1]));
  return output;
}

export async function request(url, requestOptions = {}) {
  const target = withQuery(url, requestOptions.query);
  const method = String(requestOptions.method ?? (requestOptions.json !== undefined || requestOptions.form !== undefined ? 'POST' : 'GET')).toUpperCase();
  const maximum = positiveInteger(requestOptions.maxBytes, DEFAULT_MAX_BYTES);
  const timeoutMs = positiveInteger(requestOptions.timeoutMs, DEFAULT_TIMEOUT_MS);
  const retries = nonNegativeInteger(requestOptions.retries, 0);
  const retryDelayMs = nonNegativeInteger(requestOptions.retryDelayMs, 250);
  const retryMethods = new Set((requestOptions.retryMethods ?? ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']).map(value => String(value).toUpperCase()));
  const retryStatus = new Set(requestOptions.retryStatus ?? DEFAULT_RETRY_STATUS);
  const throwForStatus = requestOptions.throwForStatus !== false;
  const requestHeaders = new Headers(requestOptions.headers ?? {});
  let body = requestOptions.body;

  if (requestOptions.json !== undefined) {
    body = JSON.stringify(requestOptions.json);
    if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json; charset=utf-8');
    if (!requestHeaders.has('accept')) requestHeaders.set('accept', 'application/json');
  } else if (requestOptions.form !== undefined) {
    body = requestOptions.form instanceof URLSearchParams ? requestOptions.form : new URLSearchParams(requestOptions.form);
    if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/x-www-form-urlencoded; charset=utf-8');
  }

  if (!requestHeaders.has('user-agent')) requestHeaders.set('user-agent', requestOptions.userAgent ?? 'Kura-HTTP/1.0');
  const canRetry = retryMethods.has(method) || Boolean(requestOptions.retryUnsafeMethods);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const retryAfter = lastError?.response ? parseRetryAfter(lastError.response.header('retry-after')) : null;
      const backoff = retryAfter ?? Math.min(30_000, retryDelayMs * (2 ** (attempt - 1)));
      await delay(jitter(backoff), undefined, { signal: requestOptions.signal });
    }
    const controller = new AbortController();
    const cleanupSignal = bridgeAbortSignal(requestOptions.signal, controller);
    const timer = setTimeout(() => controller.abort(new HttpError(`HTTP request timed out after ${timeoutMs} ms`, { code: 'HTTP_TIMEOUT', url: target.href, method, attempt: attempt + 1, retryable: canRetry })), timeoutMs);
    timer.unref?.();
    const startedAt = process.hrtime.bigint();
    try {
      const raw = await fetch(target, {
        method,
        headers: requestHeaders,
        body,
        redirect: requestOptions.redirect ?? 'follow',
        signal: controller.signal,
        credentials: requestOptions.credentials,
        cache: requestOptions.cache,
        integrity: requestOptions.integrity,
        keepalive: requestOptions.keepalive,
      });
      const bodyBytes = await readBody(raw, maximum, controller);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const wrapped = new HttpResponse(raw, bodyBytes, elapsedMs);
      const accepted = typeof requestOptions.validateStatus === 'function' ? Boolean(await requestOptions.validateStatus(wrapped.status, wrapped)) : wrapped.ok;
      if (throwForStatus && !accepted) {
        const retryable = canRetry && retryStatus.has(wrapped.status);
        throw new HttpError(`HTTP ${wrapped.status} ${wrapped.statusText}`, {
          code: 'HTTP_STATUS', status: wrapped.status, url: wrapped.url, method, response: wrapped,
          attempt: attempt + 1, retryable,
        });
      }
      return wrapped;
    } catch (error) {
      const normalized = normalizeError(error, target.href, method, attempt + 1, canRetry);
      lastError = normalized;
      if (attempt >= retries || !normalized.retryable) throw normalized;
    } finally {
      clearTimeout(timer);
      cleanupSignal();
    }
  }
  throw lastError ?? new HttpError('HTTP request failed', { url: target.href, method });
}

export async function fetchBytes(url, requestOptions = {}) { return (await request(url, requestOptions)).bytes(); }
export async function fetchText(url, requestOptions = {}) { return (await request(url, requestOptions)).text(requestOptions.encoding ?? 'utf8'); }
export async function fetchJson(url, requestOptions = {}) {
  return (await request(url, { ...requestOptions, headers: mergeHeaders({ accept: 'application/json' }, requestOptions.headers) })).json();
}
export async function get(url, requestOptions = {}) { return request(url, { ...requestOptions, method: 'GET' }); }
export async function getText(url, requestOptions = {}) { return (await get(url, requestOptions)).text(requestOptions.encoding ?? 'utf8'); }
export async function getJson(url, requestOptions = {}) { return (await get(url, { ...requestOptions, headers: mergeHeaders({ accept: 'application/json' }, requestOptions.headers) })).json(); }
export async function postJson(url, value, requestOptions = {}) { return request(url, { ...requestOptions, method: 'POST', json: value }); }
export async function putJson(url, value, requestOptions = {}) { return request(url, { ...requestOptions, method: 'PUT', json: value }); }
export async function patchJson(url, value, requestOptions = {}) { return request(url, { ...requestOptions, method: 'PATCH', json: value }); }
export async function deleteRequest(url, requestOptions = {}) { return request(url, { ...requestOptions, method: 'DELETE' }); }

async function readBody(response, maximum, controller) {
  if (!response.body) return Buffer.alloc(0);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    controller.abort();
    throw new HttpError(`Response exceeds ${maximum} bytes`, { code: 'HTTP_RESPONSE_TOO_LARGE', status: response.status, url: response.url, retryable: false });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maximum) {
      controller.abort();
      throw new HttpError(`Response exceeds ${maximum} bytes`, { code: 'HTTP_RESPONSE_TOO_LARGE', status: response.status, url: response.url, retryable: false });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

function withQuery(url, value) {
  const target = new URL(String(url));
  if (!value) return target;
  const params = value instanceof URLSearchParams ? value : new URLSearchParams(value);
  for (const [key, item] of params) target.searchParams.append(key, item);
  return target;
}
function bridgeAbortSignal(signal, controller) {
  if (!signal) return () => {};
  if (signal.aborted) controller.abort(signal.reason);
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}
function normalizeError(error, url, method, attempt, canRetry) {
  if (error instanceof HttpError) return error;
  if (error?.name === 'AbortError') return new HttpError('HTTP request was aborted', { code: 'HTTP_ABORTED', url, method, attempt, cause: error, retryable: false });
  return new HttpError(error instanceof Error ? error.message : String(error), { code: 'HTTP_NETWORK', url, method, attempt, cause: error, retryable: canRetry });
}
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  const date = new Date(value).getTime();
  return Number.isFinite(date) ? Math.max(0, Math.min(60_000, date - Date.now())) : null;
}
function jitter(value) { return Math.max(0, Math.round(value * (0.8 + Math.random() * 0.4))); }
function positiveInteger(value, fallback) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : fallback; }
function nonNegativeInteger(value, fallback) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : fallback; }
function mergeHeaders(first, second) { const output = new Headers(first); new Headers(second ?? {}).forEach((value, key) => output.set(key, value)); return output; }
