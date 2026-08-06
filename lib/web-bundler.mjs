// SPDX-License-Identifier: MIT OR Apache-2.0
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class WebBundlerError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'WebBundlerError';
    this.code = options.code ?? 'KR-WEB-BUNDLE-0001';
    this.hint = options.hint ?? null;
  }
}

export async function bundleBrowserArtifact(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const outDir = path.resolve(options.outDir ?? path.join(projectRoot, 'dist'));
  const entryFile = path.resolve(options.entryFile);
  assertInside(entryFile, outDir, 'bundle entry');
  const esbuild = await loadProjectModule(projectRoot, 'esbuild', 'kr add esbuild --dev');
  const assetsDir = path.resolve(outDir, options.assetsDir ?? 'assets');
  assertInside(assetsDir, outDir, 'bundle assets');
  const result = await esbuild.build({
    absWorkingDir: projectRoot,
    entryPoints: [entryFile],
    outdir: assetsDir,
    bundle: true,
    write: true,
    format: 'esm',
    platform: 'browser',
    target: options.target ?? ['es2022'],
    splitting: options.splitting !== false,
    minify: options.minify !== false,
    sourcemap: options.sourcemap ?? true,
    sourcesContent: options.sourcesContent !== false,
    treeShaking: true,
    metafile: true,
    legalComments: options.legalComments ?? 'eof',
    entryNames: options.entryNames ?? 'app-[hash]',
    chunkNames: options.chunkNames ?? 'chunk-[hash]',
    assetNames: options.assetNames ?? 'asset-[hash]',
    publicPath: options.publicPath ?? '/assets',
    define: {
      'process.env.NODE_ENV': JSON.stringify(options.mode ?? 'production'),
      ...(options.define ?? {}),
    },
    external: options.external ?? [],
    logLevel: 'silent',
  }).catch(error => {
    const details = error?.errors?.map(item => item.text).join('\n') ?? error?.message;
    throw new WebBundlerError('Browser bundle failed.', { code: 'KR-WEB-BUNDLE-0002', cause: error, hint: details });
  });
  const outputs = [];
  let application = null;
  for (const [file, metadata] of Object.entries(result.metafile.outputs ?? {})) {
    const absolute = path.resolve(projectRoot, file);
    assertInside(absolute, outDir, 'bundle output');
    const source = await readFile(absolute);
    const relative = path.relative(outDir, absolute).replaceAll('\\', '/');
    const item = {
      path: relative,
      bytes: source.length,
      sha256: createHash('sha256').update(source).digest('hex'),
      imports: Object.freeze((metadata.imports ?? []).map(entry => entry.path)),
      entry: Boolean(metadata.entryPoint),
    };
    outputs.push(Object.freeze(item));
    if (metadata.entryPoint && path.resolve(projectRoot, metadata.entryPoint) === entryFile && absolute.endsWith('.js')) application = relative;
  }
  if (!application) {
    const candidate = outputs.find(item => item.entry && /app-[A-Za-z0-9_-]+\.js$/.test(item.path));
    application = candidate?.path ?? null;
  }
  if (!application) throw new WebBundlerError('Bundler did not produce an application entry.', { code: 'KR-WEB-BUNDLE-0003' });
  if (options.removeInput !== false && entryFile !== path.join(outDir, application)) await rm(entryFile, { force: true });
  outputs.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({ application, outputs: Object.freeze(outputs), metafile: Object.freeze(result.metafile) });
}

export async function analyzeBundle(metafile, options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const esbuild = await loadProjectModule(projectRoot, 'esbuild', 'kr add esbuild --dev');
  return esbuild.analyzeMetafile(metafile, { verbose: Boolean(options.verbose), color: Boolean(options.color) });
}

export async function hasProjectBundler(projectRoot = process.cwd()) {
  try { await resolveProjectModule(path.resolve(projectRoot), 'esbuild'); return true; } catch { return false; }
}

async function loadProjectModule(projectRoot, name, installHint) {
  let resolved;
  try { resolved = await resolveProjectModule(projectRoot, name); }
  catch (error) {
    throw new WebBundlerError(`Optional browser bundler '${name}' is not installed.`, { code: 'KR-WEB-BUNDLE-0004', cause: error, hint: installHint });
  }
  return import(pathToFileURL(resolved).href);
}

async function resolveProjectModule(projectRoot, name) {
  const packageFile = path.join(projectRoot, 'package.json');
  if (!(await exists(packageFile))) throw new Error(`Missing ${packageFile}`);
  const require = createRequire(packageFile);
  return require.resolve(name);
}

function assertInside(candidate, root, label) { const relative=path.relative(path.resolve(root),path.resolve(candidate)); if(relative.startsWith('..')||path.isAbsolute(relative))throw new WebBundlerError(`${label} escaped the output directory.`,{code:'KR-WEB-BUNDLE-0005'}); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
