// SPDX-License-Identifier: MIT OR Apache-2.0

export class BrowserError extends Error {
  constructor(message, options = {}) {
    super(String(message), { cause: options.cause });
    this.name = 'BrowserError';
    this.code = options.code ?? 'BROWSER_ERROR';
    this.status = options.status ?? null;
    this.response = options.response ?? null;
  }
}

export function record(...pairs) {
  if (pairs.length % 2 !== 0) throw new TypeError('record() expects key/value pairs');
  const output = Object.create(null);
  for (let index = 0; index < pairs.length; index += 2) {
    const key = String(pairs[index]);
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError(`Unsafe record key: ${key}`);
    output[key] = pairs[index + 1];
  }
  return output;
}

export function ready(handler = null) {
  const promise = documentReady();
  return typeof handler === 'function' ? promise.then(handler) : promise;
}

export function select(selector, root = null) {
  return (root ?? requireDocument()).querySelector(String(selector));
}

export function selectAll(selector, root = null) {
  return [...(root ?? requireDocument()).querySelectorAll(String(selector))];
}

export function byId(id) { return requireDocument().getElementById(String(id)); }

export function element(tagName, attributes = null, children = null) {
  const node = requireDocument().createElement(String(tagName));
  if (attributes) setAttributes(node, attributes);
  if (children !== null && children !== undefined) append(node, children);
  return node;
}

export function textNode(value) { return requireDocument().createTextNode(String(value ?? '')); }

export function fragment(...children) {
  const output = requireDocument().createDocumentFragment();
  append(output, children);
  return output;
}

export function append(parent, ...children) {
  const target = resolveNode(parent);
  const flattened = children.flat(Infinity);
  for (const child of flattened) {
    if (child === null || child === undefined || child === false) continue;
    if (isNode(child)) target.append(child);
    else target.append(textNode(child));
  }
  return target;
}

export function prepend(parent, ...children) {
  const target = resolveNode(parent);
  const nodes = children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false).map(value => isNode(value) ? value : textNode(value));
  target.prepend(...nodes);
  return target;
}

export function replace(target, value) {
  const node = resolveNode(target);
  const replacement = isNode(value) ? value : textNode(value);
  node.replaceWith(replacement);
  return replacement;
}

export function remove(target) {
  const node = resolveNode(target);
  node.remove();
  return node;
}

export function clear(target) {
  const node = resolveNode(target);
  node.replaceChildren();
  return node;
}

export function setText(target, value) {
  const node = resolveNode(target);
  node.textContent = String(value ?? '');
  return node;
}

export function setHtml(target, value) {
  const node = resolveNode(target);
  node.innerHTML = String(value ?? '');
  return node;
}

export function setAttributes(target, attributes) {
  const node = resolveNode(target);
  for (const [name, value] of Object.entries(attributes)) {
    if (/^on/i.test(name)) throw new TypeError(`Inline event attribute '${name}' is blocked; use on()`);
    if (name === 'className') { node.className = String(value ?? ''); continue; }
    if (name === 'dataset' && value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) node.dataset[key] = String(item);
      continue;
    }
    if (name === 'style' && value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) node.style[key] = item === null ? '' : String(item);
      continue;
    }
    if (name in node && typeof value !== 'string' && !name.startsWith('aria-')) {
      try { node[name] = value; continue; } catch {}
    }
    if (value === false || value === null || value === undefined) node.removeAttribute(name);
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, String(value));
  }
  return node;
}

export function attr(target, name, value = undefined) {
  const node = resolveNode(target);
  if (value === undefined) return node.getAttribute(String(name));
  if (value === null || value === false) node.removeAttribute(String(name));
  else node.setAttribute(String(name), value === true ? '' : String(value));
  return node;
}

export function classAdd(target, ...names) { const node = resolveNode(target); node.classList.add(...names.flat().map(String)); return node; }
export function classRemove(target, ...names) { const node = resolveNode(target); node.classList.remove(...names.flat().map(String)); return node; }
export function classToggle(target, name, force = undefined) { return resolveNode(target).classList.toggle(String(name), force); }
export function style(target, property, value) { const node = resolveNode(target); node.style.setProperty(String(property), String(value)); return node; }

