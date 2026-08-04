// SPDX-License-Identifier: MIT OR Apache-2.0
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [moduleFile, filterText = '', timeoutText = '5000'] = process.argv.slice(2);
const timeoutMs = Math.max(1, Number(timeoutText) || 5000);
const filter = filterText ? new RegExp(filterText, 'i') : null;
const report = { file: moduleFile, tests: [], loadError: null };
try {
  const module = await import(`${pathToFileURL(path.resolve(moduleFile)).href}?test=${Date.now()}`);
  const tests = Array.isArray(module.__kr_tests) ? module.__kr_tests : [];
  for (const test of tests) {
    if (filter && !filter.test(test.name)) continue;
    const started = performance.now();
    try {
      let timer;
      const value = Promise.resolve().then(() => test.fn());
      await Promise.race([
        value,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(`Test exceeded ${timeoutMs} ms`), { code: 'KR-TEST-0004' })), timeoutMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      report.tests.push({ name: test.name, line: test.line, column: test.column, status: 'passed', durationMs: performance.now() - started });
    } catch (error) {
      report.tests.push({
        name: test.name,
        line: test.line,
        column: test.column,
        status: 'failed',
        durationMs: performance.now() - started,
        error: {
          name: error?.name ?? 'Error',
          message: error?.message ?? String(error),
          code: error?.code ?? null,
          stack: String(error?.stack ?? '').split('\n').slice(0, 12).join('\n'),
        },
      });
      if (process.env.KURA_TEST_FAIL_FAST === '1') break;
    }
  }
} catch (error) {
  report.loadError = { name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: String(error?.stack ?? '').split('\n').slice(0, 12).join('\n') };
}
process.stdout.write(JSON.stringify(report));
