#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildBrowserApp, previewBrowserBuild, KuraWebBuildError } from '../lib/web-builder.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const command = args.shift() ?? 'help';

try {
  if (command === 'help' || command === '--help' || command === '-h') help();
  else if (command === 'version' || command === '--version' || command === '-V') console.log('Kura Web v1.0.0');
  else if (command === 'new') await createProject(firstValue(args), args);
  else if (command === 'build') await build(args);
  else if (command === 'preview') await preview(args);
  else if (command === 'dev') await dev(args);
  else throw new KuraWebBuildError(`Unknown kr-web command '${command}'.`, { code: 'KR-WEB-CLI-0001', hint: 'Run kr-web help.' });
} catch (error) {
  console.error(`Kura Web error [${error?.code ?? 'KR-WEB-CLI-0000'}]: ${error?.message ?? error}`);
  if (error?.hint) console.error(`Hint: ${error.hint}`);
  if (process.env.KURA_VERBOSE === '1' && error?.stack) console.error(error.stack);
  process.exitCode = 1;
}

function help() {
  console.log(`Kura Web v1.0.0

Usage: kr-web <command> [options]

  new <name>        Create a browser or API project
  dev [file]        Start browser hot reload through kr dev
  build [file]      Build a production browser artifact
  preview           Preview the production artifact
  version           Print the Web tool version

Options:
  --type browser|api|fullstack
  --public-dir <dir>   Public assets directory (default: public)
  --out-dir <dir>      Browser output directory (default: dist)
  --host <host>        Preview/development host
  --port <port>        Preview/development port
  --no-clean           Keep existing output files
  --no-optimize        Disable compiler optimization
  --open               Open the development page
`);
}

async function build(argv) {
  const projectRoot = path.resolve(process.cwd());
  const config = await readWebConfig(projectRoot);
  const entry = firstValue(argv) ?? config.entry ?? 'src/main.kr';
  const report = await buildBrowserApp({
    projectRoot,
    entryFile: entry,
    publicDir: option(argv, '--public-dir', config.publicDir ?? 'public'),
    outDir: option(argv, '--out-dir', config.outDir ?? 'dist'),
    stdlibRoot: path.join(packageRoot, 'std'),
    clean: !argv.includes('--no-clean'),
    optimize: !argv.includes('--no-optimize'),
    compact: !argv.includes('--no-optimize'),
    title: config.title ?? path.basename(projectRoot),
  });
  console.log(`Built Kura browser application\nOutput: ${path.relative(projectRoot, report.outDir) || report.outDir}\nApplication: ${report.manifest.application}\nFiles: ${report.manifest.files.length + 1}\nBytes: ${report.manifest.totalBytes}\nSHA-256: ${report.manifest.applicationSha256}`);
}

async function preview(argv) {
  const projectRoot = path.resolve(process.cwd());
  const config = await readWebConfig(projectRoot);
  const root = path.resolve(projectRoot, option(argv, '--out-dir', config.outDir ?? 'dist'));
  const server = await previewBrowserBuild({
    root,
    host: option(argv, '--host', '127.0.0.1'),
    port: numberOption(argv, '--port', 4173),
    spa: !argv.includes('--no-spa'),
    exposeErrors: argv.includes('--verbose'),
  });
  console.log(`Kura Web preview\nURL: ${server.url}\nRoot: ${root}\nPress Ctrl+C to stop.`);
  await waitForSignals(server.close);
}

async function dev(argv) {
  const projectRoot = path.resolve(process.cwd());
  const config = await readWebConfig(projectRoot);
  const entry = firstValue(argv) ?? config.entry ?? 'src/main.kr';
  const childArgs = [path.join(packageRoot, 'bin', 'kr.mjs'), 'dev', entry, '--browser', '--public-dir', option(argv, '--public-dir', config.publicDir ?? 'public')];
  if (hasOption(argv, '--host')) childArgs.push('--host', option(argv, '--host'));
  if (hasOption(argv, '--port')) childArgs.push('--port', option(argv, '--port'));
  if (argv.includes('--open')) childArgs.push('--open');
  if (argv.includes('--turbo')) childArgs.push('--turbo');
  const child = spawn(process.execPath, childArgs, { cwd: projectRoot, env: process.env, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', value => resolve(value ?? 1)); });
  process.exitCode = code;
}

async function createProject(name, argv) {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new KuraWebBuildError('Project name must use letters, numbers, dots, dashes, or underscores.', { code: 'KR-WEB-CLI-0010' });
  const type = option(argv, '--type', 'browser');
  if (!['browser', 'api', 'fullstack'].includes(type)) throw new KuraWebBuildError('--type must be browser, api, or fullstack.', { code: 'KR-WEB-CLI-0011' });
  const root = path.resolve(process.cwd(), name);
  if (await exists(root)) throw new KuraWebBuildError(`Path already exists: ${root}`, { code: 'KR-WEB-CLI-0012' });
  await mkdir(root, { recursive: false, mode: 0o700 });
  if (type === 'browser') await createBrowserProject(root, name);
  else if (type === 'api') await createApiProject(root, name);
  else await createFullstackProject(root, name);
  console.log(`Created ${type} project ${name}\nNext: cd ${name} && ${type === 'api' ? 'kr run --timeout-ms 0' : 'kr-web dev --open'}`);
}

async function createBrowserProject(root, name) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'public'), { recursive: true });
  await writeFile(path.join(root, 'src', 'main.kr'), browserSource, 'utf8');
  await writeFile(path.join(root, 'public', 'index.html'), browserHtml(name), 'utf8');
  await writeJson(path.join(root, 'kura.json'), { name, version: '0.1.0', entry: 'src/main.kr' });
  await writeJson(path.join(root, 'kura-web.json'), { entry: 'src/main.kr', publicDir: 'public', outDir: 'dist', title: name });
}

