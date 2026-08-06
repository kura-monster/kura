// SPDX-License-Identifier: MIT OR Apache-2.0
import { createHash } from 'node:crypto';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const COMPONENT_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export class OpenApiError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'OpenApiError';
    this.code = options.code ?? 'KR-OPENAPI-0001';
  }
}

export class OpenApiBuilder {
  constructor(options = {}) {
    this.document = {
      openapi: options.openapi ?? '3.1.0',
      info: {
        title: options.title ?? 'Kura API',
        version: options.version ?? '1.0.0',
        ...(options.description ? { description: options.description } : {}),
        ...(options.termsOfService ? { termsOfService: options.termsOfService } : {}),
        ...(options.contact ? { contact: { ...options.contact } } : {}),
        ...(options.license ? { license: { ...options.license } } : {}),
      },
      jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
      servers: [],
      tags: [],
      paths: {},
      components: { schemas: {}, securitySchemes: {}, responses: {}, parameters: {}, headers: {}, examples: {} },
      security: options.security ?? [],
    };
    this.operationIds = new Set();
  }

  server(url, description = undefined, variables = undefined) {
    const parsed = String(url);
    if (!parsed) throw new OpenApiError('Server URL is required.', { code: 'KR-OPENAPI-0101' });
    this.document.servers.push(compact({ url: parsed, description, variables }));
    return this;
  }

  tag(name, options = {}) {
    if (!name) throw new OpenApiError('Tag name is required.', { code: 'KR-OPENAPI-0102' });
    if (!this.document.tags.some(tag => tag.name === name)) this.document.tags.push(compact({ name: String(name), description: options.description, externalDocs: options.externalDocs }));
    return this;
  }

  schema(name, schema, options = {}) {
    assertComponentName(name);
    const jsonSchema = normalizeSchema(schema, options);
    this.document.components.schemas[name] = jsonSchema;
    return this;
  }

  securityScheme(name, scheme) {
    assertComponentName(name);
    if (!scheme || typeof scheme !== 'object') throw new OpenApiError('Security scheme must be an object.', { code: 'KR-OPENAPI-0103' });
    this.document.components.securitySchemes[name] = structuredClone(scheme);
    return this;
  }

  response(name, response) {
    assertComponentName(name);
    this.document.components.responses[name] = normalizeResponse(response);
    return this;
  }

  route(method, routePath, options = {}) {
    const normalizedMethod = String(method).toLowerCase();
    if (!HTTP_METHODS.has(normalizedMethod)) throw new OpenApiError(`Unsupported HTTP method '${method}'.`, { code: 'KR-OPENAPI-0201' });
    const path = normalizePath(routePath);
    const operationId = options.operationId ?? generatedOperationId(normalizedMethod, path);
    if (this.operationIds.has(operationId)) throw new OpenApiError(`Duplicate operationId '${operationId}'.`, { code: 'KR-OPENAPI-0202' });
    this.operationIds.add(operationId);
    const parameters = [];
    for (const item of options.parameters ?? []) parameters.push(normalizeParameter(item));
    for (const name of extractPathParameters(path)) {
      if (!parameters.some(parameter => parameter.in === 'path' && parameter.name === name)) {
        parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
      }
    }
    const operation = compact({
      operationId,
      summary: options.summary,
      description: options.description,
      tags: options.tags,
      deprecated: options.deprecated || undefined,
      parameters: parameters.length ? parameters : undefined,
      requestBody: options.requestBody ? normalizeRequestBody(options.requestBody) : undefined,
      responses: normalizeResponses(options.responses ?? { 200: { description: 'Successful response' } }),
      security: options.security,
      callbacks: options.callbacks,
      externalDocs: options.externalDocs,
      servers: options.servers,
      'x-kura-handler': options.handlerName,
    });
    this.document.paths[path] ??= {};
    this.document.paths[path][normalizedMethod] = operation;
    return this;
  }

