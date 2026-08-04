// SPDX-License-Identifier: MIT OR Apache-2.0

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_AGENT_STEPS = 8;
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class KuraAiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'KuraAiError';
    this.code = options.code ?? 'KR-AI-0001';
    this.status = options.status ?? null;
    this.details = options.details ?? null;
    this.retryable = Boolean(options.retryable);
  }
}

export function createAiNamespace(defaults = {}) {
  const normalizedDefaults = Object.freeze({
    baseUrl: normalizeBaseUrl(defaults.baseUrl ?? readEnv('KURA_AI_BASE_URL') ?? ''),
    apiKey: String(defaults.apiKey ?? readEnv('KURA_AI_API_KEY') ?? ''),
    model: String(defaults.model ?? readEnv('KURA_AI_MODEL') ?? ''),
    timeoutMs: clampInteger(defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 600_000, 'timeoutMs'),
    maxResponseBytes: clampInteger(defaults.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 1_024, 128 * 1024 * 1024, 'maxResponseBytes'),
  });

  const namespace = {
    message,
    system: content => message('system', content),
    user: content => message('user', content),
    assistant: content => message('assistant', content),
    toolMessage: (toolCallId, content) => Object.freeze({ role: 'tool', tool_call_id: safeText(toolCallId, 'tool call id'), content: safeText(content, 'tool content') }),
    tool,
    schema,
    client(baseUrl = normalizedDefaults.baseUrl, apiKey = normalizedDefaults.apiKey, model = normalizedDefaults.model) {
      return createAiClient({ ...normalizedDefaults, baseUrl, apiKey, model });
    },
    configure(baseUrl, apiKey = '', model = '') {
      return createAiClient({ ...normalizedDefaults, baseUrl, apiKey, model });
    },
  };

  if (normalizedDefaults.baseUrl) namespace.default = createAiClient(normalizedDefaults);
  return Object.freeze(namespace);
}

