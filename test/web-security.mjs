// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { createApp } from '../std/web.mjs';
import { createDatabase } from '../std/db.mjs';
import { generateStaticSite } from '../std/ssr.mjs';
import { createOtlpExporter } from '../std/observe.mjs';
import { createTestClient, loadTest } from '../std/webtest.mjs';

const previous = process.env.KURA_SECURITY_MODE;
try {
  process.env.KURA_SECURITY_MODE = 'strict';
  assert.throws(() => createApp(), error => error?.code === 'WEB_STRICT_MODE' && error?.status === 403);
  assert.throws(() => createDatabase({ driver: 'memory' }), error => error?.code === 'KR-DB-STRICT-0001');
  assert.rejects(() => generateStaticSite({ outDir: 'blocked', routes: [], render: () => '' }), error => error?.code === 'KR-SSR-STRICT-0001');
  assert.throws(() => createOtlpExporter({ endpoint: 'https://example.test' }), /Strict security mode/);
  await assert.rejects(() => createTestClient({ listen() {}, close() {} }), error => error?.code === 'KR-WEBTEST-STRICT-0001');
  await assert.rejects(() => loadTest({ url: 'https://example.test' }), error => error?.code === 'KR-WEBTEST-STRICT-0002');
} finally {
  if (previous === undefined) delete process.env.KURA_SECURITY_MODE;
  else process.env.KURA_SECURITY_MODE = previous;
}

const app = createApp({ poweredBy: false });
assert.equal(typeof app.listen, 'function');
assert.equal(typeof app.close, 'function');
const database = createDatabase({ driver: 'memory' });
assert.equal(await database.ping(), true);
await database.close();

console.log('web security boundary tests passed');
