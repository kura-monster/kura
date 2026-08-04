// SPDX-License-Identifier: MIT OR Apache-2.0
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const PROJECT_RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.wasm', '.txt', '.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);
const EXCLUDED = new Set(['.git', '.kura', 'build', 'node_modules', 'tests', '.env', '.env.local']);

export class KuraStandaloneError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'KuraStandaloneError';
    this.code = options.code ?? 'KR-STANDALONE-0001';
    this.title = options.title ?? 'Kura could not build the standalone executable';
    this.hint = options.hint ?? null;
    this.details = options.details ?? null;
  }
}

export async function buildStandalone(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const entryFile = path.resolve(options.entryFile);
  const packageRoot = path.resolve(options.packageRoot);
  const nodeBinary = path.resolve(options.nodeBinary ?? process.execPath);
  await assertSeaBuilder(nodeBinary);

  const output = normalizeOutputPath(options.outputPath, options.name ?? path.basename(projectRoot));
  if (!options.allowOutsideProject && !inside(output, projectRoot)) {
    throw new KuraStandaloneError('The standalone output must stay inside the project.', { code: 'KR-STANDALONE-0019', hint: 'Choose an output under build/, or pass --allow-outside-project after reviewing the destination.' });
  }
  const stageRoot = path.join(projectRoot, '.kura', 'standalone', `${Date.now()}-${process.pid}`);
  const appRoot = path.join(stageRoot, 'app');
  const relativeEntry = safeRelative(projectRoot, entryFile, 'entry file');
  const entryAsset = normalizeAssetPath(path.join('project', relativeEntry.replace(/\.kr$/i, '.mjs')));
  const entryOutput = path.join(appRoot, entryAsset);
  const assets = new Map();

  try {
    await mkdir(path.dirname(entryOutput), { recursive: true, mode: 0o700 });
    const compiled = await options.compile();
    const rewritten = rewriteNativeRuntimeImports(compiled.code, {
      entryAsset,
      stdlibRoot: path.resolve(options.stdlibRoot),
      aiRuntime: path.resolve(options.aiRuntime),
    });
    await addBufferAsset(assets, entryAsset, Buffer.from(rewritten), 0o600);

    await addDirectory(assets, path.resolve(options.stdlibRoot), 'std', { includeAll: true });
    await addFile(assets, path.resolve(options.aiRuntime), 'lib/ai.mjs');
    await addProjectRuntimeFiles(assets, projectRoot);

    const packageDirectory = path.join(projectRoot, 'node_modules');
    if (await isDirectory(packageDirectory)) await addDirectory(assets, packageDirectory, 'project/node_modules', { includeAll: true });

    for (const explicit of options.assets ?? []) {
      const absolute = path.resolve(projectRoot, explicit);
      const relative = safeRelative(projectRoot, absolute, 'standalone asset');
      if (await isDirectory(absolute)) await addDirectory(assets, absolute, normalizeAssetPath(path.join('project', relative)), { includeAll: true });
      else await addFile(assets, absolute, normalizeAssetPath(path.join('project', relative)));
    }

    enforceAssetLimits(assets);
    for (const [assetName, asset] of assets) {
      const file = path.join(appRoot, assetName);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, asset.content, { mode: asset.mode });
    }

    const manifest = [...assets.entries()].map(([name, asset]) => ({ name, sha256: sha256(asset.content), mode: asset.mode }));
    const appHash = sha256(Buffer.from(JSON.stringify(manifest)));
    const launcherPath = path.join(stageRoot, 'launcher.mjs');
    const launcher = createLauncher({ entryAsset, manifest, appHash });
    await writeFile(launcherPath, launcher, { mode: 0o600 });

    const seaConfigPath = path.join(stageRoot, 'sea-config.json');
    const assetConfig = {};
    for (const item of manifest) assetConfig[item.name] = path.join(appRoot, item.name);
    const seaConfig = {
      main: launcherPath,
      output,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgv: ['--no-warnings'],
      execArgvExtension: 'none',
      assets: assetConfig,
    };
    await writeFile(seaConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`, { mode: 0o600 });
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await assertNoSymlinkPath(path.dirname(output));
    if (await pathExists(output)) {
      const existing = await lstat(output);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new KuraStandaloneError('Refusing to replace a non-regular standalone output.', { code: 'KR-STANDALONE-0020' });
      await rm(output, { force: true });
    }

    const result = await run(nodeBinary, ['--build-sea', seaConfigPath], { cwd: stageRoot });
    if (result.code !== 0) {
      throw new KuraStandaloneError('Node.js failed to generate the single executable.', {
        code: 'KR-STANDALONE-0003',
        hint: 'Use Node.js 25.5 or newer on Windows, macOS, or glibc-based Linux, then rerun the command.',
        details: result.stderr || result.stdout,
      });
    }
    if (!(await isFile(output))) throw new KuraStandaloneError('Node.js reported success but no executable was created.', { code: 'KR-STANDALONE-0004' });
    if (process.platform !== 'win32') await chmod(output, 0o755);
    if (process.platform === 'darwin') {
      const signed = await run('codesign', ['--sign', '-', '--force', output]);
      if (signed.code !== 0) throw new KuraStandaloneError('macOS could not ad-hoc sign the standalone executable.', { code: 'KR-STANDALONE-0021', hint: 'Install the Xcode command-line tools and rerun the build.', details: signed.stderr });
    }
    const binary = await readFile(output);
    return Object.freeze({
      output,
      bytes: binary.length,
      sha256: sha256(binary),
      assets: assets.size,
      appBytes: [...assets.values()].reduce((sum, asset) => sum + asset.content.length, 0),
      node: await nodeVersion(nodeBinary),
      platform: process.platform,
      arch: process.arch,
    });
  } finally {
    if (!options.keepStage) await rm(stageRoot, { recursive: true, force: true });
  }
}

async function assertSeaBuilder(nodeBinary) {
  const version = await nodeVersion(nodeBinary);
  const [major, minor] = version.split('.').map(Number);
  if (major < 25 || (major === 25 && minor < 5)) {
    throw new KuraStandaloneError(`Node.js ${version} does not include the built-in SEA generator.`, {
      code: 'KR-STANDALONE-0002',
      title: 'Standalone builds need a newer Node.js builder',
      hint: 'Install Node.js 25.5 or newer (Node.js 26 recommended), or pass its executable with --node <path>. The generated program itself does not need Node.js installed.',
    });
  }
}

async function nodeVersion(nodeBinary) {
  const result = await run(nodeBinary, ['--version']);
  if (result.code !== 0) throw new KuraStandaloneError(`Could not run Node.js builder '${nodeBinary}'.`, { code: 'KR-STANDALONE-0005', details: result.stderr });
  return result.stdout.trim().replace(/^v/, '');
}

function normalizeOutputPath(value, projectName) {
  let output = path.resolve(value || path.join('build', sanitizeName(projectName)));
  if (process.platform === 'win32' && !output.toLowerCase().endsWith('.exe')) output += '.exe';
  return output;
}

function sanitizeName(value) {
  const name = String(value || 'kura-app').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'kura-app';
}

async function addProjectRuntimeFiles(assets, projectRoot) {
  await walk(projectRoot, async (absolute, relative, info) => {
    const first = relative.split(path.sep)[0];
    if (EXCLUDED.has(first)) return 'skip';
    if (!info.isFile()) return;
    const extension = path.extname(relative).toLowerCase();
    if (!PROJECT_RUNTIME_EXTENSIONS.has(extension)) return;
    if (extension === '.node') throw new KuraStandaloneError('Native addons are not embedded automatically.', { code: 'KR-STANDALONE-0010', hint: 'Use a pure JavaScript/WASM dependency or provide an external signed native addon.' });
    await addFile(assets, absolute, normalizeAssetPath(path.join('project', relative)));
  });
}

async function addDirectory(assets, sourceRoot, assetRoot, options = {}) {
  await walk(sourceRoot, async (absolute, relative, info) => {
    if (!info.isFile()) return;
    if (!options.includeAll && !PROJECT_RUNTIME_EXTENSIONS.has(path.extname(relative).toLowerCase())) return;
    await addFile(assets, absolute, normalizeAssetPath(path.join(assetRoot, relative)));
  });
}

async function addFile(assets, file, assetName) {
  if (path.extname(file).toLowerCase() === '.node') throw new KuraStandaloneError('Native .node addons are not embedded automatically.', { code: 'KR-STANDALONE-0010', hint: 'Use a pure JavaScript/WASM package or distribute a separately signed native addon.' });
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new KuraStandaloneError(`Standalone asset '${file}' is not a regular file.`, { code: 'KR-STANDALONE-0011' });
  if (info.size > MAX_TOTAL_BYTES) throw new KuraStandaloneError(`Standalone asset '${file}' is too large.`, { code: 'KR-STANDALONE-0012' });
  await addBufferAsset(assets, assetName, await readFile(file), info.mode & 0o111 ? 0o700 : 0o600);
}

async function addBufferAsset(assets, name, content, mode) {
  const normalized = normalizeAssetPath(name);
  if (assets.has(normalized)) {
    const existing = assets.get(normalized);
    if (!existing.content.equals(content)) throw new KuraStandaloneError(`Two standalone assets map to '${normalized}'.`, { code: 'KR-STANDALONE-0013' });
    return;
  }
  assets.set(normalized, { content: Buffer.from(content), mode });
}

function enforceAssetLimits(assets) {
  if (assets.size > MAX_FILES) throw new KuraStandaloneError(`Standalone build contains ${assets.size} files; the limit is ${MAX_FILES}.`, { code: 'KR-STANDALONE-0014' });
  const bytes = [...assets.values()].reduce((sum, asset) => sum + asset.content.length, 0);
  if (bytes > MAX_TOTAL_BYTES) throw new KuraStandaloneError(`Standalone assets use ${bytes} bytes; the limit is ${MAX_TOTAL_BYTES}.`, { code: 'KR-STANDALONE-0015' });
}

function rewriteNativeRuntimeImports(code, options) {
  const entryDirectory = path.posix.dirname(options.entryAsset);
  return String(code).replace(/(["'])(file:\/\/\/[^"']+)\1/g, (full, quote, urlText) => {
    let absolute;
    try { absolute = path.resolve(new URL(urlText).pathname); } catch { return full; }
    let target = null;
    if (inside(absolute, options.stdlibRoot)) target = `std/${path.basename(absolute)}`;
    else if (absolute === options.aiRuntime) target = 'lib/ai.mjs';
    if (!target) return full;
    let relative = path.posix.relative(entryDirectory, target);
    if (!relative.startsWith('.')) relative = `./${relative}`;
    return `${quote}${relative}${quote}`;
  });
}

function createLauncher({ entryAsset, manifest, appHash }) {
  return `// Generated by Kura standalone builder\nimport { getRawAsset } from 'node:sea';\nimport { createHash } from 'node:crypto';\nimport { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\nimport { pathToFileURL } from 'node:url';\nconst manifest=${JSON.stringify(manifest)};\nconst appHash=${JSON.stringify(appHash)};\nconst root=mkdtempSync(path.join(os.tmpdir(), 'kura-'+appHash.slice(0,12)+'-'));\nfunction inside(candidate){const relative=path.relative(root,candidate);return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));}\nfunction digest(value){return createHash('sha256').update(value).digest('hex');}\nfunction cleanup(){try{rmSync(root,{recursive:true,force:true});}catch{}}\nprocess.once('exit',cleanup);process.once('SIGINT',()=>{cleanup();process.exit(130)});process.once('SIGTERM',()=>{cleanup();process.exit(143)});\nfor(const item of manifest){const destination=path.resolve(root,item.name);if(!inside(destination))throw new Error('Invalid embedded asset path');mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});if(existsSync(destination)&&lstatSync(destination).isSymbolicLink())throw new Error('Refusing symbolic-link asset destination');const bytes=Buffer.from(getRawAsset(item.name));if(digest(bytes)!==item.sha256)throw new Error('Embedded asset integrity check failed: '+item.name);writeFileSync(destination,bytes,{mode:item.mode,flag:'wx'});if(process.platform!=='win32')chmodSync(destination,item.mode);}\nawait import(pathToFileURL(path.join(root,${JSON.stringify(entryAsset)})).href);\n`;
}

async function walk(root, visitor) {
  const stack = [''];
  while (stack.length) {
    const relativeDirectory = stack.pop();
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      const absolute = path.join(root, relative);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new KuraStandaloneError(`Symbolic links are not allowed in standalone assets: ${absolute}`, { code: 'KR-STANDALONE-0016' });
      const result = await visitor(absolute, relative, info);
      if (result === 'skip') continue;
      if (info.isDirectory()) stack.push(relative);
    }
  }
}

function normalizeAssetPath(value) {
  const normalized = String(value).replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new KuraStandaloneError(`Invalid standalone asset path '${value}'.`, { code: 'KR-STANDALONE-0017' });
  }
  return normalized;
}

function safeRelative(root, candidate, label) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new KuraStandaloneError(`The ${label} must stay inside the project.`, { code: 'KR-STANDALONE-0018' });
  }
  return relative;
}

function inside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function assertNoSymlinkPath(directory) {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!(await pathExists(current))) continue;
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new KuraStandaloneError(`Unsafe standalone output directory: ${current}`, { code: 'KR-STANDALONE-0022' });
  }
}
async function pathExists(file) { try { await lstat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }

async function isDirectory(file) { try { return (await stat(file)).isDirectory(); } catch { return false; } }
async function isFile(file) { try { return (await lstat(file)).isFile(); } catch { return false; } }
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1_000_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1_000_000); });
    child.once('error', reject);
    child.once('exit', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
