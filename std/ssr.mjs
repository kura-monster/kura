// SPDX-License-Identifier: MIT OR Apache-2.0
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RAW = Symbol('kura.raw.html');
const VOID_ELEMENTS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

export class SsrError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'SsrError';
    this.code = options.code ?? 'KR-SSR-0001';
  }
}

export function raw(value) {
  return Object.freeze({ [RAW]: true, value: String(value) });
}

export function html(strings, ...values) {
  if (!Array.isArray(strings) || !Object.hasOwn(strings, 'raw')) throw new SsrError('html must be used as a tagged template.', { code: 'KR-SSR-0101' });
  let output = '';
  for (let index = 0; index < strings.length; index++) {
    output += strings[index];
    if (index < values.length) output += renderValue(values[index]);
  }
  return raw(output);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;').replace(/\r?\n/g, '&#10;');
}

export function attrs(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new SsrError('attrs expects an object.', { code: 'KR-SSR-0102' });
  const output = [];
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z_:][A-Za-z0-9:._-]*$/.test(name) || /^on/i.test(name)) continue;
    if (value === false || value === null || value === undefined) continue;
    if (value === true) output.push(name);
    else if (name === 'class' && Array.isArray(value)) output.push(`${name}="${escapeAttribute(value.filter(Boolean).join(' '))}"`);
    else if (name === 'style' && value && typeof value === 'object') output.push(`${name}="${escapeAttribute(style(value))}"`);
    else output.push(`${name}="${escapeAttribute(value)}"`);
  }
  return raw(output.length ? ` ${output.join(' ')}` : '');
}

export function style(values = {}) {
  return Object.entries(values)
    .filter(([key, value]) => /^--[A-Za-z0-9_-]+$/.test(key) || /^[A-Za-z][A-Za-z0-9-]*$/.test(key) && value !== null && value !== undefined && value !== false)
    .map(([key, value]) => `${toKebabCase(key)}:${String(value).replace(/[;{}]/g, '')}`)
    .join(';');
}

export function element(name, properties = {}, ...children) {
  const tag = String(name).toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) throw new SsrError(`Invalid element name '${name}'.`, { code: 'KR-SSR-0103' });
  const opening = `<${tag}${attrs(properties).value}>`;
  if (VOID_ELEMENTS.has(tag)) return raw(opening.slice(0, -1) + '>');
  return raw(`${opening}${children.map(renderValue).join('')}</${tag}>`);
}

export function component(renderer, options = {}) {
  if (typeof renderer !== 'function') throw new SsrError('component expects a function.', { code: 'KR-SSR-0201' });
  const name = options.name ?? renderer.name ?? 'AnonymousComponent';
  const wrapped = async (properties = {}, context = {}) => {
    try {
      return await renderer(Object.freeze({ ...properties }), context);
    } catch (error) {
      throw new SsrError(`Component ${name} failed: ${error?.message ?? error}`, { code: 'KR-SSR-0202', cause: error });
    }
  };
  Object.defineProperty(wrapped, 'displayName', { value: name });
  return wrapped;
}

export async function render(componentValue, properties = {}, context = {}) {
  const result = typeof componentValue === 'function' ? await componentValue(properties, context) : componentValue;
  return renderValue(await resolveDeep(result));
}

export async function renderDocument(options = {}) {
  const lang = options.lang ?? 'en';
  const title = options.title ?? 'Kura application';
  const description = options.description ?? null;
  const head = await render(options.head ?? '');
  const body = await render(options.body ?? '');
  const state = options.state === undefined ? '' : `<script type="application/json" id="${escapeAttribute(options.stateId ?? '__KURA_STATE__')}">${serializeState(options.state)}</script>`;
  const scripts = (options.scripts ?? []).map(script => scriptTag(script)).join('');
  const styles = (options.styles ?? []).map(stylesheetTag).join('');
  const nonce = options.nonce ? ` nonce="${escapeAttribute(options.nonce)}"` : '';
  const hydration = options.hydrate ? `<script type="module"${nonce}>import { hydrate } from ${JSON.stringify(options.hydrate.module)};hydrate(${JSON.stringify(options.hydrate.export ?? 'default')},${JSON.stringify(options.stateId ?? '__KURA_STATE__')});</script>` : '';
  return `<!doctype html>
<html lang="${escapeAttribute(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${description ? `<meta name="description" content="${escapeAttribute(description)}">` : ''}
${styles}${head}
</head>
<body${attrs(options.bodyAttributes ?? {}).value}>
${body}${state}${scripts}${hydration}
</body>
</html>`;
}

