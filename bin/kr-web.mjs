#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildBrowserApp, previewBrowserBuild, KuraWebBuildError } from '../lib/web-builder.mjs';
import { createDatabase, loadMigrations, migrate, rollback } from '../lib/web-database.mjs';
import { generateDeployment, deploymentDoctor } from '../lib/web-deploy.mjs';
import { loadE2EConfig, runBrowserChecks } from '../lib/web-e2e.mjs';

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
  else if (command === 'db') await databaseCommand(args);
  else if (command === 'deploy') await deployCommand(args);
  else if (command === 'doctor') await doctorCommand(args);
  else if (command === 'e2e' || command === 'test') await e2eCommand(args);
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
  db <action>       Create, inspect, apply, or rollback SQL migrations
  deploy <target>   Generate Docker, Render, Fly, Railway, or systemd files
  doctor            Check Web production readiness
  e2e               Run Playwright browser checks against a preview build
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
  --url <database-url>  Override DATABASE_URL for db commands
  --driver <name>       postgres, mysql, sqlite, turso, or memory
  --migrations <dir>    Migration directory (default: migrations)
  --force               Overwrite generated deployment files
  --bundle              Bundle browser npm packages with project esbuild
  --sourcemap           Emit browser source maps
  --no-splitting        Disable dynamic chunk splitting
  --browser <name>      chromium, firefox, or webkit for E2E
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
    bundle: argv.includes('--bundle'),
    sourcemap: argv.includes('--sourcemap') || argv.includes('--bundle'),
    splitting: !argv.includes('--no-splitting'),
    minify: !argv.includes('--no-minify'),
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


async function databaseCommand(argv) {
  const action = argv[0] ?? 'status';
  const projectRoot = path.resolve(process.cwd());
  const migrationsDir = path.resolve(projectRoot, option(argv, '--migrations', 'migrations'));
  if (action === 'create') {
    const name = argv.find((value, index) => index > 0 && !value.startsWith('-') && argv[index - 1] !== '--migrations') ?? 'migration';
    const safe = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'migration';
    await mkdir(migrationsDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const file = path.join(migrationsDir, `${stamp}-${safe}.sql`);
    if (await exists(file)) throw new KuraWebBuildError(`Migration already exists: ${file}`, { code: 'KR-WEB-DB-0001' });
    await writeFile(file, `-- up\n\n-- Write forward migration SQL here.\n\n-- down\n\n-- Write rollback SQL here.\n`, 'utf8');
    console.log(`Created migration ${path.relative(projectRoot, file)}`);
    return;
  }
  const url = option(argv, '--url', process.env.DATABASE_URL ?? '');
  const driver = option(argv, '--driver', undefined);
  if (!url && !driver) throw new KuraWebBuildError('DATABASE_URL or --url is required for database commands.', { code: 'KR-WEB-DB-0002', hint: 'Example: kr-web db status --url sqlite:./app.db' });
  const database = createDatabase({ url: url || undefined, driver, authToken: process.env.DATABASE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN });
  try {
    const migrations = await loadMigrations(migrationsDir);
    if (action === 'migrate') {
      const report = await migrate(database, migrations, { dryRun: argv.includes('--dry-run') });
      console.log(report.dryRun ? `Pending migrations (${report.pending.length})\n${report.pending.join('\n') || 'None'}` : `Applied ${report.applied.length} migration(s)\n${report.applied.join('\n') || 'Database is current.'}`);
    } else if (action === 'status') {
      const report = await migrate(database, migrations, { dryRun: true });
      console.log(`Database driver: ${database.driver}\nMigration files: ${migrations.length}\nPending: ${report.pending.length}\n${report.pending.join('\n') || 'Database is current.'}`);
    } else if (action === 'rollback') {
      const steps = Math.max(1, Number(option(argv, '--steps', '1')) || 1);
      const report = await rollback(database, migrations, { steps });
      console.log(`Rolled back ${report.rolledBack.length} migration(s)\n${report.rolledBack.join('\n') || 'Nothing to roll back.'}`);
    } else {
      throw new KuraWebBuildError(`Unknown db action '${action}'.`, { code: 'KR-WEB-DB-0003', hint: 'Use create, status, migrate, or rollback.' });
    }
  } finally {
    await database.close();
  }
}

async function deployCommand(argv) {
  const target = argv[0] ?? 'docker';
  const report = await generateDeployment({
    projectRoot: process.cwd(),
    target,
    name: option(argv, '--name', path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, '-')),
    port: Number(option(argv, '--port', process.env.PORT ?? '3000')),
    startCommand: option(argv, '--start-command', 'kr run --timeout-ms 0'),
    healthPath: option(argv, '--health-path', '/health'),
    nodeVersion: option(argv, '--node-version', '22'),
    region: option(argv, '--region', 'nrt'),
    force: argv.includes('--force'),
  });
  console.log(`Generated ${report.target} deployment\n${report.files.map(item => `  ${item.file}  ${item.bytes} bytes`).join('\n')}`);
}