export function createAiClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) throw new KuraAiError('No AI base URL was configured.', { code: 'KR-AI-0008' });
  const config = Object.freeze({
    baseUrl,
    apiKey: String(options.apiKey ?? ''),
    model: String(options.model ?? ''),
    timeoutMs: clampInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 600_000, 'timeoutMs'),
    maxResponseBytes: clampInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 1_024, 128 * 1024 * 1024, 'maxResponseBytes'),
    retries: clampInteger(options.retries ?? 2, 0, 8, 'retries'),
  });

  const client = {
    config: Object.freeze({ baseUrl: config.baseUrl, model: config.model, timeoutMs: config.timeoutMs }),
    message,
    system: content => message('system', content),
    user: content => message('user', content),
    assistant: content => message('assistant', content),
    toolMessage: (toolCallId, content) => Object.freeze({ role: 'tool', tool_call_id: safeText(toolCallId, 'tool call id'), content: safeText(content, 'tool content') }),
    tool,
    schema,
    async chat(messages, model = config.model) {
      const payload = {
        model: requireModel(model),
        messages: normalizeMessages(messages),
        stream: false,
      };
      const raw = await requestJson(config, '/chat/completions', payload);
      return normalizeChatResponse(raw);
    },
    async complete(prompt, model = config.model) {
      return this.chat([message('user', prompt)], model);
    },
    async json(prompt, model = config.model) {
      const payload = {
        model: requireModel(model),
        messages: [message('user', prompt)],
        stream: false,
        response_format: { type: 'json_object' },
      };
      const raw = await requestJson(config, '/chat/completions', payload);
      const response = normalizeChatResponse(raw);
      return Object.freeze({ ...response, value: parseSafeJson(response.text, 'AI JSON response') });
    },
    async embed(input, model = config.model) {
      const raw = await requestJson(config, '/embeddings', {
        model: requireModel(model),
        input: normalizeEmbeddingInput(input),
      });
      const vectors = Array.isArray(raw?.data)
        ? raw.data.map(item => Object.freeze(Array.isArray(item?.embedding) ? item.embedding.map(Number) : []))
        : [];
      return Object.freeze({ vectors: Object.freeze(vectors), usage: freezeRecord(raw?.usage), raw });
    },
    async stream(messages, onToken, model = config.model) {
      if (typeof onToken !== 'function') {
        throw new KuraAiError('Kura.ai.stream needs a token handler function.', { code: 'KR-AI-0201' });
      }
      const payload = {
        model: requireModel(model),
        messages: normalizeMessages(messages),
        stream: true,
      };
      const result = await requestStream(config, '/chat/completions', payload, onToken);
      return Object.freeze(result);
    },
    async agent(messages, tools, maxSteps = DEFAULT_MAX_AGENT_STEPS, model = config.model) {
      const normalizedTools = normalizeTools(tools);
      const conversation = [...normalizeMessages(messages)];
      const limit = clampInteger(maxSteps, 1, 32, 'maxSteps');
      for (let step = 0; step < limit; step++) {
        const payload = {
          model: requireModel(model),
          messages: conversation,
          tools: normalizedTools.map(item => item.definition),
          stream: false,
        };
        const raw = await requestJson(config, '/chat/completions', payload);
        const choice = raw?.choices?.[0]?.message ?? {};
        const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
        if (!toolCalls.length) return normalizeChatResponse(raw);
        conversation.push(Object.freeze({ role: 'assistant', content: choice.content ?? '', tool_calls: toolCalls }));
        for (const call of toolCalls) {
          const name = String(call?.function?.name ?? '');
          const selected = normalizedTools.find(item => item.name === name);
          if (!selected) throw new KuraAiError(`The model requested an unknown tool '${name}'.`, { code: 'KR-AI-0301' });
          let args;
          try { args = parseSafeJson(String(call?.function?.arguments ?? '{}'), `arguments for tool '${name}'`); }
          catch (error) { throw new KuraAiError(error.message, { code: 'KR-AI-0302' }); }
          const value = await selected.handler(args);
          conversation.push(Object.freeze({
            role: 'tool',
            tool_call_id: String(call?.id ?? ''),
            content: typeof value === 'string' ? value : JSON.stringify(value),
          }));
        }
      }
      throw new KuraAiError(`The agent exceeded ${limit} tool steps.`, { code: 'KR-AI-0303' });
    },
  };
  return Object.freeze(client);
}

export const Kura = Object.freeze({ ai: createAiNamespace() });

export function message(role, content) {
  const normalizedRole = String(role).trim().toLowerCase();
  if (!ALLOWED_ROLES.has(normalizedRole) || normalizedRole === 'tool') {
    throw new KuraAiError(`Unsupported AI message role '${role}'.`, { code: 'KR-AI-0101' });
  }
  return Object.freeze({ role: normalizedRole, content: safeText(content, 'message content') });
}

export function schema(jsonText) {
  const value = typeof jsonText === 'string' ? parseSafeJson(jsonText, 'tool schema') : validateJsonValue(jsonText, 'tool schema');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KuraAiError('A tool schema must be a JSON object.', { code: 'KR-AI-0102' });
  }
  return deepFreeze(value);
}