  get(path, options) { return this.route('get', path, options); }
  post(path, options) { return this.route('post', path, options); }
  put(path, options) { return this.route('put', path, options); }
  patch(path, options) { return this.route('patch', path, options); }
  delete(path, options) { return this.route('delete', path, options); }

  webhook(name, method, options) {
    this.document.webhooks ??= {};
    const path = normalizePath(name);
    this.document.webhooks[path] ??= {};
    this.document.webhooks[path][String(method).toLowerCase()] = this.#operationForWebhook(method, path, options);
    return this;
  }

  build(options = {}) {
    const output = structuredClone(this.document);
    if (!output.servers.length) delete output.servers;
    if (!output.tags.length) delete output.tags;
    for (const [section, values] of Object.entries(output.components)) if (!Object.keys(values).length) delete output.components[section];
    if (!Object.keys(output.components).length) delete output.components;
    if (!output.security?.length) delete output.security;
    sortDocument(output);
    if (options.validate !== false) validateOpenApiDocument(output);
    return Object.freeze(output);
  }

  json(options = {}) {
    return `${JSON.stringify(this.build(options), null, options.compact ? 0 : 2)}\n`;
  }

  checksum() {
    return createHash('sha256').update(this.json({ compact: true })).digest('hex');
  }

  docsHtml(options = {}) {
    return swaggerUiHtml(this.build(), options);
  }

  client(options = {}) {
    return generateClient(this.build(), options);
  }

  #operationForWebhook(method, path, options = {}) {
    const parameters = (options.parameters ?? []).map(normalizeParameter);
    return compact({
      operationId: options.operationId ?? generatedOperationId(method, path),
      summary: options.summary,
      description: options.description,
      parameters: parameters.length ? parameters : undefined,
      requestBody: options.requestBody ? normalizeRequestBody(options.requestBody) : undefined,
      responses: normalizeResponses(options.responses ?? { 200: { description: 'Webhook accepted' } }),
    });
  }
}

export function createOpenApi(options = {}) { return new OpenApiBuilder(options); }

export function jsonBody(schema, options = {}) {
  return {
    required: options.required !== false,
    description: options.description,
    content: {
      'application/json': compact({ schema: normalizeSchema(schema), example: options.example, examples: options.examples }),
    },
  };
}

