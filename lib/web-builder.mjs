// SPDX-License-Identifier: MIT OR Apache-2.0
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { compile } from './compiler.mjs';

const BROWSER_SAFE_STD = new Set(['browser']);
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_FILES = 10_000;
const MIME = new Map([
  ['.avif', 'image/avif'], ['.css', 'text/css; charset=utf-8'], ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'], ['.ico', 'image/x-icon'], ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.mp3', 'audio/mpeg'], ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'], ['.otf', 'font/otf'], ['.pdf', 'application/pdf'], ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'], ['.txt', 'text/plain; charset=utf-8'], ['.wasm', 'application/wasm'],
  ['.webm', 'video/webm'], ['.webp', 'image/webp'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);

export class KuraWebBuildError extends Error {
  constructor(message, options = {}) {
    super(String(message), { cause: options.cause });
    this.name = 'KuraWebBuildError';
    this.code = options.code ?? 'KR-WEB-BUILD-0001';
    this.file = options.file ?? null;
    this.hint = options.hint ?? null;
    this.details = options.details ?? null;
  }
}

export async function buildBrowserApp(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const entryFile = path.resolve(projectRoot, options.entryFile ?? 'src/main.kr');
  const publicRoot = path.resolve(projectRoot, options.publicDir ?? 'public');
  const outDir = path.resolve(projectRoot, options.outDir ?? 'dist');
  const stdlibRoot = path.resolve(options.stdlibRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'std'));
  assertInside(entryFile, projectRoot, 'entry file');
  assertInside(outDir, projectRoot, 'output directory');
  if (outDir === projectRoot) throw new KuraWebBuildError('The browser output directory cannot be the project root.', { code: 'KR-WEB-BUILD-0002' });
  const entryInfo = await lstat(entryFile).catch(() => null);
  if (!entryInfo?.isFile() || entryInfo.isSymbolicLink()) {
    throw new KuraWebBuildError(`Browser entry file not found: ${entryFile}`, { code: 'KR-WEB-BUILD-0003', file: entryFile });
  }

  const source = await readFile(entryFile, 'utf8');
  const output = options.compile
    ? await options.compile(source, { file: entryFile, target: 'browser', autoRun: true, stdlibRoot })
    : compile(source, {
      file: entryFile,
      target: 'browser',
      autoRun: true,
      stdlibRoot,
      optimize: options.optimize !== false,
      compact: options.compact !== false,
      securityMode: options.securityMode ?? 'standard',
    });
  const rawCode = typeof output === 'string' ? output : output.code;
  const rewritten = rewriteBrowserImports(rawCode, { stdlibRoot, appImportPrefix: '../_kura/std/' });
  validateBrowserImports(rewritten.code, entryFile);
  const hash = sha256(rewritten.code).slice(0, 16);
  const appName = `app-${hash}.mjs`;

  if (options.clean !== false) await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, 'assets'), { recursive: true });
  await mkdir(path.join(outDir, '_kura', 'std'), { recursive: true });

  await writeFile(path.join(outDir, 'assets', appName), rewritten.code, 'utf8');
  const standardModules = [];
  for (const moduleName of rewritten.standardModules) {
    if (!BROWSER_SAFE_STD.has(moduleName)) {
      throw new KuraWebBuildError(`std:${moduleName} is not available in browser builds.`, {
        code: 'KR-WEB-BUILD-0004', file: entryFile,
        hint: 'Use std:browser and browser platform APIs. Node-only modules belong in the server application.',
      });
    }
    const sourceFile = path.join(stdlibRoot, `${moduleName}.mjs`);
    const destination = path.join(outDir, '_kura', 'std', `${moduleName}.mjs`);
    const moduleSource = await readFile(sourceFile, 'utf8');
    validateBrowserImports(moduleSource, sourceFile, { allowRelative: true });
    await writeFile(destination, moduleSource, 'utf8');
    standardModules.push({ name: moduleName, file: `_kura/std/${moduleName}.mjs`, sha256: sha256(moduleSource) });
  }

  let publicFiles = [];
  if (await isDirectory(publicRoot)) publicFiles = await copyPublicTree(publicRoot, outDir);
  const indexFile = path.join(outDir, 'index.html');
  let html = await readFile(indexFile, 'utf8').catch(() => defaultIndex(options.title ?? 'Kura Web'));
  html = injectApplication(html, `/assets/${appName}`);
  await writeFile(indexFile, html, 'utf8');

  const files = await collectFiles(outDir);
  const manifest = {
    format: 1,
    target: 'browser',
    entry: path.relative(projectRoot, entryFile).replaceAll('\\', '/'),
    application: `assets/${appName}`,
    applicationSha256: sha256(rewritten.code),
    standardModules,
    publicFiles,
    files: files.map(file => ({ path: file.relative, bytes: file.bytes, sha256: file.sha256 })),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  await writeFile(path.join(outDir, 'kura-web-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { projectRoot, entryFile, publicRoot, outDir, appName, manifest, files: files.length + 1 };
}

export function rewriteBrowserImports(code, options = {}) {
  const stdlibRoot = path.resolve(options.stdlibRoot);
  const appImportPrefix = options.appImportPrefix ?? './_kura/std/';
  const standardModules = new Set();
  const rewritten = String(code).replace(/(["'])(file:\/\/\/[^"']+)\1/g, (full, quote, url) => {
    let file;
    try { file = path.resolve(fileURLToPath(url)); } catch { return full; }
    if (!inside(file, stdlibRoot)) return full;
    const name = path.basename(file, '.mjs');
    standardModules.add(name);
    return `${quote}${appImportPrefix}${name}.mjs${quote}`;
  });
  return { code: rewritten, standardModules: [...standardModules].sort() };
}

export function validateBrowserImports(code, file = '<browser-output>', options = {}) {
  const imports = extractImports(code);
  for (const specifier of imports) {
    if (specifier.startsWith('node:')) throw new KuraWebBuildError(`Node.js module '${specifier}' cannot run in a browser.`, { code: 'KR-WEB-BUILD-0010', file });
    if (specifier.startsWith('file:')) throw new KuraWebBuildError(`Local file URL '${specifier}' cannot be published in a browser build.`, { code: 'KR-WEB-BUILD-0011', file });
    if (/^(?:https?|data|javascript):/i.test(specifier)) throw new KuraWebBuildError(`Remote or executable import '${specifier}' is blocked.`, { code: 'KR-WEB-BUILD-0012', file });
    if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
      throw new KuraWebBuildError(`Bare package import '${specifier}' requires a browser bundler adapter.`, {
        code: 'KR-WEB-BUILD-0013', file, hint: 'Use std:browser or a local browser ESM module for this build.',
      });
    }
    if (!options.allowRelative && (specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.includes('_kura/std/')) {
      throw new KuraWebBuildError(`Relative module '${specifier}' is not part of the generated browser artifact.`, {
        code: 'KR-WEB-BUILD-0014', file, hint: 'Move browser assets into public/, or compile the dependency into the Kura entry module.',
      });
    }
  }
  return imports;
}

export async function previewBrowserBuild(options = {}) {
  const root = path.resolve(options.root ?? options.outDir ?? 'dist');
  const host = String(options.host ?? '127.0.0.1');
  const port = normalizePort(options.port ?? 4173);
  if (!(await isDirectory(root))) throw new KuraWebBuildError(`Browser build directory not found: ${root}`, { code: 'KR-WEB-PREVIEW-0001', file: root });
  const server = http.createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) return send(response, 405, 'Method Not Allowed', 'text/plain; charset=utf-8', { allow: 'GET, HEAD' });
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      let relative;
      try { relative = decodeURIComponent(url.pathname).replaceAll('\\', '/'); }
      catch { return send(response, 400, 'Invalid URL encoding'); }
      const candidate = path.resolve(root, `.${relative}`);
      if (!inside(candidate, root)) return send(response, 403, 'Forbidden');
      let file = candidate;
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) { file = path.join(file, 'index.html'); info = await stat(file).catch(() => null); }
      if (!info?.isFile() && options.spa !== false) { file = path.join(root, 'index.html'); info = await stat(file).catch(() => null); }
      if (!info?.isFile()) return send(response, 404, 'Not Found');
      if (info.size > MAX_ASSET_BYTES) return send(response, 413, 'Asset Too Large');
      const body = request.method === 'HEAD' ? Buffer.alloc(0) : await readFile(file);
      response.writeHead(200, {
        'content-type': MIME.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
        'content-length': String(request.method === 'HEAD' ? info.size : body.length),
        'cache-control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=3600',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      });
      response.end(body);
    } catch (error) { send(response, 500, options.exposeErrors ? String(error?.stack ?? error) : 'Internal Server Error'); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server, root, host, port: actualPort, url: `http://${formatHost(host)}:${actualPort}/`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function copyPublicTree(sourceRoot, outputRoot) {
  const copied = [];
  let count = 0;
  async function visit(directory, relativeRoot) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      const relative = path.join(relativeRoot, entry.name);
      const destination = path.join(outputRoot, relative);
      if (entry.isSymbolicLink()) throw new KuraWebBuildError(`Public assets may not contain symbolic links: ${source}`, { code: 'KR-WEB-BUILD-0020', file: source });
      if (entry.isDirectory()) { await mkdir(destination, { recursive: true }); await visit(source, relative); continue; }
      if (!entry.isFile()) continue;
      count += 1;
      if (count > MAX_ASSET_FILES) throw new KuraWebBuildError(`Public assets exceed ${MAX_ASSET_FILES} files.`, { code: 'KR-WEB-BUILD-0021', file: sourceRoot });
      const info = await stat(source);
      if (info.size > MAX_ASSET_BYTES) throw new KuraWebBuildError(`Public asset exceeds ${MAX_ASSET_BYTES} bytes: ${source}`, { code: 'KR-WEB-BUILD-0022', file: source });
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { force: true, preserveTimestamps: true });
      copied.push(relative.replaceAll('\\', '/'));
    }
  }
  await visit(sourceRoot, '');
  return copied.sort();
}