export function serializeState(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return { __kuraType: 'bigint', value: item.toString() };
    if (item instanceof Date) return { __kuraType: 'date', value: item.toISOString() };
    if (item instanceof Map) return { __kuraType: 'map', value: [...item.entries()] };
    if (item instanceof Set) return { __kuraType: 'set', value: [...item] };
    return item;
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function parseState(text) {
  return JSON.parse(String(text), (_key, item) => {
    if (!item || typeof item !== 'object' || !item.__kuraType) return item;
    if (item.__kuraType === 'bigint') return BigInt(item.value);
    if (item.__kuraType === 'date') return new Date(item.value);
    if (item.__kuraType === 'map') return new Map(item.value);
    if (item.__kuraType === 'set') return new Set(item.value);
    return item;
  });
}

export function stream(componentValue, properties = {}, context = {}) {
  const iterator = async function* () {
    const result = typeof componentValue === 'function' ? await componentValue(properties, context) : componentValue;
    yield* streamValue(result);
  };
  return Readable.from(iterator());
}

export function ssrHandler(renderer, options = {}) {
  if (typeof renderer !== 'function') throw new SsrError('ssrHandler expects a renderer function.', { code: 'KR-SSR-0301' });
  return async context => {
    const result = await renderer(context);
    const document = options.document === false
      ? await render(result, {}, context)
      : await renderDocument({ ...options, ...(result?.document ?? {}), body: result?.body ?? result, state: result?.state ?? options.state });
    const etag = `"${createHash('sha256').update(document).digest('base64url')}"`;
    const requestEtag = context.request?.headers?.['if-none-match'] ?? context.request?.headers?.get?.('if-none-match');
    if (requestEtag === etag) return { status: 304, headers: { etag, 'cache-control': options.cacheControl ?? 'no-cache' }, body: '' };
    return {
      status: result?.status ?? 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': options.cacheControl ?? 'no-cache',
        etag,
        ...(result?.headers ?? {}),
      },
      body: document,
    };
  };
}

