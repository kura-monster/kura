// SPDX-License-Identifier: MIT OR Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const traceStorage = new AsyncLocalStorage();
const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100 });

export class Logger {
  constructor(options = {}) {
    this.name = options.name ?? 'kura';
    this.level = normalizeLevel(options.level ?? process.env.LOG_LEVEL ?? 'info');
    this.destination = options.destination ?? process.stdout;
    this.base = Object.freeze({ service: this.name, hostname: options.hostname ?? hostname(), pid: process.pid, ...(options.base ?? {}) });
    this.redact = (options.redact ?? defaultRedactions).map(pattern => pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'ig'));
    this.pretty = Boolean(options.pretty ?? process.env.NODE_ENV !== 'production');
    this.serializers = options.serializers ?? {};
  }

  child(bindings = {}) { return new Logger({ name: this.name, level: this.level, destination: this.destination, base: { ...this.base, ...bindings }, redact: this.redact, pretty: this.pretty, serializers: this.serializers }); }
  trace(message, fields) { this.log('trace', message, fields); }
  debug(message, fields) { this.log('debug', message, fields); }
  info(message, fields) { this.log('info', message, fields); }
  warn(message, fields) { this.log('warn', message, fields); }
  error(message, fields) { this.log('error', message, fields); }
  fatal(message, fields) { this.log('fatal', message, fields); }

  log(level, message, fields = {}) {
    const numeric = normalizeLevel(level);
    if (numeric < this.level) return;
    const trace = currentTrace();
    const record = sanitizeRecord({
      time: new Date().toISOString(),
      level: levelName(numeric),
      message: typeof message === 'string' ? message : message?.message ?? String(message),
      ...this.base,
      ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
      ...serializeFields(fields, this.serializers),
      ...(message instanceof Error ? serializeError(message) : {}),
    }, this.redact);
    const line = this.pretty ? prettyLine(record) : JSON.stringify(record);
    this.destination.write(`${line}\n`);
  }
}

export function createLogger(options = {}) { return new Logger(options); }

export class MetricsRegistry {
  constructor(options = {}) {
    this.prefix = sanitizeMetricName(options.prefix ?? 'kura');
    this.metrics = new Map();
    this.defaultLabels = Object.freeze({ ...(options.defaultLabels ?? {}) });
  }

