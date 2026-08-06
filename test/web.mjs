// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../lib/compiler.mjs';
import {
  createApp,
  object,
  json,
  text,
  staticFiles,
  compression,
  securityHeaders,
  cors,
  sse,
} from '../std/web.mjs';
import {
  request,
  getJson,
  postJson,
  options as httpOptions,
  query as httpQuery,
} from '../std/http.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticRoot = await mkdtemp(path.join(tmpdir(), 'kura-web-test-'));
await writeFile(path.join(staticRoot, 'index.html'), '<h1>Kura Web</h1>');
await writeFile(path.join(staticRoot, 'range.txt'), 'abcdefghijklmnopqrstuvwxyz');

const app = createApp({ bodyLimit: 1024, poweredBy: false });
app.use(securityHeaders());
app.use(cors());
app.use(compression({ threshold: 16 }));
app.get('/hello/:name', context => json(object('hello', context.param('name'), 'q', context.query('q', ''))));
app.post('/echo', async context => json(await context.json()));
app.get('/plain', () => text('x'.repeat(100)));
app.get('/events', sse(async stream => { stream.send(object('ready', true), 'ready', '1'); }));
app.use(staticFiles(staticRoot));
app.websocket('/ws/:room', socket => {
  socket.onMessage(value => socket.send(`echo:${socket.params.room}:${value}`));
});

const listener = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${listener.port}`;

try {
  let result = await fetch(`${base}/hello/Ada?q=ok`);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { hello: 'Ada', q: 'ok' });
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');

  result = await fetch(`${base}/hello/Ada`, { headers: { origin: 'https://example.test' } });
  assert.equal(result.headers.get('access-control-allow-origin'), '*');

  const echo = await postJson(`${base}/echo`, { a: 1 });
  assert.equal(echo.status, 200);
  assert.deepEqual(echo.json(), { a: 1 });

  const retryApp = createApp();
  let retryCount = 0;
  retryApp.get('/value', () => {
    retryCount += 1;
    return retryCount < 2 ? text('retry', 503) : json(object('ok', true));
  });
  const retryListener = await retryApp.listen(0, '127.0.0.1');
  try {
    const retryValue = await getJson(
      `http://127.0.0.1:${retryListener.port}/value`,
      httpOptions('retries', 2, 'retryDelayMs', 1, 'query', httpQuery('x', '1')),
    );
    assert.equal(retryValue.ok, true);
    assert.equal(retryCount, 2);
  } finally {
    await retryApp.close();
  }

  result = await fetch(`${base}/plain`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'x'.repeat(100));
  assert.match(result.headers.get('vary') ?? '', /Accept-Encoding/i);

  result = await fetch(`${base}/index.html`);
  assert.equal(await result.text(), '<h1>Kura Web</h1>');
  const etag = result.headers.get('etag');
  assert.ok(etag);
  result = await fetch(`${base}/index.html`, { headers: { 'if-none-match': etag } });
  assert.equal(result.status, 304);

  result = await fetch(`${base}/range.txt`, { headers: { range: 'bytes=2-5' } });
  assert.equal(result.status, 206);
  assert.equal(await result.text(), 'cdef');
  assert.equal(result.headers.get('content-range'), 'bytes 2-5/26');

  result = await fetch(`${base}/events`);
  const eventText = await result.text();
  assert.match(eventText, /event: ready/);
  assert.match(eventText, /data: {"ready":true}/);

  await assert.rejects(
    () => request(`${base}/missing`),
    error => error.status === 404 && error.code === 'HTTP_STATUS',
  );

  const websocket = await openWebSocket(listener.port, '/ws/main');
  websocket.socket.write(maskedTextFrame('hello'));
  const reply = await readServerFrame(websocket.socket, websocket.remaining);
  assert.equal(reply.opcode, 1);
  assert.equal(reply.payload.toString('utf8'), 'echo:main:hello');
  websocket.socket.destroy();

  const kuraSource = `
import { createApp, object, json } from std:"web";

async fn health(context) {
  return json(object("status", "ok", "path", context.path));
}

async fn main() {
  let web = createApp();
  web.get("/health", health);
}
`;
  const compiled = compile(kuraSource, {
    file: 'web-example.kr',
    stdlibRoot: path.join(root, 'std'),
    autoRun: false,
  });
  assert.match(compiled.code, /createApp/);
  assert.match(compiled.code, /async function health/);
  assert.match(compiled.code, /web\.get\("\/health", health\)/);
} finally {
  await app.close();
  await rm(staticRoot, { recursive: true, force: true });
}

async function openWebSocket(port, route) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = Buffer.alloc(0);
    socket.on('connect', () => {
      socket.write([
        `GET ${route} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '\r\n',
      ].join('\r\n'));
    });
    const onData = chunk => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf(Buffer.from('\r\n\r\n'));
      if (end < 0) return;
      socket.off('data', onData);
      assert.match(data.subarray(0, end).toString('utf8'), /101 Switching Protocols/);
      resolve({ socket, remaining: data.subarray(end + 4) });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

function maskedTextFrame(value) {
  const payload = Buffer.from(value);
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.alloc(6 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index++) frame[6 + index] = payload[index] ^ mask[index % 4];
  return frame;
}

async function readServerFrame(socket, initial = Buffer.alloc(0)) {
  let buffer = Buffer.from(initial);
  while (buffer.length < 2) buffer = Buffer.concat([buffer, await onceData(socket)]);
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    while (buffer.length < 4) buffer = Buffer.concat([buffer, await onceData(socket)]);
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  while (buffer.length < offset + length) buffer = Buffer.concat([buffer, await onceData(socket)]);
  return { opcode, payload: buffer.subarray(offset, offset + length) };
}

function onceData(socket) {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve);
    socket.once('error', reject);
  });
}

console.log('web platform tests passed');
