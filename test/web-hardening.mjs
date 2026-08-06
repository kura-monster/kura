// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { createApp, json, object, securityHeaders, rateLimit } from '../std/web.mjs';
import { createTestClient, securityProbe, loadTest } from '../std/webtest.mjs';

const app = createApp({ bodyLimit: 1024, poweredBy: false });
app.use(securityHeaders());
app.use(rateLimit({ windowMs: 1_000, max: 1_000 }));
app.get('/health', () => json(object('status', 'ok')));
app.post('/echo', async context => json(await context.json()));

const client = await createTestClient(app);
try {
  (await client.get('/health')).expectStatus(200).expectHeader('x-content-type-options', 'nosniff').expectJson({ status: 'ok' });
  const oversized = await client.post('/echo', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(4_000) }) });
  assert.ok([400, 413].includes(oversized.status));
  const probes = await securityProbe(client.baseUrl);
  assert.equal(probes.ok, true, JSON.stringify(probes.findings, null, 2));
  const load = await loadTest({ url: `${client.baseUrl}/health`, durationMs: 250, concurrency: 4, expectStatus: 200 });
  assert.ok(load.total > 0);
  assert.equal(load.errors, 0);
} finally {
  await client.close();
}

console.log('web hardening tests passed');