export function tool(name, description, parameters, handler) {
  const safeName = String(name).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(safeName)) {
    throw new KuraAiError(`Invalid AI tool name '${name}'.`, { code: 'KR-AI-0103' });
  }
  if (typeof handler !== 'function') {
    throw new KuraAiError(`AI tool '${safeName}' needs a handler function.`, { code: 'KR-AI-0104' });
  }
  const parameterSchema = schema(parameters);
  return Object.freeze({
    name: safeName,
    handler,
    definition: deepFreeze({
      type: 'function',
      function: {
        name: safeName,
        description: safeText(description, 'tool description', 4_096),
        parameters: parameterSchema,
      },
    }),
  });
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) throw new KuraAiError('Agent tools must be an array.', { code: 'KR-AI-0304' });
  const names = new Set();
  return tools.map(item => {
    if (!item || typeof item !== 'object' || typeof item.handler !== 'function' || !item.definition) {
      throw new KuraAiError('Every agent tool must be created with Kura.ai.tool().', { code: 'KR-AI-0305' });
    }
    if (names.has(item.name)) throw new KuraAiError(`Duplicate AI tool '${item.name}'.`, { code: 'KR-AI-0306' });
    names.add(item.name);
    return item;
  });
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new KuraAiError('AI messages must be a non-empty array.', { code: 'KR-AI-0105' });
  }
  if (messages.length > 4_096) throw new KuraAiError('AI messages exceed the safe limit of 4096 entries.', { code: 'KR-AI-0106' });
  return messages.map((item, index) => {
    if (!item || typeof item !== 'object') throw new KuraAiError(`AI message ${index + 1} is not an object.`, { code: 'KR-AI-0107' });
    const role = String(item.role ?? '').toLowerCase();
    if (!ALLOWED_ROLES.has(role)) throw new KuraAiError(`AI message ${index + 1} has invalid role '${role}'.`, { code: 'KR-AI-0108' });
    const result = { role, content: item.content == null ? '' : safeText(item.content, `message ${index + 1} content`, 2_000_000) };
    if (role === 'tool') result.tool_call_id = safeText(item.tool_call_id, 'tool call id', 512);
    if (Array.isArray(item.tool_calls)) result.tool_calls = item.tool_calls;
    return Object.freeze(result);
  });
}

function normalizeEmbeddingInput(input) {
  if (typeof input === 'string') return safeText(input, 'embedding input', 2_000_000);
  if (Array.isArray(input)) {
    if (input.length > 2_048) throw new KuraAiError('Embedding input exceeds 2048 items.', { code: 'KR-AI-0401' });
    return input.map((item, index) => safeText(item, `embedding input ${index + 1}`, 2_000_000));
  }
  throw new KuraAiError('Embedding input must be text or an array of text.', { code: 'KR-AI-0402' });
}

function normalizeChatResponse(raw) {
  const messageValue = raw?.choices?.[0]?.message ?? {};
  const text = typeof messageValue.content === 'string'
    ? messageValue.content
    : Array.isArray(messageValue.content)
      ? messageValue.content.map(item => item?.text ?? item?.content ?? '').join('')
      : '';
  return Object.freeze({
    text,
    message: freezeRecord(messageValue),
    toolCalls: Object.freeze(Array.isArray(messageValue.tool_calls) ? messageValue.tool_calls : []),
    usage: freezeRecord(raw?.usage),
    id: String(raw?.id ?? ''),
    model: String(raw?.model ?? ''),
    raw,
  });
}

async function requestJson(config, pathname, payload) {
  const response = await requestWithRetry(config, pathname, payload, false);
  const text = await readResponseText(response, config.maxResponseBytes);
  if (!response.ok) throw responseError(response, text);
  try { return parseSafeJson(text, 'AI provider response'); }
  catch (error) { throw new KuraAiError(`The AI provider returned invalid JSON: ${error.message}`, { code: 'KR-AI-0501', status: response.status }); }
}

