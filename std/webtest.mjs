// SPDX-License-Identifier: MIT OR Apache-2.0
import { randomBytes } from 'node:crypto';

export class WebTestError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'WebTestError';
    this.code = options.code ?? 'KR-WEBTEST-0001';
    this.details = options.details ?? null;
  }
}

export async function createTestClient(app, options = {}) {
  if (process.env.KURA_SECURITY_MODE === 'strict') throw new WebTestError('Strict security mode blocks test servers.', { code: 'KR-WEBTEST-STRICT-0001' });
  const listener = await app.listen(0, options.host ?? '127.0.0.1');
  const baseUrl = `http://${options.host ?? '127.0.0.1'}:${listener.port}`;
  const cookies = new Map();
  let closed = false;
  const request = async (path, init = {}) => {
    if (closed) throw new WebTestError('Test client is closed.', { code: 'KR-WEBTEST-0101' });
    const headers = new Headers(init.headers ?? {});
    if (cookies.size && !headers.has('cookie')) headers.set('cookie', [...cookies].map(([name,value]) => `${name}=${value}`).join('; '));
    let body = init.body;
    if (init.json !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(init.json); }
    if (init.form !== undefined) { headers.set('content-type', 'application/x-www-form-urlencoded'); body = new URLSearchParams(init.form); }
    const response = await fetch(new URL(path, baseUrl), { ...init, headers, body, redirect: init.redirect ?? 'manual' });
    absorbCookies(response.headers, cookies);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    let parsed = null;
    if (contentType.includes('json') && bytes.length) { try { parsed = JSON.parse(bytes.toString('utf8')); } catch { } }
    return Object.freeze({
      status: response.status,
      ok: response.ok,
      url: response.url,
      headers: response.headers,
      bytes,
      text: () => bytes.toString(init.encoding ?? 'utf8'),
      json: () => parsed ?? JSON.parse(bytes.toString('utf8')),
      cookie: name => cookies.get(name) ?? null,
      expectStatus(expected) { if (response.status !== expected) throw new WebTestError(`Expected HTTP ${expected}, received ${response.status}.`, { code: 'KR-WEBTEST-0102', details: bytes.toString('utf8').slice(0, 2048) }); return this; },
      expectHeader(name, expected) { const actual=response.headers.get(name); if (expected instanceof RegExp ? !expected.test(actual ?? '') : actual !== expected) throw new WebTestError(`Expected header ${name} to match ${expected}, received ${actual}.`, { code: 'KR-WEBTEST-0103' }); return this; },
      expectJson(expected) { const actual=this.json(); if (stableStringify(actual)!==stableStringify(expected)) throw new WebTestError(`JSON response did not match.`, { code:'KR-WEBTEST-0104',details:{expected,actual} }); return this; },
      expectText(expected) { const actual=this.text(); if (expected instanceof RegExp ? !expected.test(actual) : actual!==expected) throw new WebTestError(`Text response did not match.`, {code:'KR-WEBTEST-0105',details:{expected:String(expected),actual}}); return this; },
    });
  };
  return Object.freeze({
    baseUrl,
    cookies,
    request,
    get: (path, init={}) => request(path,{...init,method:'GET'}),
    post: (path, init={}) => request(path,{...init,method:'POST'}),
    put: (path, init={}) => request(path,{...init,method:'PUT'}),
    patch: (path, init={}) => request(path,{...init,method:'PATCH'}),
    delete: (path, init={}) => request(path,{...init,method:'DELETE'}),
    async close() { if (closed) return; closed=true; await app.close(); },
  });
}

