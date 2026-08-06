// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrowserApp } from '../lib/web-builder.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = await mkdtemp(path.join(tmpdir(), 'kura-ui-build-'));
try {
  await mkdir(path.join(project, 'src'));
  await mkdir(path.join(project, 'public'));
  await writeFile(path.join(project, 'src', 'main.kr'), `
import { h, createComponent, mountApp } from std:"ui";
import { string } from std:"schema";

fn App(props) {
  return h("main", null, h("h1", null, "Kura UI"));
}

async fn main() {
  let name = string();
  name.parse("Kura");
  mountApp("#app", App);
}
`, 'utf8');
  await writeFile(path.join(project, 'public', 'index.html'), '<!doctype html><html><body><div id="app"></div></body></html>', 'utf8');
  const report = await buildBrowserApp({ projectRoot: project, entryFile: 'src/main.kr', publicDir: 'public', outDir: 'dist', stdlibRoot: path.join(root, 'std') });
  const names = report.manifest.standardModules.map(item => item.name).sort();
  assert.deepEqual(names, ['browser', 'schema', 'ui']);
  const app = await readFile(path.join(project, 'dist', report.manifest.application), 'utf8');
  assert.match(app, /_kura\/std\/ui\.mjs/);
  assert.match(app, /_kura\/std\/schema\.mjs/);
  assert.match(await readFile(path.join(project, 'dist', '_kura', 'std', 'ui.mjs'), 'utf8'), /createComponent/);
  assert.match(await readFile(path.join(project, 'dist', '_kura', 'std', 'browser.mjs'), 'utf8'), /signal/);
} finally {
  await rm(project, { recursive: true, force: true });
}
console.log('web UI build tests passed');
