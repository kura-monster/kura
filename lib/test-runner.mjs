// SPDX-License-Identifier: MIT OR Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile } from './compiler.mjs';
import { atomicWriteFile, findKuraFiles, readTextFileSecure, LIMITS, sanitizeChildEnv } from './security.mjs';
import { KuraCliError } from './diagnostics.mjs';

const workerFile = fileURLToPath(new URL('./test-worker.mjs', import.meta.url));

export async function discoverTests(projectRoot, explicit = null) {
  if (explicit) {
    const resolved = path.resolve(projectRoot, explicit);
    return [resolved];
  }
  const files = await findKuraFiles(projectRoot);
  return files.filter(file => {
    const relative = path.relative(projectRoot, file).replaceAll('\\', '/');
    return relative.startsWith('tests/') || relative.endsWith('.test.kr') || relative.endsWith('.spec.kr');
  }).sort();
}

export async function runTestSuite(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const files = await discoverTests(projectRoot, options.explicit);
  if (!files.length) {
    throw new KuraCliError('No Kura test files were found.', {
      code: 'KR-TEST-0001', title: 'This project has no tests yet',
      hint: 'Create tests/example_test.kr and add: test "example" { assert_eq(1 + 1, 2); }',
    });
  }
  const buildDir = path.join(projectRoot, '.kura', 'tests');
  await mkdir(buildDir, { recursive: true, mode: 0o700 });
  const compiled = [];
  for (const file of files) {
    const source = await readTextFileSecure(file, { maxBytes: LIMITS.sourceBytes, allowSymlink: options.securityMode !== 'strict' });
    const output = compile(source, {
      file,
      autoRun: false,
      exposeTests: true,
      securityMode: options.securityMode ?? 'standard',
      stdlibRoot: options.stdlibRoot,
      aiRuntime: options.aiRuntime,
      allowAi: Boolean(options.allowAi),
      optimize: Boolean(options.optimize),
      compact: Boolean(options.optimize),
    });
    const hash = createHash('sha256').update(file).update('\0').update(source).digest('hex').slice(0, 16);
    const destination = path.join(buildDir, `${path.basename(file, '.kr')}-${hash}.mjs`);
    await atomicWriteFile(destination, output.code, { root: projectRoot, mode: 0o600 });
    compiled.push({ sourceFile: file, moduleFile: destination });
  }

  const jobs = Math.max(1, Math.min(options.jobs ?? 1, 32));
  const results = new Array(compiled.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= compiled.length) return;
      results[index] = await runTestFile(compiled[index], { ...options, projectRoot });
      if (options.failFast && hasFailure(results[index])) return;
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, compiled.length) }, worker));
  const completed = results.filter(Boolean);
  const tests = completed.flatMap(result => result.tests.map(test => ({ ...test, file: result.sourceFile })));
  const loadErrors = completed.filter(result => result.loadError).map(result => ({ file: result.sourceFile, ...result.loadError }));
  return {
    files: completed.length,
    tests,
    loadErrors,
    passed: tests.filter(test => test.status === 'passed').length,
    failed: tests.filter(test => test.status === 'failed').length + loadErrors.length,
    skipped: 0,
    durationMs: completed.reduce((sum, result) => sum + result.durationMs, 0),
    ok: !loadErrors.length && tests.every(test => test.status === 'passed'),
  };
}

async function runTestFile(entry, options) {
  const started = performance.now();
  const child = spawn(process.execPath, [workerFile, entry.moduleFile, options.filter ?? '', String(options.timeoutMs ?? 5000)], {
    cwd: options.projectRoot,
    env: { ...sanitizeChildEnv(process.env, { strict: options.securityMode === 'strict', allow: options.allowEnv ?? [] }), KURA_TEST_FAIL_FAST: options.failFast ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill('SIGKILL'); });
  const fileTimeout = Math.max(10_000, (options.timeoutMs ?? 5000) * 100);
  let timer;
  const code = await new Promise((resolve, reject) => {
    timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref(); }, fileTimeout);
    timer.unref?.();
    child.once('error', reject);
    child.once('exit', value => resolve(value ?? 1));
  }).finally(() => clearTimeout(timer));
  if (code !== 0 && !stdout) return { sourceFile: entry.sourceFile, tests: [], loadError: { message: stderr.trim() || `Test worker exited with code ${code}` }, durationMs: performance.now() - started };
  try {
    const parsed = JSON.parse(stdout);
    return { sourceFile: entry.sourceFile, tests: parsed.tests ?? [], loadError: parsed.loadError, durationMs: performance.now() - started };
  } catch {
    return { sourceFile: entry.sourceFile, tests: [], loadError: { message: stderr.trim() || 'Test worker returned invalid output' }, durationMs: performance.now() - started };
  }
}

function hasFailure(result) { return Boolean(result.loadError) || result.tests.some(test => test.status === 'failed'); }
