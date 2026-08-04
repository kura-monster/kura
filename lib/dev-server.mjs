// SPDX-License-Identifier: MIT OR Apache-2.0
import http from 'node:http';
import { watch } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'], ['.wasm', 'application/wasm'],
]);
const IGNORE_PARTS = new Set(['.git', '.kura', 'build', 'node_modules']);
const MAX_STATIC_BYTES = 64 * 1024 * 1024;

export async function startDevServer(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const publicRoot = path.resolve(projectRoot, options.publicDir ?? 'public');
  const host = options.host ?? '127.0.0.1';
  const requestedPort = Number(options.port ?? 5173);
  const browserMode = Boolean(options.browser);
  const clients = new Set();
  const state = {
    generation: 0,
    building: false,
    pending: false,
    lastBuildMs: 0,
    lastError: null,
    appCode: '',
    child: null,
    stopping: false,
  };

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, { projectRoot, publicRoot, browserMode, clients, state, options });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  const url = `http://${formatHost(host)}:${port}/`;

  const rebuild = async reason => {
    if (state.stopping) return;
    if (state.building) { state.pending = true; return; }
    state.building = true;
    const started = performance.now();
    try {
      const output = await options.compile({ browser: browserMode });
      state.appCode = browserMode ? rewriteBrowserImports(output.code, options) : output.code;
      state.lastError = null;
      state.generation++;
      state.lastBuildMs = performance.now() - started;
      if (!browserMode) await restartChild(state, options);
      broadcast(clients, 'reload', { generation: state.generation, reason, buildMs: state.lastBuildMs });
      options.onLog?.(`Ready in ${state.lastBuildMs.toFixed(1)} ms${reason ? ` (${reason})` : ''}.`);
    } catch (error) {
      state.lastError = serializeError(error);
      state.lastBuildMs = performance.now() - started;
      broadcast(clients, 'error', state.lastError);
      options.onError?.(error);
    } finally {
      state.building = false;
      if (state.pending) { state.pending = false; queueMicrotask(() => void rebuild('queued change')); }
    }
  };

  await rebuild('initial build');

  let debounce = null;
  const watcher = watch(projectRoot, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const normalized = String(filename).replaceAll('\\', '/');
    if (normalized.split('/').some(part => IGNORE_PARTS.has(part))) return;
    if (!/\.(?:kr|json|mjs|js|css|html|svg|png|jpe?g|gif|webp|ico|txt)$/i.test(normalized)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => void rebuild(normalized), Number(options.debounceMs ?? 80));
  });
  watcher.on('error', error => options.onError?.(error));

  if (options.open) openBrowser(url);

  const close = async () => {
    if (state.stopping) return;
    state.stopping = true;
    clearTimeout(debounce);
    watcher.close();
    for (const client of clients) client.end();
    clients.clear();
    await stopChild(state.child);
    await new Promise(resolve => server.close(resolve));
  };

  return Object.freeze({ url, port, host, browser: browserMode, state, rebuild, close });
}

async function handleRequest(request, response, context) {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname.length > 4_096) return send(response, 414, 'text/plain; charset=utf-8', 'URI too long');
    if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) return send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed', { allow: 'GET, HEAD' });

    if (url.pathname === '/@kura/events') {
      response.writeHead(200, secureHeaders({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      }));
      response.write(`event: connected\ndata: ${JSON.stringify({ generation: context.state.generation })}\n\n`);
      context.clients.add(response);
      request.on('close', () => context.clients.delete(response));
      return;
    }
    if (url.pathname === '/@kura/status') {
      return sendJson(response, 200, {
        generation: context.state.generation,
        building: context.state.building,
        buildMs: context.state.lastBuildMs,
        error: context.state.lastError,
        mode: context.browserMode ? 'browser' : 'node',
      });
    }
    if (url.pathname === '/@kura/app.mjs') {
      if (!context.browserMode) return send(response, 404, 'text/plain; charset=utf-8', 'Browser mode is not enabled.');
      if (context.state.lastError) return send(response, 503, 'text/javascript; charset=utf-8', `throw new Error(${JSON.stringify(context.state.lastError.message)});`);
      return send(response, 200, 'text/javascript; charset=utf-8', context.state.appCode, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/@kura/ai.mjs' || url.pathname === '/@kura/lib/ai.mjs') {
      const file = path.resolve(context.options.aiRuntime);
      return serveFile(response, file, false);
    }
    if (url.pathname.startsWith('/@kura/std/')) {
      const name = url.pathname.slice('/@kura/std/'.length);
      if (!/^[a-z][a-z0-9-]*\.mjs$/.test(name)) return send(response, 400, 'text/plain; charset=utf-8', 'Invalid standard-library module.');
      const file = path.resolve(context.options.stdlibRoot, name);
      if (!inside(file, context.options.stdlibRoot)) return send(response, 403, 'text/plain; charset=utf-8', 'Forbidden');
      return serveFile(response, file, false);
    }

    const hasPublic = await isDirectory(context.publicRoot);
    if (hasPublic) {
      const relative = decodeSafePath(url.pathname);
      let file = path.resolve(context.publicRoot, `.${relative}`);
      if (!inside(file, context.publicRoot)) return send(response, 403, 'text/plain; charset=utf-8', 'Forbidden');
      if (await isDirectory(file)) file = path.join(file, 'index.html');
      if (await isFile(file)) {
        if (path.extname(file).toLowerCase() === '.html') {
          let html = await readFile(file, 'utf8');
          html = injectReload(html, context.browserMode);
          return send(response, 200, 'text/html; charset=utf-8', html, { 'cache-control': 'no-store' });
        }
        return serveFile(response, file, request.method === 'HEAD');
      }
    }

    if (url.pathname === '/') return send(response, 200, 'text/html; charset=utf-8', statusPage(context), { 'cache-control': 'no-store' });
    return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
  } catch (error) {
    return send(response, 500, 'application/json; charset=utf-8', JSON.stringify({ error: String(error?.message ?? error) }));
  }
}