  counter(name, help = '', options = {}) { return this.#metric('counter', name, help, options); }
  gauge(name, help = '', options = {}) { return this.#metric('gauge', name, help, options); }
  histogram(name, help = '', options = {}) { return this.#metric('histogram', name, help, { buckets: options.buckets ?? [0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10], ...options }); }

  #metric(type, name, help, options) {
    const fullName = sanitizeMetricName(`${this.prefix}_${name}`);
    if (this.metrics.has(fullName)) return this.metrics.get(fullName);
    const metric = new Metric(type, fullName, help, { ...options, defaultLabels: this.defaultLabels });
    this.metrics.set(fullName, metric);
    return metric;
  }

  prometheus() { return [...this.metrics.values()].map(metric => metric.prometheus()).join(''); }
  json() { return Object.fromEntries([...this.metrics].map(([name, metric]) => [name, metric.snapshot()])); }
  reset() { for (const metric of this.metrics.values()) metric.reset(); }
}

class Metric {
  constructor(type, name, help, options) {
    this.type = type;
    this.name = name;
    this.help = String(help ?? '').replace(/\n/g, ' ');
    this.labelNames = Object.freeze([...(options.labels ?? [])].map(String).sort());
    this.defaultLabels = options.defaultLabels;
    this.buckets = Object.freeze([...(options.buckets ?? [])].map(Number).sort((a,b)=>a-b));
    this.values = new Map();
  }

  inc(value = 1, labels = {}) { this.#update(Number(value), labels, 'inc'); }
  dec(value = 1, labels = {}) { if (this.type !== 'gauge') throw new Error('Only gauges can decrement'); this.#update(-Number(value), labels, 'inc'); }
  set(value, labels = {}) { if (this.type !== 'gauge') throw new Error('Only gauges can be set'); this.#update(Number(value), labels, 'set'); }
  observe(value, labels = {}) {
    if (this.type !== 'histogram') throw new Error('Only histograms can observe');
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    const entry = this.#entry(labels);
    entry.count++;
    entry.sum += number;
    for (let index = 0; index < this.buckets.length; index++) if (number <= this.buckets[index]) entry.buckets[index]++;
  }

  startTimer(labels = {}) { const started = process.hrtime.bigint(); return extra => { const seconds = Number(process.hrtime.bigint() - started) / 1e9; this.observe(seconds, { ...labels, ...(extra ?? {}) }); return seconds; }; }
  reset() { this.values.clear(); }
  snapshot() { return [...this.values.values()].map(entry => ({ labels: entry.labels, value: entry.value, count: entry.count, sum: entry.sum, buckets: entry.buckets ? [...entry.buckets] : undefined })); }

  prometheus() {
    const lines = [`# HELP ${this.name} ${escapeMetricText(this.help)}`, `# TYPE ${this.name} ${this.type}`];
    for (const entry of this.values.values()) {
      if (this.type !== 'histogram') lines.push(`${this.name}${formatLabels(entry.labels)} ${formatNumber(entry.value)}`);
      else {
        for (let index = 0; index < this.buckets.length; index++) lines.push(`${this.name}_bucket${formatLabels({ ...entry.labels, le: String(this.buckets[index]) })} ${entry.buckets[index]}`);
        lines.push(`${this.name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
        lines.push(`${this.name}_sum${formatLabels(entry.labels)} ${formatNumber(entry.sum)}`);
        lines.push(`${this.name}_count${formatLabels(entry.labels)} ${entry.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  #update(value, labels, mode) {
    if (!Number.isFinite(value)) return;
    if (this.type === 'counter' && value < 0) throw new Error('Counters cannot decrement');
    const entry = this.#entry(labels);
    entry.value = mode === 'set' ? value : entry.value + value;
  }

  #entry(labels) {
    const normalized = { ...this.defaultLabels, ...labels };
    const selected = Object.fromEntries(this.labelNames.map(name => [name, normalized[name] ?? '']));
    for (const name of Object.keys(normalized)) if (!this.labelNames.includes(name) && !Object.hasOwn(this.defaultLabels, name)) throw new Error(`Unknown metric label '${name}'`);
    const key = JSON.stringify(selected);
    if (!this.values.has(key)) this.values.set(key, { labels: selected, value: 0, count: 0, sum: 0, buckets: this.type === 'histogram' ? this.buckets.map(() => 0) : null });
    return this.values.get(key);
  }
}

export class HealthRegistry {
  constructor(options = {}) { this.checks = new Map(); this.timeoutMs = options.timeoutMs ?? 5_000; }
  register(name, check, options = {}) { if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error('Invalid health check name'); if (typeof check !== 'function') throw new TypeError('Health check must be a function'); this.checks.set(name, { check, critical: options.critical !== false, timeoutMs: options.timeoutMs ?? this.timeoutMs }); return this; }
  remove(name) { this.checks.delete(name); }
  async run() {
    const started = performance.now();
    const results = {};
    let healthy = true;
    for (const [name, item] of this.checks) {
      const checkStarted = performance.now();
      try {
        const result = await withTimeout(item.check(), item.timeoutMs);
        const status = result === false ? 'fail' : result?.status ?? 'ok';
        results[name] = { status, durationMs: performance.now() - checkStarted, details: result && typeof result === 'object' ? result.details ?? null : null, critical: item.critical };
        if (item.critical && status !== 'ok') healthy = false;
      } catch (error) {
        results[name] = { status: 'fail', durationMs: performance.now() - checkStarted, error: String(error?.message ?? error), critical: item.critical };
        if (item.critical) healthy = false;
      }
    }
    return Object.freeze({ status: healthy ? 'ok' : 'fail', uptime: process.uptime(), timestamp: new Date().toISOString(), durationMs: performance.now() - started, checks: Object.freeze(results) });
  }
}

export function createHealthRegistry(options = {}) { return new HealthRegistry(options); }

export function healthHandler(registry, options = {}) {
  return async () => {
    const report = await registry.run();
    return { status: report.status === 'ok' ? 200 : options.failureStatus ?? 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(report) };
  };
}

export function metricsHandler(registry, options = {}) {
  return async context => {
    if (options.token) {
      const authorization = context.request?.headers?.authorization ?? context.request?.headers?.get?.('authorization') ?? '';
      if (authorization !== `Bearer ${options.token}`) return { status: 401, headers: { 'www-authenticate': 'Bearer' }, body: 'Unauthorized' };
    }
    return { status: 200, headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' }, body: registry.prometheus() };
  };
}

export function requestObservability(options = {}) {
  const logger = options.logger ?? createLogger();
  const metrics = options.metrics ?? new MetricsRegistry();
  const requests = metrics.counter('http_requests_total', 'Total HTTP requests', { labels: ['method','route','status'] });
  const duration = metrics.histogram('http_request_duration_seconds', 'HTTP request duration in seconds', { labels: ['method','route','status'] });
  const active = metrics.gauge('http_requests_active', 'Active HTTP requests', { labels: ['method'] });
  return async (context, next) => {
    const method = String(context.request?.method ?? context.method ?? 'GET').toUpperCase();
    const requestId = context.requestId ?? randomUUID();
    const traceId = context.request?.headers?.['x-trace-id'] ?? context.request?.headers?.get?.('x-trace-id') ?? randomHex(16);
    const span = { traceId, spanId: randomHex(8), parentSpanId: null, name: `${method} ${context.path ?? context.url?.pathname ?? '/'}`, startedAt: performance.now(), attributes: {} };
    active.inc(1, { method });
    const stop = duration.startTimer({ method, route: context.route?.pattern ?? context.path ?? 'unmatched', status: 'pending' });
    context.requestId = requestId;
    context.trace = span;
    context.responseHeaders ??= {};
    context.responseHeaders['x-request-id'] = requestId;
    context.responseHeaders['x-trace-id'] = traceId;
    const started = performance.now();
    try {
      return await traceStorage.run(span, next);
    } catch (error) {
      logger.error('http.request.failed', { requestId, method, path: context.path, durationMs: performance.now() - started, error });
      throw error;
    } finally {
      const status = String(context.response?.status ?? context.status ?? 200);
      stop({ status });
      requests.inc(1, { method, route: context.route?.pattern ?? context.path ?? 'unmatched', status });
      active.dec(1, { method });
      logger.info('http.request', { requestId, method, path: context.path ?? context.url?.pathname, status: Number(status), durationMs: performance.now() - started, ip: options.logIp ? context.ip : undefined, userAgent: options.logUserAgent ? context.request?.headers?.['user-agent'] : undefined });
    }
  };
}

export async function trace(name, callback, options = {}) {
  const parent = currentTrace();
  const span = { traceId: parent?.traceId ?? randomHex(16), spanId: randomHex(8), parentSpanId: parent?.spanId ?? null, name: String(name), startedAt: performance.now(), attributes: { ...(options.attributes ?? {}) }, status: 'ok' };
  try {
    const value = await traceStorage.run(span, () => callback(span));
    span.durationMs = performance.now() - span.startedAt;
    options.exporter?.(Object.freeze({ ...span }));
    return value;
  } catch (error) {
    span.status = 'error'; span.error = String(error?.message ?? error); span.durationMs = performance.now() - span.startedAt;
    options.exporter?.(Object.freeze({ ...span }));
    throw error;
  }
}

export function currentTrace() { return traceStorage.getStore() ?? null; }
export function setTraceAttribute(name, value) { const span = currentTrace(); if (span) span.attributes[String(name)] = value; }

export function createOtlpExporter(options = {}) {
  if (process.env.KURA_SECURITY_MODE === 'strict') throw new Error('Strict security mode blocks OTLP network export.');
  const endpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const queue = [];
  const maxBatch = options.maxBatch ?? 128;
  let timer = null;
  async function flush() {
    clearTimeout(timer); timer = null;
    if (!endpoint || !queue.length) return;
    const batch = queue.splice(0, maxBatch);
    const payload = { resourceSpans: [{ resource: { attributes: Object.entries(options.resource ?? {}).map(([key, value]) => ({ key, value: { stringValue: String(value) } })) }, scopeSpans: [{ scope: { name: 'kura' }, spans: batch.map(toOtlpSpan) }] }] };
    const response = await fetch(`${String(endpoint).replace(/\/$/,'')}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }, body: JSON.stringify(payload) });
    if (!response.ok && options.onError) options.onError(new Error(`OTLP HTTP ${response.status}`));
  }
  return Object.freeze({ export(span) { queue.push(span); if (queue.length >= maxBatch) void flush(); else if (!timer) { timer = setTimeout(() => void flush(), options.flushIntervalMs ?? 5_000); timer.unref?.(); } }, flush, async close() { await flush(); } });
}

function serializeFields(fields, serializers) { if (!fields) return {}; if (fields instanceof Error) return serializeError(fields); const output = {}; for (const [key,value] of Object.entries(fields)) output[key] = serializers[key] ? serializers[key](value) : value instanceof Error ? serializeError(value) : value; return output; }
function serializeError(error) { return { error: { name: error.name, message: error.message, code: error.code, stack: error.stack, cause: error.cause ? String(error.cause?.message ?? error.cause) : undefined } }; }
function sanitizeRecord(record, redactions) { const seen = new WeakSet(); const walk = (value, key = '') => { if (redactions.some(pattern => pattern.test(key))) return '[REDACTED]'; if (!value || typeof value !== 'object') return value; if (seen.has(value)) return '[Circular]'; seen.add(value); if (Array.isArray(value)) return value.map(item => walk(item, key)); return Object.fromEntries(Object.entries(value).map(([childKey,child]) => [childKey, walk(child, childKey)])); }; return walk(record); }
function prettyLine(record) { const fields = { ...record }; delete fields.time; delete fields.level; delete fields.message; const suffix = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''; return `${record.time} ${record.level.toUpperCase().padEnd(5)} ${record.message}${suffix}`; }
function normalizeLevel(value) { if (typeof value === 'number') return value; const key = String(value).toLowerCase(); if (!(key in LEVELS)) throw new Error(`Unknown log level '${value}'`); return LEVELS[key]; }
function levelName(number) { return Object.entries(LEVELS).find(([,value]) => value === number)?.[0] ?? 'info'; }
function sanitizeMetricName(value) { const output = String(value).replace(/[^A-Za-z0-9_:]/g,'_'); return /^[A-Za-z_:]/.test(output) ? output : `_${output}`; }
function escapeMetricText(value) { return String(value).replace(/\\/g,'\\\\').replace(/\n/g,'\\n'); }
function formatLabels(labels) { const entries = Object.entries(labels); return entries.length ? `{${entries.map(([key,value]) => `${sanitizeMetricName(key)}="${String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n')}"`).join(',')}}` : ''; }
function formatNumber(value) { if (Number.isNaN(value)) return 'NaN'; if (value === Infinity) return '+Inf'; if (value === -Infinity) return '-Inf'; return String(value); }
function randomHex(bytes) { return Buffer.from(cryptoRandom(bytes)).toString('hex'); }
function cryptoRandom(bytes) { const value = new Uint8Array(bytes); globalThis.crypto.getRandomValues(value); return value; }
function withTimeout(promise, timeoutMs) { return Promise.race([Promise.resolve(promise), new Promise((_resolve,reject)=>{ const timer=setTimeout(()=>reject(new Error(`Timed out after ${timeoutMs} ms`)),timeoutMs); timer.unref?.(); })]); }
function toOtlpSpan(span) { return { traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId ?? '', name: span.name, kind: 1, startTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n - BigInt(Math.floor((span.durationMs ?? 0) * 1_000_000))), endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n), attributes: Object.entries(span.attributes ?? {}).map(([key,value])=>({key,value:{stringValue:String(value)}})), status: { code: span.status === 'error' ? 2 : 1, message: span.error ?? '' } }; }
const defaultRedactions = [/password/i,/passwd/i,/secret/i,/token/i,/authorization/i,/cookie/i,/api[-_]?key/i,/private[-_]?key/i];