export async function loadTest(options = {}) {
  if (process.env.KURA_SECURITY_MODE === 'strict') throw new WebTestError('Strict security mode blocks load-test network access.', { code: 'KR-WEBTEST-STRICT-0002' });
  const url = String(options.url);
  if (!/^https?:\/\//.test(url)) throw new WebTestError('loadTest requires an HTTP URL.', { code: 'KR-WEBTEST-0201' });
  const durationMs = options.durationMs ?? 5_000;
  const concurrency = options.concurrency ?? 10;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = performance.now() + durationMs;
  const samples = [];
  const statuses = new Map();
  let errors = 0;
  let bytes = 0;
  async function worker() {
    while (performance.now() < deadline) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      const started = performance.now();
      try {
        const response = await fetch(url, { method: options.method ?? 'GET', headers: options.headers, body: options.body, signal: controller.signal });
        const body = await response.arrayBuffer();
        bytes += body.byteLength;
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        if (options.expectStatus && response.status !== options.expectStatus) errors++;
      } catch { errors++; }
      finally { clearTimeout(timer); samples.push(performance.now() - started); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  samples.sort((a,b)=>a-b);
  const total = samples.length;
  const elapsedMs = durationMs;
  return Object.freeze({
    total,
    errors,
    errorRate: total ? errors / total : 0,
    requestsPerSecond: total / (elapsedMs / 1000),
    bytes,
    statuses: Object.freeze(Object.fromEntries(statuses)),
    latency: Object.freeze({ min: samples[0] ?? 0, max: samples.at(-1) ?? 0, average: total ? samples.reduce((a,b)=>a+b,0)/total : 0, p50: percentile(samples,0.5), p95: percentile(samples,0.95), p99: percentile(samples,0.99) }),
  });
}

export async function securityProbe(baseUrl, options = {}) {
  const probes = [
    { name:'path traversal', path:'/..%2f..%2fetc%2fpasswd', allowed:[400,403,404] },
    { name:'encoded traversal', path:'/%2e%2e/%2e%2e/windows/win.ini', allowed:[400,403,404] },
    { name:'null byte', path:'/file%00.txt', allowed:[400,404] },
    { name:'unsupported method', path:'/', method:'CONNECT', allowed:[400,405,501] },
    { name:'oversized path', path:`/${'a'.repeat(options.maxPathBytes ?? 5000)}`, allowed:[400,404,414] },
    { name:'host confusion', path:'/', headers:{host:'evil.example'}, allowed:[200,400,403,404] },
  ];
  const findings=[];
  for (const probe of probes) {
    try {
      const response=await fetch(new URL(probe.path,baseUrl),{method:probe.method??'GET',headers:probe.headers,redirect:'manual'});
      const passed=probe.allowed.includes(response.status);
      findings.push({name:probe.name,passed,status:response.status,expected:probe.allowed});
      await response.body?.cancel();
    } catch (error) { const message=String(error?.message??error); const passed=probe.name==='unsupported method' && /unsupported/i.test(message); findings.push({name:probe.name,passed,error:message}); }
  }
  return Object.freeze({ok:findings.every(item=>item.passed),findings:Object.freeze(findings)});
}

export function fuzzJson(schema, options = {}) {
  const iterations = options.iterations ?? 100;
  const findings=[];
  for (let index=0;index<iterations;index++) {
    const value=randomJson(options.depth ?? 4);
    try { const result=schema.safeParse(value); if (result.success && options.invariant && !options.invariant(result.data)) findings.push({iteration:index,value,error:'invariant failed'}); }
    catch (error) { findings.push({iteration:index,value,error:String(error?.message??error)}); }
  }
  return Object.freeze({ok:findings.length===0,iterations,findings:Object.freeze(findings)});
}

function absorbCookies(headers, jar) { const values=headers.getSetCookie?.()??(headers.get('set-cookie')?[headers.get('set-cookie')]:[]); for (const line of values) { const first=String(line).split(';',1)[0]; const index=first.indexOf('='); if(index<=0)continue; const name=first.slice(0,index).trim(); const value=first.slice(index+1); if(/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(line))jar.delete(name);else jar.set(name,value); } }
function stableStringify(value){return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)}
function percentile(values,position){if(!values.length)return 0;return values[Math.min(values.length-1,Math.floor((values.length-1)*position))]}
function randomJson(depth){if(depth<=0)return [null,true,false,Math.random(),randomBytes(4).toString('hex')][Math.floor(Math.random()*5)];const type=Math.floor(Math.random()*6);if(type===0)return null;if(type===1)return Math.random()<0.5;if(type===2)return (Math.random()-0.5)*1e6;if(type===3)return randomBytes(Math.floor(Math.random()*16)).toString('base64url');if(type===4)return Array.from({length:Math.floor(Math.random()*5)},()=>randomJson(depth-1));const output={};for(let i=0;i<Math.floor(Math.random()*5);i++)output[`k${randomBytes(2).toString('hex')}`]=randomJson(depth-1);return output}