async function createApiProject(root, name) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'main.kr'), apiSource, 'utf8');
  await writeJson(path.join(root, 'kura.json'), { name, version: '0.1.0', entry: 'src/main.kr', target: 'node' });
}

async function createFullstackProject(root, name) {
  await mkdir(path.join(root, 'server'), { recursive: true });
  await mkdir(path.join(root, 'client'), { recursive: true });
  await mkdir(path.join(root, 'public'), { recursive: true });
  await writeFile(path.join(root, 'server', 'main.kr'), apiSource, 'utf8');
  await writeFile(path.join(root, 'client', 'main.kr'), browserSource, 'utf8');
  await writeFile(path.join(root, 'public', 'index.html'), browserHtml(name), 'utf8');
  await writeJson(path.join(root, 'kura.json'), { name, version: '0.1.0', entry: 'server/main.kr', target: 'node' });
  await writeJson(path.join(root, 'kura-web.json'), { entry: 'client/main.kr', publicDir: 'public', outDir: 'dist', title: name });
}

async function readWebConfig(root) {
  const file = path.join(root, 'kura-web.json');
  if (!(await exists(file))) return {};
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new KuraWebBuildError('kura-web.json is invalid JSON.', { code: 'KR-WEB-CLI-0020', file, cause: error }); }
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new KuraWebBuildError('kura-web.json must contain an object.', { code: 'KR-WEB-CLI-0021', file });
  const allowed = new Set(['entry', 'publicDir', 'outDir', 'title']);
  const unknown = Object.keys(config).filter(key => !allowed.has(key));
  if (unknown.length) throw new KuraWebBuildError(`Unknown kura-web.json settings: ${unknown.join(', ')}`, { code: 'KR-WEB-CLI-0022', file });
  return config;
}

function firstValue(argv) { const valueOptions = new Set(['--type', '--public-dir', '--out-dir', '--host', '--port']); return argv.find((value, index) => !value.startsWith('-') && (index === 0 || !valueOptions.has(argv[index - 1]))); }
function hasOption(argv, name) { return argv.includes(name); }
function option(argv, name, fallback = undefined) { const index = argv.indexOf(name); if (index < 0) return fallback; const value = argv[index + 1]; if (!value || value.startsWith('--')) throw new KuraWebBuildError(`${name} needs a value.`, { code: 'KR-WEB-CLI-0030' }); return value; }
function numberOption(argv, name, fallback) { const value = Number(option(argv, name, fallback)); if (!Number.isInteger(value) || value < 0 || value > 65535) throw new KuraWebBuildError(`${name} must be from 0 to 65535.`, { code: 'KR-WEB-CLI-0031' }); return value; }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function writeJson(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function waitForSignals(close) { await new Promise(resolve => { let closing = false; const stop = async () => { if (closing) return; closing = true; process.off('SIGINT', stop); process.off('SIGTERM', stop); await close(); resolve(); }; process.on('SIGINT', stop); process.on('SIGTERM', stop); }); }

const browserSource = `import { ready, on, setText, signal } from std:"browser";\n\nlet count = signal(0);\n\nfn render(value, previous) {\n  setText("#count", value);\n}\n\nfn increment(event) {\n  count.set(count.get() + 1);\n}\n\nasync fn main() {\n  await ready();\n  count.subscribe(render);\n  on("#increment", "click", increment);\n}\n`;
const apiSource = `import { createApp, object, json, securityHeaders, cors } from std:"web";\nimport { getEnv } from std:"env";\n\nfn health(context) {\n  return json(object("status", "ok", "requestId", context.requestId));\n}\n\nasync fn main() {\n  let app = createApp();\n  app.use(securityHeaders());\n  app.use(cors());\n  app.get("/health", health);\n  let port = int(getEnv("PORT", "3000"));\n  await app.listen(port, "0.0.0.0");\n}\n`;
function browserHtml(name) { return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${name}</title>\n  <style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#171717}main{padding:32px;border:1px solid #ddd;background:#fff}output{display:block;font-size:56px;margin:24px 0}button{padding:10px 16px}</style>\n</head>\n<body>\n  <main>\n    <h1>${name}</h1>\n    <output id="count">0</output>\n    <button id="increment" type="button">Increase</button>\n  </main>\n</body>\n</html>\n`; }