async function requestStream(config, pathname, payload, onToken) {
  const response = await requestWithRetry(config, pathname, payload, true);
  if (!response.ok) throw responseError(response, await readResponseText(response, config.maxResponseBytes));
  if (!response.body) throw new KuraAiError('The AI provider returned no response stream.', { code: 'KR-AI-0502' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > config.maxResponseBytes) throw new KuraAiError('The AI stream exceeded the configured response limit.', { code: 'KR-AI-0503' });
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll('\r\n', '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          const parsed = parseSafeJson(data, 'AI stream event');
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) {
            text += delta;
            await onToken(delta);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text, bytes };
}

async function requestWithRetry(config, pathname, payload, stream) {
  const endpoint = new URL(pathname.replace(/^\/+/, ''), `${config.baseUrl}/`);
  const headers = { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  let lastError;
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
      });
      if (![408, 409, 429, 500, 502, 503, 504].includes(response.status) || attempt === config.retries) return response;
      await response.body?.cancel();
      await delay(backoff(attempt));
    } catch (error) {
      lastError = error;
      if (attempt === config.retries) break;
      await delay(backoff(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError?.name === 'AbortError') {
    throw new KuraAiError(`The AI request timed out after ${config.timeoutMs} ms.`, { code: 'KR-AI-0504', retryable: true });
  }
  throw new KuraAiError(`The AI request failed: ${redact(String(lastError?.message ?? lastError ?? 'unknown network error'))}`, { code: 'KR-AI-0505', retryable: true });
}

function responseError(response, body) {
  const safeBody = redact(String(body)).replace(/\s+/g, ' ').slice(0, 1_024);
  return new KuraAiError(`AI provider returned HTTP ${response.status}${safeBody ? `: ${safeBody}` : ''}`, {
    code: 'KR-AI-0506', status: response.status, retryable: response.status === 429 || response.status >= 500,
  });
}

async function readResponseText(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new KuraAiError('The AI response exceeded the configured response limit.', { code: 'KR-AI-0507' });
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); }
  catch { throw new KuraAiError(`Invalid AI base URL '${raw}'.`, { code: 'KR-AI-0002' }); }
  if (url.username || url.password) throw new KuraAiError('AI base URLs must not contain credentials.', { code: 'KR-AI-0003' });
  const localhost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) {
    throw new KuraAiError('AI endpoints must use HTTPS. HTTP is allowed only for localhost.', { code: 'KR-AI-0004' });
  }
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/$/, '');
}

function requireModel(model) {
  const value = String(model ?? '').trim();
  if (!value) throw new KuraAiError('No AI model was configured.', { code: 'KR-AI-0005' });
  if (value.length > 256 || /[\0-\x1f\x7f]/.test(value)) throw new KuraAiError('The AI model name is invalid.', { code: 'KR-AI-0006' });
  return value;
}

function parseSafeJson(text, label) {
  let value;
  try { value = JSON.parse(String(text)); }
  catch (error) { throw new KuraAiError(`${label} is not valid JSON: ${error.message}`, { code: 'KR-AI-0601' }); }
  return validateJsonValue(value, label);
}

function validateJsonValue(value, label, depth = 0) {
  if (depth > 64) throw new KuraAiError(`${label} is nested too deeply.`, { code: 'KR-AI-0602' });
  if (Array.isArray(value)) {
    if (value.length > 100_000) throw new KuraAiError(`${label} contains too many array entries.`, { code: 'KR-AI-0603' });
    value.forEach(item => validateJsonValue(item, label, depth + 1));
    return value;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) throw new KuraAiError(`${label} contains forbidden key '${key}'.`, { code: 'KR-AI-0604' });
      validateJsonValue(child, label, depth + 1);
    }
  }
  return value;
}

function safeText(value, label, maximum = 1_000_000) {
  const text = String(value ?? '');
  if (text.length > maximum) throw new KuraAiError(`${label} exceeds ${maximum.toLocaleString()} characters.`, { code: 'KR-AI-0605' });
  if (text.includes('\0')) throw new KuraAiError(`${label} contains a null character.`, { code: 'KR-AI-0606' });
  return text;
}

function freezeRecord(value) {
  if (!value || typeof value !== 'object') return Object.freeze({});
  return deepFreeze(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function readEnv(name) {
  return globalThis.process?.env?.[name] ?? null;
}

function clampInteger(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new KuraAiError(`${label} must be an integer from ${minimum} to ${maximum}.`, { code: 'KR-AI-0607' });
  }
  return number;
}

function backoff(attempt) {
  return Math.min(5_000, 150 * (2 ** attempt) + Math.floor(Math.random() * 100));
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]');
}