async function doctorCommand(argv) {
  const requiredEnv = String(option(argv, '--required-env', '--config', '--browser', '--timeout-ms', '--screenshots', '')).split(',').map(value => value.trim()).filter(Boolean);
  const report = await deploymentDoctor({ projectRoot: process.cwd(), requiredEnv, allowEnvFiles: argv.includes('--allow-env-files') });
  for (const item of report.findings) console.log(`${item.severity.toUpperCase()} ${item.code} ${item.message}`);
  console.log(`\nKura Web doctor: ${report.ok ? 'ready' : 'not ready'} (${report.errors} errors, ${report.warnings} warnings)`);
  if (!report.ok) process.exitCode = 1;
}


async function e2eCommand(argv) {
  const projectRoot = path.resolve(process.cwd());
  const config = await readWebConfig(projectRoot);
  const root = path.resolve(projectRoot, option(argv, '--out-dir', config.outDir ?? 'dist'));
  const previewServer = await previewBrowserBuild({ root, host: option(argv, '--host', '127.0.0.1'), port: numberOption(argv, '--port', 0), spa: !argv.includes('--no-spa') });
  try {
    const e2e = await loadE2EConfig(path.resolve(projectRoot, option(argv, '--config', 'kura-e2e.json')));
    const report = await runBrowserChecks({
      projectRoot,
      baseUrl: previewServer.url,
      browser: option(argv, '--browser', e2e.browser ?? 'chromium'),
      checks: e2e.checks,
      headless: !argv.includes('--headed'),
      timeoutMs: Number(option(argv, '--timeout-ms', e2e.timeoutMs ?? '30000')),
      failFast: argv.includes('--fail-fast'),
      screenshotDir: option(argv, '--screenshots', undefined),
    });
    for (const result of report.results) console.log(`${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.name} (${result.durationMs.toFixed(1)} ms)${result.error ? ` — ${result.error}` : ''}`);
    console.log(`\nE2E: ${report.passed} passed, ${report.failed} failed in ${report.browser}.`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await previewServer.close();
  }
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

function firstValue(argv) { const valueOptions = new Set(['--type', '--public-dir', '--out-dir', '--host', '--port', '--url', '--driver', '--migrations', '--steps', '--name', '--start-command', '--health-path', '--node-version', '--region', '--required-env', '--config', '--browser', '--timeout-ms', '--screenshots']); return argv.find((value, index) => !value.startsWith('-') && (index === 0 || !valueOptions.has(argv[index - 1]))); }
function hasOption(argv, name) { return argv.includes(name); }
function option(argv, name, fallback = undefined) { const index = argv.indexOf(name); if (index < 0) return fallback; const value = argv[index + 1]; if (!value || value.startsWith('--')) throw new KuraWebBuildError(`${name} needs a value.`, { code: 'KR-WEB-CLI-0030' }); return value; }
function numberOption(argv, name, fallback) { const value = Number(option(argv, name, fallback)); if (!Number.isInteger(value) || value < 0 || value > 65535) throw new KuraWebBuildError(`${name} must be from 0 to 65535.`, { code: 'KR-WEB-CLI-0031' }); return value; }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function writeJson(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function waitForSignals(close) { await new Promise(resolve => { let closing = false; const stop = async () => { if (closing) return; closing = true; process.off('SIGINT', stop); process.off('SIGTERM', stop); await close(); resolve(); }; process.on('SIGINT', stop); process.on('SIGTERM', stop); }); }

const browserSource = `import { ready, on, setText, signal } from std:"browser";\n\nlet count = signal(0);\n\nfn render(value, previous) {\n  setText("#count", value);\n}\n\nfn increment(event) {\n  count.set(count.get() + 1);\n}\n\nasync fn main() {\n  await ready();\n  count.subscribe(render);\n  on("#increment", "click", increment);\n}\n`;
const apiSource = `import { createApp, object, json, securityHeaders, cors } from std:"web";\nimport { getEnv } from std:"env";\n\nfn health(context) {\n  return json(object("status", "ok", "requestId", context.requestId));\n}\n\nasync fn main() {\n  let app = createApp();\n  app.use(securityHeaders());\n  app.use(cors());\n  app.get("/health", health);\n  let port = int(getEnv("PORT", "3000"));\n  await app.listen(port, "0.0.0.0");\n}\n`;
function browserHtml(name) { return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${name}</title>\n  <style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#171717}main{padding:32px;border:1px solid #ddd;background:#fff}output{display:block;font-size:56px;margin:24px 0}button{padding:10px 16px}</style>\n</head>\n<body>\n  <main>\n    <h1>${name}</h1>\n    <output id="count">0</output>\n    <button id="increment" type="button">Increase</button>\n  </main>\n</body>\n</html>\n`; }
