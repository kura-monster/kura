// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDatabase,
  inferDriver,
  splitMigration,
  splitSqlStatements,
} from '../lib/web-database.mjs';
import {
  object,
  string,
  integer,
  array,
  enumeration,
  ValidationError,
} from '../std/schema.mjs';
import {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  MemorySessionStore,
  createSessionManager,
  createCsrf,
  createApiKey,
  verifyApiKey,
  generateTotpSecret,
  generateTotp,
  verifyTotp,
} from '../std/auth.mjs';
import {
  createOpenApi,
  jsonBody,
  jsonResponse,
  bearerAuth,
  parameter,
} from '../std/openapi.mjs';
import {
  html,
  raw,
  render,
  renderDocument,
  serializeState,
  parseState,
  createRouter,
} from '../std/ssr.mjs';
import {
  createLogger,
  MetricsRegistry,
  createHealthRegistry,
} from '../std/observe.mjs';
import { generateDeployment, deploymentDoctor } from '../lib/web-deploy.mjs';
import { classNames, h, Fragment } from '../std/ui.mjs';

const profileSchema = object({
  name: string({ trim: true, minLength: 2, maxLength: 40 }),
  age: integer({ coerce: true, min: 13, max: 130 }),
  roles: array(enumeration(['user', 'admin']), { min: 1, unique: true }),
}, { unknown: 'strict' });
const parsed = profileSchema.parse({ name: ' Ada ', age: '36', roles: ['admin'] });
assert.deepEqual(parsed, { name: 'Ada', age: 36, roles: ['admin'] });
assert.throws(() => profileSchema.parse({ name: 'A', age: 4, roles: [], extra: true }), ValidationError);
const jsonSchema = profileSchema.toJSONSchema({ title: 'Profile' });
assert.equal(jsonSchema.title, 'Profile');
assert.deepEqual(jsonSchema.required.sort(), ['age', 'name', 'roles']);
assert.equal(jsonSchema.additionalProperties, false);

const passwordHash = await hashPassword('correct horse battery staple', { cost: 1024 });
assert.equal(await verifyPassword('correct horse battery staple', passwordHash), true);
assert.equal(await verifyPassword('wrong password', passwordHash), false);
const jwtSecret = 'x'.repeat(64);
const jwt = signJwt({ sub: 'user-1', roles: ['admin'] }, jwtSecret, { expiresIn: '5m', issuer: 'kura-test', audience: 'kura-web' });
const claims = verifyJwt(jwt, jwtSecret, { issuer: 'kura-test', audience: 'kura-web' });
assert.equal(claims.sub, 'user-1');
const store = new MemorySessionStore({ ttlMs: 10_000 });
const sessions = createSessionManager({ store, secret: 's'.repeat(64), secure: false, bindIp: false });
const created = await sessions.create({ userId: 'user-1', roles: ['admin'] }, { request: { headers: { 'user-agent': 'test' } } });
const session = await sessions.read(created.cookie.split(';', 1)[0], { request: { headers: { 'user-agent': 'test' } } });
assert.equal(session.value.userId, 'user-1');
const csrf = createCsrf({ secret: 'c'.repeat(64), secure: false });
const csrfToken = csrf.issue(session.id);
assert.equal(csrf.verify(csrfToken.token, csrfToken.token, session.id), true);
const apiKey = createApiKey('krtest');
assert.equal(verifyApiKey(apiKey.token, apiKey.hash), true);
const totpSecret = generateTotpSecret();
const totp = generateTotp(totpSecret, { time: 1_700_000_000_000 });
assert.equal(verifyTotp(totp, totpSecret, { time: 1_700_000_000_000, window: 0 }), true);
store.close();

