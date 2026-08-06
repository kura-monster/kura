// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundleBrowserArtifact, hasProjectBundler } from '../lib/web-bundler.mjs';
import { loadE2EConfig, runBrowserChecks } from '../lib/web-e2e.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'kura-adapter-test-'));
try {
  await mkdir(path.join(root, 'dist', 'assets'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"name":"adapter-test","type":"module"}\n');
  await writeFile(path.join(root, 'dist', 'assets', 'app.mjs'), 'console.log("test");\n');
  await writeFile(path.join(root, 'kura-e2e.json'), JSON.stringify({ checks: [{ path: '/', status: 200 }] }));
  assert.equal(await hasProjectBundler(root), false);
  await assert.rejects(
    () => bundleBrowserArtifact({ projectRoot: root, outDir: path.join(root, 'dist'), entryFile: path.join(root, 'dist', 'assets', 'app.mjs') }),
    error => error?.code === 'KR-WEB-BUNDLE-0004' && /esbuild/.test(error.message),
  );
  const config = await loadE2EConfig(path.join(root, 'kura-e2e.json'));
  assert.equal(config.checks.length, 1);
  await assert.rejects(
    () => runBrowserChecks({ projectRoot: root, baseUrl: 'http://127.0.0.1:1', checks: [] }),
    error => error?.code === 'KR-WEB-E2E-0103' && /Playwright/.test(error.message),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('web optional adapter tests passed');
