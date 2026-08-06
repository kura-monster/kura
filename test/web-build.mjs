// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBrowserApp, previewBrowserBuild, validateBrowserImports } from '../lib/web-builder.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = await mkdtemp(path.join(tmpdir(), 'kura-browser-build-'));
await mkdir(path.join(projectRoot, 'src'), { recursive: true });
await mkdir(path.join(projectRoot, 'public'), { recursive: true });
await writeFile(path.join(projectRoot, 'src', 'main.kr'), `
import { signal, queryString } from std:"browser";

fn main() {
  let count = signal(1);
  count.set(3);
  println(queryString("count", count.get()));
}
`, 'utf8');
await writeFile(path.join(projectRoot, 'public', 'index.html'), '<!doctype html><html><body><main id="app"></main></body></html>', 'utf8');
await writeFile(path.join(projectRoot, 'public', 'asset.txt'), 'asset', 'utf8');

try {
  const report = await buildBrowserApp({
    projectRoot,
    entryFile: 'src/main.kr',
    publicDir: 'public',
    outDir: 'dist',
    stdlibRoot: path.join(packageRoot, 'std'),
  });
  assert.match(report.appName, /^app-[a-f0-9]{16}\.mjs$/);
  assert.equal(report.manifest.target, 'browser');
  assert.equal(report.manifest.standardModules[0].name, 'browser');
  assert.ok(report.manifest.applicationSha256.length === 64);

  const appCode = await readFile(path.join(projectRoot, 'dist', report.manifest.application), 'utf8');
  assert.match(appCode, /\.\.\/_kura\/std\/browser\.mjs/);
  assert.doesNotMatch(appCode, /file:\/\//);
  const html = await readFile(path.join(projectRoot, 'dist', 'index.html'), 'utf8');
  assert.match(html, new RegExp(report.appName.replace('.', '\\.')));
  assert.equal(await readFile(path.join(projectRoot, 'dist', 'asset.txt'), 'utf8'), 'asset');
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'dist', 'kura-web-manifest.json'), 'utf8'));
  assert.equal(manifest.application, report.manifest.application);

  const preview = await previewBrowserBuild({ root: path.join(projectRoot, 'dist'), port: 0 });
  try {
    let response = await fetch(preview.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /type="module"/);
    response = await fetch(`${preview.url}missing-route`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /id="app"/);
  } finally {
    await preview.close();
  }

  assert.throws(() => validateBrowserImports('import value from "node:fs";'), /cannot run in a browser/);
  assert.throws(() => validateBrowserImports('import value from "react";'), /requires a browser bundler adapter/);

  const version = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'kr-web.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /Kura Web v1\.0\.0/);
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}

console.log('web builder tests passed');