export function on(target, eventName, handler, options = undefined) {
  if (typeof handler !== 'function') throw new TypeError('on() expects an event handler function');
  const node = resolveEventTarget(target);
  node.addEventListener(String(eventName), handler, options);
  return () => node.removeEventListener(String(eventName), handler, options);
}

export function once(target, eventName, options = undefined) {
  const node = resolveEventTarget(target);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) return reject(options.signal.reason);
      options.signal.addEventListener('abort', () => { controller.abort(); reject(options.signal.reason); }, { once: true });
    }
    node.addEventListener(String(eventName), resolve, { ...options, once: true, signal: controller.signal });
  });
}

export function delegate(target, eventName, selector, handler, options = undefined) {
  if (typeof handler !== 'function') throw new TypeError('delegate() expects a handler function');
  return on(target, eventName, event => {
    const matched = event.target?.closest?.(String(selector));
    if (matched && resolveNode(target).contains(matched)) handler(event, matched);
  }, options);
}

export function mount(target, value) {
  const node = resolveNode(target);
  node.replaceChildren();
  append(node, value);
  return node;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function signal(initialValue) {
  let value = initialValue;
  const subscribers = new Set();
  const api = {
    get() { return value; },
    set(next) {
      const resolved = typeof next === 'function' ? next(value) : next;
      if (Object.is(value, resolved)) return value;
      const previous = value;
      value = resolved;
      for (const subscriber of [...subscribers]) subscriber(value, previous);
      return value;
    },
    update(updater) { if (typeof updater !== 'function') throw new TypeError('signal.update() expects a function'); return api.set(updater); },
    subscribe(subscriber, immediate = true) {
      if (typeof subscriber !== 'function') throw new TypeError('signal.subscribe() expects a function');
      subscribers.add(subscriber);
      if (immediate) subscriber(value, value);
      return () => subscribers.delete(subscriber);
    },
    map(mapper) {
      const output = signal(mapper(value));
      api.subscribe(next => output.set(mapper(next)), false);
      return output;
    },
    bindText(target, mapper = null) { return api.subscribe(next => setText(target, mapper ? mapper(next) : next)); },
    bindAttribute(target, name, mapper = null) { return api.subscribe(next => attr(target, name, mapper ? mapper(next) : next)); },
    get size() { return subscribers.size; },
  };
  return api;
}

export function computed(dependencies, calculate) {
  if (!Array.isArray(dependencies) || typeof calculate !== 'function') throw new TypeError('computed() expects signals and a calculation function');
  const output = signal(calculate(...dependencies.map(item => item.get())));
  const refresh = () => output.set(calculate(...dependencies.map(item => item.get())));
  const unsubscribe = dependencies.map(item => item.subscribe(refresh, false));
  output.dispose = () => unsubscribe.forEach(stop => stop());
  return output;
}

export function effect(dependencies, handler) {
  if (!Array.isArray(dependencies) || typeof handler !== 'function') throw new TypeError('effect() expects signals and a handler');
  const run = () => handler(...dependencies.map(item => item.get()));
  const unsubscribe = dependencies.map(item => item.subscribe(run, false));
  run();
  return () => unsubscribe.forEach(stop => stop());
}

export function storage(name, fallback = null, options = {}) {
  const store = options.session ? requireWindow().sessionStorage : requireWindow().localStorage;
  const key = String(name);
  return {
    get() {
      const raw = store.getItem(key);
      if (raw === null) return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    },
    set(value) { store.setItem(key, JSON.stringify(value)); return value; },
    remove() { store.removeItem(key); },
    has() { return store.getItem(key) !== null; },
    clear() { store.clear(); },
  };
}

export function formObject(form) {
  const data = new FormData(resolveNode(form));
  const output = Object.create(null);
  for (const [key, value] of data) {
    if (Object.hasOwn(output, key)) output[key] = Array.isArray(output[key]) ? [...output[key], value] : [output[key], value];
    else output[key] = value;
  }
  return output;
}

export function queryString(...pairs) {
  if (pairs.length % 2 !== 0) throw new TypeError('queryString() expects key/value pairs');
  const output = new URLSearchParams();
  for (let index = 0; index < pairs.length; index += 2) {
    const key = String(pairs[index]);
    const value = pairs[index + 1];
    if (Array.isArray(value)) for (const item of value) output.append(key, String(item));
    else if (value !== null && value !== undefined) output.append(key, String(value));
  }
  return output.toString();
}

export async function request(url, options = {}) {
  const target = new URL(String(url), globalThis.location?.href ?? 'http://localhost/');
  if (options.query) {
    const params = options.query instanceof URLSearchParams ? options.query : new URLSearchParams(options.query);
    for (const [key, value] of params) target.searchParams.append(key, value);
  }
  const controller = new AbortController();
  const cleanup = bridgeSignal(options.signal, controller);
  const timeoutMs = Number(options.timeoutMs ?? 30_000);
  const timer = setTimeout(() => controller.abort(new BrowserError('Request timed out', { code: 'BROWSER_TIMEOUT' })), timeoutMs);
  const requestHeaders = new Headers(options.headers ?? {});
  let body = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json; charset=utf-8');
    if (!requestHeaders.has('accept')) requestHeaders.set('accept', 'application/json');
  }
  try {
    const response = await fetch(target, { ...options, body, headers: requestHeaders, signal: controller.signal });
    const wrapped = {
      raw: response,
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: response.headers,
      header(name, fallback = null) { return response.headers.get(String(name)) ?? fallback; },
      text() { return response.text(); },
      json() { return response.json(); },
      bytes() { return response.arrayBuffer(); },
      blob() { return response.blob(); },
    };
    if (options.throwForStatus !== false && !response.ok) throw new BrowserError(`HTTP ${response.status} ${response.statusText}`, { code: 'BROWSER_HTTP_STATUS', status: response.status, response: wrapped });
    return wrapped;
  } catch (error) {
    if (error instanceof BrowserError) throw error;
    throw new BrowserError(error instanceof Error ? error.message : String(error), { code: error?.name === 'AbortError' ? 'BROWSER_ABORTED' : 'BROWSER_NETWORK', cause: error });
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

export async function getJson(url, options = {}) { return (await request(url, { ...options, headers: mergeHeaders({ accept: 'application/json' }, options.headers) })).json(); }
export async function postJson(url, value, options = {}) { return request(url, { ...options, method: 'POST', json: value }); }

export function openWebSocket(url, options = {}) {
  const socket = new WebSocket(String(url), options.protocols);
  const messageHandlers = new Set();
  const openHandlers = new Set();
  const closeHandlers = new Set();
  const errorHandlers = new Set();
  socket.binaryType = options.binaryType ?? 'arraybuffer';
  socket.addEventListener('open', event => { for (const handler of openHandlers) handler(event, api); });
  socket.addEventListener('message', event => { for (const handler of messageHandlers) handler(event.data, event, api); });
  socket.addEventListener('close', event => { for (const handler of closeHandlers) handler(event.code, event.reason, event, api); });
  socket.addEventListener('error', event => { for (const handler of errorHandlers) handler(event, api); });
  const api = {
    raw: socket,
    send(value) { socket.send(value); return api; },
    sendJson(value) { socket.send(JSON.stringify(value)); return api; },
    close(code = 1000, reason = '') { socket.close(code, reason); },
    onOpen(handler) { openHandlers.add(handler); return () => openHandlers.delete(handler); },
    onMessage(handler) { messageHandlers.add(handler); return () => messageHandlers.delete(handler); },
    onClose(handler) { closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
    onError(handler) { errorHandlers.add(handler); return () => errorHandlers.delete(handler); },
    get readyState() { return socket.readyState; },
    get protocol() { return socket.protocol; },
  };
  return api;
}

export function openEvents(url, options = {}) {
  const source = new EventSource(String(url), { withCredentials: Boolean(options.withCredentials) });
  return {
    raw: source,
    on(eventName, handler) { source.addEventListener(String(eventName), handler); return () => source.removeEventListener(String(eventName), handler); },
    onMessage(handler) { source.addEventListener('message', handler); return () => source.removeEventListener('message', handler); },
    onError(handler) { source.addEventListener('error', handler); return () => source.removeEventListener('error', handler); },
    close() { source.close(); },
  };
}

export function createRouter(options = {}) {
  const routes = [];
  const beforeHandlers = [];
  const afterHandlers = [];
  const base = normalizeBase(options.base ?? '/');
  let notFound = options.notFound ?? null;
  let started = false;

  const router = {
    route(pattern, handler) {
      if (typeof handler !== 'function') throw new TypeError('router.route() expects a handler function');
      routes.push({ pattern: String(pattern), handler, ...compileRoute(pattern) });
      return router;
    },
    before(handler) { beforeHandlers.push(handler); return router; },
    after(handler) { afterHandlers.push(handler); return router; },
    notFound(handler) { notFound = handler; return router; },
    async navigate(destination, state = null, replaceHistory = false) {
      const target = new URL(String(destination), requireWindow().location.href);
      const history = requireWindow().history;
      if (replaceHistory) history.replaceState(state, '', target);
      else history.pushState(state, '', target);
      return router.resolve(target);
    },
    async resolve(value = null) {
      const target = value instanceof URL ? value : new URL(String(value ?? requireWindow().location.href), requireWindow().location.href);
      const pathname = stripBase(target.pathname, base);
      const match = matchRoute(routes, pathname);
      const context = {
        router, url: target, path: pathname, params: match?.params ?? Object.create(null),
        query: target.searchParams, state: requireWindow().history.state,
        param(name, fallback = null) { return context.params[String(name)] ?? fallback; },
        queryValue(name, fallback = null) { return target.searchParams.get(String(name)) ?? fallback; },
      };
      for (const handler of beforeHandlers) if (await handler(context) === false) return false;
      const result = match ? await match.route.handler(context) : notFound ? await notFound(context) : null;
      for (const handler of afterHandlers) await handler(context, result);
      return result;
    },
    start() {
      if (started) return router;
      started = true;
      on(requireWindow(), 'popstate', () => router.resolve());
      if (options.interceptLinks !== false) {
        on(requireDocument(), 'click', event => {
          const link = event.target?.closest?.('a[href]');
          if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const target = new URL(link.href, requireWindow().location.href);
          if (target.origin !== requireWindow().location.origin || link.target || link.hasAttribute('download')) return;
          event.preventDefault();
          router.navigate(target);
        });
      }
      router.resolve();
      return router;
    },
    stop() { started = false; },
    get routes() { return [...routes]; },
  };
  return router;
}

function compileRoute(pattern) {
  const source = String(pattern || '/');
  const names = [];
  let regex = '^';
  for (const segment of source.split('/').filter(Boolean)) {
    regex += '/';
    if (segment === '*') { names.push('wildcard'); regex += '(.*)'; }
    else if (segment.startsWith(':')) { names.push(segment.slice(1)); regex += '([^/]+)'; }
    else regex += segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (source === '/') regex += '/';
  regex += '$';
  return { regex: new RegExp(regex), names };
}

function matchRoute(routes, path) {
  for (const route of routes) {
    const match = route.regex.exec(path);
    if (!match) continue;
    const params = Object.create(null);
    route.names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); });
    return { route, params };
  }
  return null;
}

function normalizeBase(value) { const output = `/${String(value).split('/').filter(Boolean).join('/')}`; return output === '/' ? '' : output; }
function stripBase(pathname, base) { if (!base) return pathname; return pathname === base ? '/' : pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname; }
function documentReady() { if (requireDocument().readyState === 'loading') return once(requireDocument(), 'DOMContentLoaded'); return Promise.resolve(); }
function resolveNode(value) { if (typeof value === 'string') { const node = select(value); if (!node) throw new BrowserError(`Element not found: ${value}`, { code: 'BROWSER_ELEMENT_NOT_FOUND' }); return node; } if (!isNode(value)) throw new TypeError('Expected a DOM node or selector'); return value; }
function resolveEventTarget(value) { if (typeof value === 'string') return resolveNode(value); if (!value?.addEventListener) throw new TypeError('Expected an EventTarget or selector'); return value; }
function isNode(value) { return typeof Node !== 'undefined' && value instanceof Node; }
function requireWindow() { if (typeof window === 'undefined') throw new BrowserError('This API requires a browser window', { code: 'BROWSER_ONLY' }); return window; }
function requireDocument() { if (typeof document === 'undefined') throw new BrowserError('This API requires a browser document', { code: 'BROWSER_ONLY' }); return document; }
function bridgeSignal(signalValue, controller) { if (!signalValue) return () => {}; if (signalValue.aborted) controller.abort(signalValue.reason); const abort = () => controller.abort(signalValue.reason); signalValue.addEventListener('abort', abort, { once: true }); return () => signalValue.removeEventListener('abort', abort); }
function mergeHeaders(first, second) { const output = new Headers(first); new Headers(second ?? {}).forEach((value, key) => output.set(key, value)); return output; }