export function formBody(schema, options = {}) {
  return {
    required: options.required !== false,
    description: options.description,
    content: {
      [options.multipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded']: compact({ schema: normalizeSchema(schema), encoding: options.encoding }),
    },
  };
}

export function jsonResponse(schema, options = {}) {
  return {
    description: options.description ?? 'Successful response',
    headers: options.headers,
    content: {
      'application/json': compact({ schema: normalizeSchema(schema), example: options.example, examples: options.examples }),
    },
  };
}

export function errorResponse(description = 'Request failed', options = {}) {
  return jsonResponse(options.schema ?? {
    type: 'object',
    required: ['error', 'message'],
    properties: {
      error: { type: 'string' },
      message: { type: 'string' },
      requestId: { type: ['string', 'null'] },
      details: {},
    },
  }, { description, example: options.example });
}

export function parameter(name, location, schema, options = {}) {
  if (!['path', 'query', 'header', 'cookie'].includes(location)) throw new OpenApiError(`Invalid parameter location '${location}'.`, { code: 'KR-OPENAPI-0301' });
  return compact({
    name: String(name),
    in: location,
    required: location === 'path' ? true : Boolean(options.required),
    description: options.description,
    deprecated: options.deprecated || undefined,
    allowEmptyValue: options.allowEmptyValue || undefined,
    style: options.style,
    explode: options.explode,
    schema: normalizeSchema(schema),
    example: options.example,
    examples: options.examples,
  });
}

export function bearerAuth(options = {}) {
  return compact({ type: 'http', scheme: 'bearer', bearerFormat: options.format ?? 'JWT', description: options.description });
}
export function basicAuth(options = {}) { return compact({ type: 'http', scheme: 'basic', description: options.description }); }
export function apiKeyAuth(name = 'X-API-Key', location = 'header', options = {}) { return compact({ type: 'apiKey', name, in: location, description: options.description }); }
export function oauth2(flows, options = {}) { return compact({ type: 'oauth2', flows: structuredClone(flows), description: options.description }); }
export function openIdConnect(url, options = {}) { return compact({ type: 'openIdConnect', openIdConnectUrl: url, description: options.description }); }

export function serveOpenApi(builder, options = {}) {
  const specPath = options.specPath ?? '/openapi.json';
  const docsPath = options.docsPath ?? '/docs';
  return async context => {
    const path = context.path ?? context.url?.pathname;
    if (path === specPath) return response(200, 'application/json; charset=utf-8', builder.json());
    if (path === docsPath || path === `${docsPath}/`) return response(200, 'text/html; charset=utf-8', builder.docsHtml({ specUrl: specPath, title: options.title }));
    return null;
  };
}

export function swaggerUiHtml(spec, options = {}) {
  const title = escapeHtml(options.title ?? spec.info?.title ?? 'API documentation');
  const specUrl = options.specUrl ?? null;
  const inlineSpec = specUrl ? 'null' : safeJsonForHtml(spec);
  const cdn = options.cdn ?? 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5';
  const customCss = options.css ?? '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="${escapeHtml(cdn)}/swagger-ui.css">
  <style>html{box-sizing:border-box;overflow-y:scroll}*,*:before,*:after{box-sizing:inherit}body{margin:0;background:#fafafa}${customCss}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${escapeHtml(cdn)}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
  <script>
    const spec = ${inlineSpec};
    SwaggerUIBundle({
      ${specUrl ? `url:${JSON.stringify(specUrl)},` : 'spec,'}
      dom_id:'#swagger-ui',
      deepLinking:true,
      displayRequestDuration:true,
      persistAuthorization:false,
      tryItOutEnabled:${options.tryItOut !== false},
      supportedSubmitMethods:${safeJsonForHtml(options.supportedMethods ?? ['get','post','put','patch','delete'])}
    });
  </script>
</body>
</html>`;
}

export function generateClient(spec, options = {}) {
  const className = options.className ?? 'KuraApiClient';
  const operations = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      operations.push({ path, method: method.toUpperCase(), operation });
    }
  }
  const methods = operations.map(({ path, method, operation }) => {
    const name = safeMethodName(operation.operationId ?? generatedOperationId(method, path));
    const pathParameters = extractPathParameters(path);
    return `  async ${name}(options = {}) {
    let path = ${JSON.stringify(path)};
${pathParameters.map(parameter => `    if (options.path?.${parameter} === undefined) throw new Error(${JSON.stringify(`Missing path parameter: ${parameter}`)});
    path = path.replace(${JSON.stringify(`{${parameter}}`)}, encodeURIComponent(String(options.path.${parameter})));`).join('\n')}
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
    const response = await this.fetch(url, {
      method: ${JSON.stringify(method)},
      headers: { accept: 'application/json', ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...this.headers, ...(options.headers ?? {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await response.text();
    let data = text;
    if ((response.headers.get('content-type') ?? '').includes('json') && text) data = JSON.parse(text);
    if (!response.ok) { const error = new Error(data?.message ?? 'HTTP ' + response.status); error.status = response.status; error.data = data; throw error; }
    return data;
  }`;
  }).join('\n\n');
  return `// Generated by Kura OpenAPI client generator
export class ${className} {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? ${JSON.stringify(spec.servers?.[0]?.url ?? 'http://localhost:3000')};
    this.headers = options.headers ?? {};
    this.fetch = options.fetch ?? globalThis.fetch;
  }

${methods}
}
`;
}

export function validateOpenApiDocument(document) {
  const issues = [];
  if (!/^3\.1\./.test(document.openapi ?? '')) issues.push('openapi must be a 3.1.x version');
  if (!document.info?.title) issues.push('info.title is required');
  if (!document.info?.version) issues.push('info.version is required');
  if (!document.paths || typeof document.paths !== 'object') issues.push('paths must be an object');
  const operationIds = new Set();
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!path.startsWith('/')) issues.push(`path '${path}' must start with /`);
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation.responses || !Object.keys(operation.responses).length) issues.push(`${method.toUpperCase()} ${path} has no responses`);
      if (operation.operationId) {
        if (operationIds.has(operation.operationId)) issues.push(`duplicate operationId '${operation.operationId}'`);
        operationIds.add(operation.operationId);
      }
      for (const parameterName of extractPathParameters(path)) {
        if (!(operation.parameters ?? []).some(parameter => parameter.in === 'path' && parameter.name === parameterName && parameter.required === true)) issues.push(`${method.toUpperCase()} ${path} is missing required path parameter '${parameterName}'`);
      }
    }
  }
  if (issues.length) throw new OpenApiError(`OpenAPI document is invalid:\n- ${issues.join('\n- ')}`, { code: 'KR-OPENAPI-0401' });
  return true;
}

function normalizeSchema(schema, options = {}) {
  if (schema?.toJSONSchema) return schema.toJSONSchema(options);
  if (typeof schema === 'string') return { $ref: schema.startsWith('#/') ? schema : `#/components/schemas/${schema}` };
  if (!schema || typeof schema !== 'object') return {};
  return structuredClone(schema);
}
function normalizeParameter(value) { if (!value || typeof value !== 'object') throw new OpenApiError('Parameter must be an object.', { code: 'KR-OPENAPI-0302' }); const output = structuredClone(value); if (output.schema) output.schema = normalizeSchema(output.schema); if (output.in === 'path') output.required = true; return output; }
function normalizeRequestBody(value) { const output = structuredClone(value); for (const media of Object.values(output.content ?? {})) if (media.schema) media.schema = normalizeSchema(media.schema); return output; }
function normalizeResponse(value) { if (typeof value === 'string') return { description: value }; const output = structuredClone(value ?? {}); output.description ??= 'Response'; for (const media of Object.values(output.content ?? {})) if (media.schema) media.schema = normalizeSchema(media.schema); return output; }
function normalizeResponses(values) { return Object.fromEntries(Object.entries(values).map(([status, value]) => [String(status), normalizeResponse(value)])); }
function normalizePath(value) { let path = String(value); if (!path.startsWith('/')) path = `/${path}`; path = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}'); if (/\*[^/]+/.test(path)) path = path.replace(/\*([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}'); return path.replace(/\/+/g, '/'); }
function extractPathParameters(path) { return [...String(path).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match => match[1]); }
function generatedOperationId(method, path) { return `${String(method).toLowerCase()}_${String(path).replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root'}`; }
function safeMethodName(value) { const name = String(value).replace(/[^A-Za-z0-9_$]+/g, '_'); return /^[A-Za-z_$]/.test(name) ? name : `operation_${name}`; }
function assertComponentName(name) { if (!COMPONENT_NAME.test(String(name))) throw new OpenApiError(`Invalid component name '${name}'.`, { code: 'KR-OPENAPI-0104' }); }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== false)); }
function sortDocument(document) { document.paths = Object.fromEntries(Object.entries(document.paths).sort(([a], [b]) => a.localeCompare(b))); if (document.components) for (const key of Object.keys(document.components)) document.components[key] = Object.fromEntries(Object.entries(document.components[key]).sort(([a], [b]) => a.localeCompare(b))); }
function response(status, contentType, body) { return { status, headers: { 'content-type': contentType, 'cache-control': 'no-store' }, body }; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function safeJsonForHtml(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