assert.equal(inferDriver('postgres://localhost/app'), 'postgres');
assert.equal(inferDriver('libsql://sample.turso.io'), 'turso');
const seen = [];
const database = createDatabase({
  driver: 'memory',
  maxConnections: 2,
  memoryHandler(statement) {
    seen.push({ text: statement.text, values: [...statement.values] });
    if (/SELECT/i.test(statement.text)) return { rows: [{ id: 1, name: 'Ada' }], rowsAffected: 1, columns: ['id', 'name'] };
    return { rows: [], rowsAffected: 1 };
  },
});
const query = database.table('users').select('id', 'name').where('id', 1).orderBy('name').limit(1).toSQL();
assert.match(query.text, /^SELECT "id", "name" FROM "users" WHERE "id" = \? ORDER BY "name" ASC LIMIT \?$/);
assert.deepEqual(query.values, [1, 1]);
assert.equal((await database.one(query)).name, 'Ada');
await database.transaction(async transaction => {
  await transaction.query('UPDATE users SET name = ? WHERE id = ?', ['Grace', 1]);
});
assert.ok(seen.some(item => item.text === 'UPDATE users SET name = ? WHERE id = ?'));
await database.close();
const migration = splitMigration('-- up\nCREATE TABLE test (id INT);\n-- down\nDROP TABLE test;');
assert.match(migration.up, /CREATE TABLE/);
assert.match(migration.down, /DROP TABLE/);
assert.deepEqual(splitSqlStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;"), ["INSERT INTO t VALUES ('a;b')", 'SELECT 1']);

const api = createOpenApi({ title: 'Example API', version: '2.0.0' })
  .server('https://api.example.test')
  .securityScheme('bearer', bearerAuth())
  .schema('Profile', profileSchema)
  .get('/profiles/:id', {
    operationId: 'getProfile',
    parameters: [parameter('id', 'path', string({ minLength: 1 }))],
    responses: { 200: jsonResponse('Profile'), 404: { description: 'Not found' } },
    security: [{ bearer: [] }],
  })
  .post('/profiles', {
    operationId: 'createProfile',
    requestBody: jsonBody(profileSchema),
    responses: { 201: jsonResponse('Profile') },
  });
const spec = api.build();
assert.equal(spec.paths['/profiles/{id}'].get.operationId, 'getProfile');
assert.match(api.docsHtml({ specUrl: '/openapi.json' }), /SwaggerUIBundle/);
assert.match(api.client(), /async getProfile/);
assert.equal(api.checksum().length, 64);

assert.equal(await render(html`<p>${'<unsafe>'} ${raw('<strong>safe</strong>')}</p>`), '<p>&lt;unsafe&gt; <strong>safe</strong></p>');
const stateText = serializeState({ created: new Date('2026-01-01T00:00:00Z'), count: 4n });
const state = parseState(stateText);
assert.equal(state.count, 4n);
const document = await renderDocument({ title: 'Kura SSR', body: html`<main>${'Hello'}</main>`, state: { user: 'Ada' } });
assert.match(document, /^<!doctype html>/);
assert.match(document, /__KURA_STATE__/);
const router = createRouter();
router.route('/users/:id', ({ params }) => html`<h1>${params.id}</h1>`);
assert.equal(await render(await router.render('/users/42')), '<h1>42</h1>');

let logOutput = '';
const logger = createLogger({ pretty: false, level: 'debug', destination: { write(value) { logOutput += value; } } });
logger.info('test.event', { password: 'secret', ok: true });
assert.match(logOutput, /\[REDACTED\]/);
const metrics = new MetricsRegistry({ prefix: 'test' });
const counter = metrics.counter('requests_total', 'Requests', { labels: ['method'] });
counter.inc(2, { method: 'GET' });
const histogram = metrics.histogram('duration_seconds', 'Duration', { labels: ['route'], buckets: [0.1, 1] });
histogram.observe(0.5, { route: '/health' });
assert.match(metrics.prometheus(), /test_requests_total\{method="GET"\} 2/);
assert.match(metrics.prometheus(), /test_duration_seconds_bucket\{le="1",route="\/health"\} 1|test_duration_seconds_bucket\{route="\/health",le="1"\} 1/);
const health = createHealthRegistry();
health.register('database', async () => ({ status: 'ok' }));
assert.equal((await health.run()).status, 'ok');

assert.equal(classNames('button', { active: true, disabled: false }, ['large']), 'button active large');
const vnode = h(Fragment, null, h('strong', { class: 'name' }, 'Kura'));
assert.equal(vnode.type, Fragment);

const deployRoot = await mkdtemp(path.join(tmpdir(), 'kura-deploy-test-'));
try {
  await generateDeployment({ projectRoot: deployRoot, target: 'docker', name: 'kura-test', port: 3000 });
  assert.match(await readFile(path.join(deployRoot, 'Dockerfile'), 'utf8'), /USER kura/);
  assert.match(await readFile(path.join(deployRoot, 'compose.yaml'), 'utf8'), /no-new-privileges/);
  const doctor = await deploymentDoctor({ projectRoot: deployRoot });
  assert.equal(doctor.findings.some(item => item.code === 'KR-DEPLOY-0205'), false);
} finally {
  await rm(deployRoot, { recursive: true, force: true });
}

console.log('web ecosystem tests passed');