async function collectFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const data = await readFile(file);
        files.push({ relative: path.relative(root, file).replaceAll('\\', '/'), bytes: data.length, sha256: sha256(data) });
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function extractImports(code) {
  const output = new Set();
  const source = String(code);
  const patterns = [/(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g, /import\s*\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) output.add(match[1]);
  return [...output];
}
function injectApplication(html, source) { const script = `<script type="module" src="${source}"></script>`; if (String(html).includes(source)) return String(html); return /<\/body>/i.test(html) ? String(html).replace(/<\/body>/i, `${script}</body>`) : `${html}\n${script}\n`; }
function defaultIndex(title) { return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${escapeHtml(title)}</title>\n</head>\n<body>\n  <main id="app"></main>\n</body>\n</html>\n`; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function assertInside(candidate, root, label) { if (!inside(candidate, root)) throw new KuraWebBuildError(`The ${label} resolves outside the project root.`, { code: 'KR-WEB-BUILD-0030', file: candidate }); }
function inside(candidate, root) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
async function isDirectory(file) { try { return (await stat(file)).isDirectory(); } catch { return false; } }
function normalizePort(value) { const port = Number(value); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Port must be from 0 to 65535'); return port; }
function formatHost(host) { return host.includes(':') ? `[${host}]` : host; }
function send(response, status, body, type = 'text/plain; charset=utf-8', extra = {}) { const payload = Buffer.from(String(body)); response.writeHead(status, { 'content-type': type, 'content-length': String(payload.length), 'x-content-type-options': 'nosniff', ...extra }); response.end(payload); }