export function createRouter(options = {}) {
  const routes = [];
  const notFound = options.notFound ?? (() => html`<main><h1>Not found</h1></main>`);
  return Object.freeze({
    route(pattern, renderer, routeOptions = {}) {
      const compiled = compileRoute(pattern);
      routes.push({ compiled, renderer, options: routeOptions });
      return this;
    },
    async render(pathname, context = {}) {
      for (const route of routes) {
        const match = route.compiled.regex.exec(pathname);
        if (!match) continue;
        const params = Object.fromEntries(route.compiled.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
        return route.renderer({ ...context, params, route: route.options });
      }
      return notFound(context);
    },
    routes() { return routes.map(route => ({ pattern: route.compiled.pattern, options: { ...route.options } })); },
  });
}

export async function generateStaticSite(options = {}) {
  if (process.env.KURA_SECURITY_MODE === 'strict') throw new SsrError('Strict security mode blocks static-site filesystem output.', { code: 'KR-SSR-STRICT-0001' });
  const outDir = path.resolve(options.outDir ?? 'dist');
  const routes = options.routes ?? [];
  const written = [];
  await mkdir(outDir, { recursive: true });
  for (const route of routes) {
    const pathname = normalizeStaticPath(route.path ?? route);
    const result = await options.render(pathname, route);
    const document = typeof result === 'string' && /^<!doctype/i.test(result) ? result : await renderDocument({ ...options.document, body: result?.body ?? result, state: result?.state });
    const destination = pathname === '/' ? path.join(outDir, 'index.html') : path.join(outDir, pathname.replace(/^\//, ''), 'index.html');
    if (!destination.startsWith(outDir + path.sep) && destination !== path.join(outDir, 'index.html')) throw new SsrError('Static route escaped output directory.', { code: 'KR-SSR-0401' });
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, document, 'utf8');
    written.push({ path: pathname, file: destination, bytes: Buffer.byteLength(document), sha256: createHash('sha256').update(document).digest('hex') });
  }
  return Object.freeze({ outDir, pages: Object.freeze(written) });
}

export function island(name, componentValue, properties = {}, options = {}) {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(String(name))) throw new SsrError('Island name is invalid.', { code: 'KR-SSR-0501' });
  const id = options.id ?? `kura-island-${createHash('sha256').update(`${name}:${JSON.stringify(properties)}`).digest('hex').slice(0, 12)}`;
  return component(async () => {
    const content = await render(componentValue, properties, options.context ?? {});
    const data = escapeAttribute(Buffer.from(serializeState(properties)).toString('base64url'));
    return raw(`<div id="${escapeAttribute(id)}" data-kura-island="${escapeAttribute(name)}" data-kura-props="${data}">${content}</div>`);
  }, { name: `Island(${name})` });
}

export function hydrationRuntime(options = {}) {
  const selector = options.selector ?? '[data-kura-island]';
  return `export async function hydrateIslands(registry){for(const node of document.querySelectorAll(${JSON.stringify(selector)})){const name=node.dataset.kuraIsland;const encoded=node.dataset.kuraProps||'';let props={};try{props=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))))}catch{}const loader=registry[name];if(!loader){console.warn('[Kura] missing island',name);continue}const module=await loader();const hydrate=module.hydrate||module.default;if(typeof hydrate==='function')await hydrate(node,props)}}`;
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value?.[RAW]) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (typeof value === 'object' && Symbol.iterator in value) return [...value].map(renderValue).join('');
  if (typeof value === 'boolean') return value ? 'true' : '';
  return escapeHtml(value);
}
async function resolveDeep(value) { if (value && typeof value.then === 'function') return resolveDeep(await value); if (Array.isArray(value)) return Promise.all(value.map(resolveDeep)); return value; }
async function* streamValue(value) { const resolved = await value; if (resolved === null || resolved === undefined || resolved === false) return; if (resolved?.[RAW]) { yield resolved.value; return; } if (Array.isArray(resolved) || (typeof resolved === 'object' && Symbol.iterator in resolved)) { for (const item of resolved) yield* streamValue(item); return; } if (typeof resolved === 'object' && Symbol.asyncIterator in resolved) { for await (const item of resolved) yield* streamValue(item); return; } yield escapeHtml(resolved); }
function scriptTag(value) { if (typeof value === 'string') return `<script type="module" src="${escapeAttribute(value)}"></script>`; return `<script${attrs({ type: value.type ?? 'module', src: value.src, defer: value.defer, async: value.async, nonce: value.nonce, integrity: value.integrity, crossorigin: value.crossorigin }).value}>${value.content ? String(value.content).replace(/<\/script/gi, '<\\/script') : ''}</script>`; }
function stylesheetTag(value) { if (typeof value === 'string') return `<link rel="stylesheet" href="${escapeAttribute(value)}">`; return `<link${attrs({ rel: 'stylesheet', href: value.href, media: value.media, integrity: value.integrity, crossorigin: value.crossorigin }).value}>`; }
function toKebabCase(value) { return String(value).replace(/[A-Z]/g, match => `-${match.toLowerCase()}`); }
function compileRoute(pattern) { const normalized = String(pattern).startsWith('/') ? String(pattern) : `/${pattern}`; const names = []; const source = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_full, name) => { names.push(name); return '([^/]+)'; }).replace(/\\\*([A-Za-z_][A-Za-z0-9_]*)/g, (_full, name) => { names.push(name); return '(.*)'; }); return { pattern: normalized, names, regex: new RegExp(`^${source}/?$`) }; }
function normalizeStaticPath(value) { let output = String(value); if (!output.startsWith('/')) output = `/${output}`; if (output.includes('..') || output.includes('\\') || /[\0-\x1f]/.test(output)) throw new SsrError(`Unsafe static path '${value}'.`, { code: 'KR-SSR-0402' }); return output.replace(/\/+/g, '/'); }