async function restartChild(state, options) {
  await stopChild(state.child);
  const file = options.outputFile;
  await options.writeOutput(file, state.appCode);
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), file], {
    cwd: options.projectRoot,
    env: options.env ?? process.env,
    stdio: ['inherit', 'inherit', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.once('exit', code => {
    if (!state.stopping && state.child === child && code && code !== 0) options.onLog?.(`Application exited with code ${code}. Waiting for changes.`);
  });
  state.child = child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise(resolve => child.once('exit', resolve));
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1_500))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function rewriteBrowserImports(code, options) {
  let output = String(code);
  const stdRoot = path.resolve(options.stdlibRoot);
  const aiRuntime = path.resolve(options.aiRuntime);
  output = output.replace(/(["'])file:\/\/\/([^"']+)\1/g, (full, quote, pathname) => {
    let absolute;
    try { absolute = path.resolve(fileURLToPath(`file:///${pathname}`)); } catch { return full; }
    if (inside(absolute, stdRoot)) return `${quote}/@kura/std/${path.basename(absolute)}${quote}`;
    if (absolute === aiRuntime) return `${quote}/@kura/ai.mjs${quote}`;
    return full;
  });
  return output;
}

function injectReload(html, browserMode) {
  const app = browserMode && !/\/@kura\/app\.mjs/.test(html) ? '<script type="module" src="/@kura/app.mjs"></script>' : '';
  const client = `<script>(()=>{const e=new EventSource('/@kura/events');e.addEventListener('reload',()=>location.reload());e.addEventListener('error',event=>{try{const d=JSON.parse(event.data);console.error('[Kura dev]',d.message)}catch{}})})();</script>`;
  const addition = `${app}${client}`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${addition}</body>`) : `${html}${addition}`;
}

function statusPage(context) {
  const error = context.state.lastError;
  const details = error ? `<pre>${escapeHtml(error.message)}\n${escapeHtml(error.hint ?? '')}</pre>` : '<p class="ok">Build successful. Waiting for changes.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kura Dev</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#fafafa;color:#171717}main{max-width:760px;margin:8vh auto;padding:32px}h1{font-size:28px}code,pre{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;border:1px solid #ddd;background:#fff;padding:16px;border-radius:8px}.ok{border-left:3px solid #179c52;padding-left:12px}.meta{color:#666}</style></head><body><main><p class="meta">Kura v1 · ${context.browserMode ? 'Browser hot reload' : 'Node hot restart'}</p><h1>Development server</h1>${details}<p class="meta">Generation ${context.state.generation} · ${context.state.lastBuildMs.toFixed(1)} ms</p></main><script>(()=>{const e=new EventSource('/@kura/events');e.addEventListener('reload',()=>location.reload());e.addEventListener('error',()=>setTimeout(()=>location.reload(),500))})();</script></body></html>`;
}

async function serveFile(response, file, headOnly) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
  if (info.size > MAX_STATIC_BYTES) return send(response, 413, 'text/plain; charset=utf-8', 'File too large');
  const type = MIME.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
  const body = headOnly ? Buffer.alloc(0) : await readFile(file);
  response.writeHead(200, secureHeaders({
    'content-type': type,
    'content-length': String(headOnly ? info.size : body.length),
    'cache-control': 'no-cache',
  }));
  response.end(body);
}

function send(response, status, type, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(status, secureHeaders({ 'content-type': type, 'content-length': String(payload.length), ...headers }));
  response.end(payload);
}
function sendJson(response, status, value) { send(response, status, 'application/json; charset=utf-8', JSON.stringify(value)); }
function secureHeaders(extra = {}) { return { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin', ...extra }; }
function broadcast(clients, event, value) { const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`; for (const client of clients) client.write(payload); }
function serializeError(error) { return { message: String(error?.message ?? error), code: error?.code ?? 'KR-DEV-0001', hint: error?.hint ?? null, file: error?.file ?? null, line: error?.line ?? null, column: error?.column ?? null }; }
function formatHost(host) { return host.includes(':') ? `[${host}]` : host; }
function decodeSafePath(value) { try { return decodeURIComponent(value); } catch { return '/'; } }
function inside(candidate, root) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
async function isDirectory(file) { try { return (await stat(file)).isDirectory(); } catch { return false; } }
async function isFile(file) { try { return (await lstat(file)).isFile(); } catch { return false; } }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function openBrowser(url) { const command = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]; const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); }
