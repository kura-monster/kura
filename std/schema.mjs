// SPDX-License-Identifier: MIT OR Apache-2.0

export class ValidationError extends Error {
  constructor(issues, message = 'Validation failed.') {
    super(message);
    this.name = 'ValidationError';
    this.code = 'KR-SCHEMA-0001';
    this.issues = Object.freeze(issues.map(issue => Object.freeze({ ...issue, path: Object.freeze([...(issue.path ?? [])]) })));
  }

  format() {
    return this.issues.map(issue => `${formatPath(issue.path)}: ${issue.message}`).join('\n');
  }

  toJSON() {
    return { error: 'validation_failed', issues: this.issues };
  }
}

export class Schema {
  constructor(parser, jsonSchema, options = {}) {
    this._parser = parser;
    this._jsonSchema = jsonSchema;
    this.description = options.description ?? null;
    this.example = options.example;
    this.defaultValue = options.defaultValue;
    Object.freeze(this);
  }

  parse(value) {
    const issues = [];
    const output = this._parser(value, [], issues);
    if (issues.length) throw new ValidationError(issues);
    return output;
  }

  safeParse(value) {
    try { return Object.freeze({ success: true, data: this.parse(value), error: null }); }
    catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return Object.freeze({ success: false, data: null, error });
    }
  }

  optional() { return optional(this); }
  nullable() { return nullable(this); }
  array(options = {}) { return array(this, options); }
  default(value) { return withDefault(this, value); }
  transform(fn) { return transform(this, fn); }
  refine(predicate, message = 'Value did not satisfy the required condition.') { return refine(this, predicate, message); }
  describe(description) { return decorate(this, { description }); }
  example(value) { return decorate(this, { example: value }); }
  toJSONSchema(options = {}) { return finalizeJsonSchema(this._jsonSchema, this, options); }
}

export function string(options = {}) {
  const minLength = options.minLength ?? options.min ?? null;
  const maxLength = options.maxLength ?? options.max ?? null;
  const pattern = options.pattern instanceof RegExp ? options.pattern : options.pattern ? new RegExp(options.pattern) : null;
  const enumValues = options.enum ? new Set(options.enum.map(String)) : null;
  const trim = Boolean(options.trim);
  const lower = Boolean(options.lowercase);
  const upper = Boolean(options.uppercase);
  const format = options.format ?? null;
  return new Schema((value, path, issues) => {
    if (typeof value !== 'string') { issue(issues, path, 'Expected a string.', 'invalid_type', 'string', typeof value); return value; }
    let output = value;
    if (trim) output = output.trim();
    if (lower) output = output.toLowerCase();
    if (upper) output = output.toUpperCase();
    if (minLength !== null && output.length < minLength) issue(issues, path, `Expected at least ${minLength} characters.`, 'too_small', minLength, output.length);
    if (maxLength !== null && output.length > maxLength) issue(issues, path, `Expected at most ${maxLength} characters.`, 'too_big', maxLength, output.length);
    if (pattern && !pattern.test(output)) issue(issues, path, 'String does not match the required pattern.', 'invalid_string', pattern.source, output);
    if (enumValues && !enumValues.has(output)) issue(issues, path, `Expected one of: ${[...enumValues].join(', ')}.`, 'invalid_enum', [...enumValues], output);
    if (format && !formatValidators[format]?.(output)) issue(issues, path, `Expected a valid ${format}.`, 'invalid_format', format, output);
    return output;
  }, compact({ type: 'string', minLength, maxLength, pattern: pattern?.source, enum: enumValues ? [...enumValues] : undefined, format }));
}

export function number(options = {}) {
  const minimum = options.minimum ?? options.min ?? null;
  const maximum = options.maximum ?? options.max ?? null;
  const integerOnly = Boolean(options.integer);
  const finite = options.finite !== false;
  const coerce = Boolean(options.coerce);
  const multipleOf = options.multipleOf ?? null;
  return new Schema((value, path, issues) => {
    const output = coerce && typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof output !== 'number' || (finite && !Number.isFinite(output))) { issue(issues, path, 'Expected a number.', 'invalid_type', 'number', typeof output); return output; }
    if (integerOnly && !Number.isInteger(output)) issue(issues, path, 'Expected an integer.', 'invalid_number', 'integer', output);
    if (minimum !== null && output < minimum) issue(issues, path, `Expected a value greater than or equal to ${minimum}.`, 'too_small', minimum, output);
    if (maximum !== null && output > maximum) issue(issues, path, `Expected a value less than or equal to ${maximum}.`, 'too_big', maximum, output);
    if (multipleOf !== null && Math.abs(output / multipleOf - Math.round(output / multipleOf)) > Number.EPSILON) issue(issues, path, `Expected a multiple of ${multipleOf}.`, 'not_multiple', multipleOf, output);
    return output;
  }, compact({ type: integerOnly ? 'integer' : 'number', minimum, maximum, multipleOf }));
}

export function integer(options = {}) { return number({ ...options, integer: true }); }
export function boolean(options = {}) {
  const coerce = Boolean(options.coerce);
  return new Schema((value, path, issues) => {
    let output = value;
    if (coerce && typeof value === 'string') {
      if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) output = true;
      else if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) output = false;
    }
    if (typeof output !== 'boolean') issue(issues, path, 'Expected a boolean.', 'invalid_type', 'boolean', typeof output);
    return output;
  }, { type: 'boolean' });
}

export function bigint(options = {}) {
  const coerce = Boolean(options.coerce);
  return new Schema((value, path, issues) => {
    try {
      const output = coerce && (typeof value === 'string' || typeof value === 'number') ? BigInt(value) : value;
      if (typeof output !== 'bigint') issue(issues, path, 'Expected a bigint.', 'invalid_type', 'bigint', typeof output);
      return output;
    } catch { issue(issues, path, 'Expected a valid bigint.', 'invalid_bigint', 'bigint', value); return value; }
  }, { type: 'integer', format: 'int64' });
}

export function date(options = {}) {
  const coerce = options.coerce !== false;
  return new Schema((value, path, issues) => {
    const output = value instanceof Date ? new Date(value.getTime()) : coerce ? new Date(value) : value;
    if (!(output instanceof Date) || Number.isNaN(output.getTime())) { issue(issues, path, 'Expected a valid date.', 'invalid_date', 'date', value); return value; }
    if (options.min && output < new Date(options.min)) issue(issues, path, `Date must be on or after ${new Date(options.min).toISOString()}.`, 'too_small', options.min, output);
    if (options.max && output > new Date(options.max)) issue(issues, path, `Date must be on or before ${new Date(options.max).toISOString()}.`, 'too_big', options.max, output);
    return output;
  }, { type: 'string', format: 'date-time' });
}

export function literal(expected) {
  return new Schema((value, path, issues) => {
    if (!Object.is(value, expected)) issue(issues, path, `Expected ${JSON.stringify(expected)}.`, 'invalid_literal', expected, value);
    return value;
  }, { const: expected, type: jsonType(expected) });
}

export function enumeration(values) {
  const list = [...values];
  if (!list.length) throw new TypeError('enumeration requires at least one value');
  return new Schema((value, path, issues) => {
    if (!list.some(item => Object.is(item, value))) issue(issues, path, `Expected one of: ${list.map(item => JSON.stringify(item)).join(', ')}.`, 'invalid_enum', list, value);
    return value;
  }, { enum: list, type: sharedJsonType(list) });
}

export function array(itemSchema, options = {}) {
  assertSchema(itemSchema);
  const minimum = options.minLength ?? options.min ?? null;
  const maximum = options.maxLength ?? options.max ?? null;
  const unique = Boolean(options.unique);
  return new Schema((value, path, issues) => {
    if (!Array.isArray(value)) { issue(issues, path, 'Expected an array.', 'invalid_type', 'array', typeof value); return value; }
    if (minimum !== null && value.length < minimum) issue(issues, path, `Expected at least ${minimum} items.`, 'too_small', minimum, value.length);
    if (maximum !== null && value.length > maximum) issue(issues, path, `Expected at most ${maximum} items.`, 'too_big', maximum, value.length);
    const output = value.map((item, index) => itemSchema._parser(item, [...path, index], issues));
    if (unique) {
      const seen = new Set();
      for (let index = 0; index < output.length; index++) {
        const key = stableStringify(output[index]);
        if (seen.has(key)) issue(issues, [...path, index], 'Array items must be unique.', 'duplicate', 'unique', output[index]);
        seen.add(key);
      }
    }
    return output;
  }, compact({ type: 'array', items: itemSchema._jsonSchema, minItems: minimum, maxItems: maximum, uniqueItems: unique || undefined }));
}

export function tuple(items, options = {}) {
  const schemas = [...items];
  schemas.forEach(assertSchema);
  return new Schema((value, path, issues) => {
    if (!Array.isArray(value)) { issue(issues, path, 'Expected a tuple.', 'invalid_type', 'array', typeof value); return value; }
    if (value.length !== schemas.length && !options.rest) issue(issues, path, `Expected exactly ${schemas.length} items.`, 'invalid_length', schemas.length, value.length);
    const output = schemas.map((schema, index) => schema._parser(value[index], [...path, index], issues));
    if (options.rest) {
      assertSchema(options.rest);
      for (let index = schemas.length; index < value.length; index++) output.push(options.rest._parser(value[index], [...path, index], issues));
    }
    return output;
  }, compact({ type: 'array', prefixItems: schemas.map(schema => schema._jsonSchema), minItems: schemas.length, maxItems: options.rest ? undefined : schemas.length, items: options.rest?._jsonSchema ?? false }));
}

export function object(shape, options = {}) {
  const entries = Object.entries(shape ?? {});
  for (const [, schema] of entries) assertSchema(schema);
  const unknown = options.unknown ?? 'strip';
  if (!['strip', 'passthrough', 'strict'].includes(unknown)) throw new TypeError("object unknown mode must be 'strip', 'passthrough', or 'strict'");
  const required = entries.filter(([, schema]) => !schema._optional && !schema._hasDefault).map(([key]) => key);
  return new Schema((value, path, issues) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { issue(issues, path, 'Expected an object.', 'invalid_type', 'object', Array.isArray(value) ? 'array' : typeof value); return value; }
    const output = {};
    for (const [key, schema] of entries) {
      if (!Object.hasOwn(value, key)) {
        if (schema._hasDefault) output[key] = cloneValue(schema.defaultValue);
        else if (!schema._optional) issue(issues, [...path, key], 'Required field is missing.', 'required', true, undefined);
        continue;
      }
      output[key] = schema._parser(value[key], [...path, key], issues);
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(shape, key)) continue;
      if (blockedKeys.has(key)) { issue(issues, [...path, key], 'Prototype-related keys are not allowed.', 'unsafe_key', null, key); continue; }
      if (unknown === 'strict') issue(issues, [...path, key], 'Unknown field is not allowed.', 'unknown_key', Object.keys(shape), key);
      else if (unknown === 'passthrough') output[key] = item;
    }
    return output;
  }, compact({
    type: 'object',
    properties: Object.fromEntries(entries.map(([key, schema]) => [key, schema._jsonSchema])),
    required: required.length ? required : undefined,
    additionalProperties: unknown === 'strict' ? false : true,
  }));
}

export function record(valueSchema, options = {}) {
  assertSchema(valueSchema);
  const keyPattern = options.keyPattern instanceof RegExp ? options.keyPattern : options.keyPattern ? new RegExp(options.keyPattern) : null;
  return new Schema((value, path, issues) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { issue(issues, path, 'Expected a record object.', 'invalid_type', 'object', typeof value); return value; }
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (blockedKeys.has(key)) { issue(issues, [...path, key], 'Unsafe record key.', 'unsafe_key', null, key); continue; }
      if (keyPattern && !keyPattern.test(key)) issue(issues, [...path, key], 'Record key does not match the required pattern.', 'invalid_key', keyPattern.source, key);
      output[key] = valueSchema._parser(item, [...path, key], issues);
    }
    return output;
  }, compact({ type: 'object', additionalProperties: valueSchema._jsonSchema, propertyNames: keyPattern ? { pattern: keyPattern.source } : undefined }));
}

export function union(schemas) {
  const list = [...schemas];
  list.forEach(assertSchema);
  return new Schema((value, path, issues) => {
    const branchErrors = [];
    for (const schema of list) {
      const local = [];
      const output = schema._parser(value, path, local);
      if (!local.length) return output;
      branchErrors.push(local);
    }
    issue(issues, path, 'Value does not match any allowed schema.', 'invalid_union', list.length, value, { branches: branchErrors });
    return value;
  }, { anyOf: list.map(schema => schema._jsonSchema) });
}

export function intersection(left, right) {
  assertSchema(left); assertSchema(right);
  return new Schema((value, path, issues) => {
    const a = left._parser(value, path, issues);
    const b = right._parser(value, path, issues);
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) return { ...a, ...b };
    return b;
  }, { allOf: [left._jsonSchema, right._jsonSchema] });
}

export function optional(schema) {
  assertSchema(schema);
  const output = new Schema((value, path, issues) => value === undefined ? undefined : schema._parser(value, path, issues), { anyOf: [schema._jsonSchema, { type: 'null', 'x-kura-undefined': true }] });
  Object.defineProperty(output, '_optional', { value: true, enumerable: false });
  return output;
}

export function nullable(schema) {
  assertSchema(schema);
  return new Schema((value, path, issues) => value === null ? null : schema._parser(value, path, issues), { anyOf: [schema._jsonSchema, { type: 'null' }] });
}

export function withDefault(schema, value) {
  assertSchema(schema);
  const output = new Schema((input, path, issues) => schema._parser(input === undefined ? cloneValue(value) : input, path, issues), { ...schema._jsonSchema, default: value }, { defaultValue: value });
  Object.defineProperty(output, '_hasDefault', { value: true, enumerable: false });
  return output;
}

export function transform(schema, fn) {
  assertSchema(schema);
  if (typeof fn !== 'function') throw new TypeError('transform expects a function');
  return new Schema((value, path, issues) => {
    const before = issues.length;
    const output = schema._parser(value, path, issues);
    if (issues.length !== before) return output;
    try { return fn(output); }
    catch (error) { issue(issues, path, String(error?.message ?? error), 'transform_failed', null, output); return output; }
  }, schema._jsonSchema);
}

export function refine(schema, predicate, message = 'Value did not satisfy the required condition.') {
  assertSchema(schema);
  if (typeof predicate !== 'function') throw new TypeError('refine expects a function');
  return new Schema((value, path, issues) => {
    const before = issues.length;
    const output = schema._parser(value, path, issues);
    if (issues.length === before) {
      let valid = false;
      try { valid = Boolean(predicate(output)); } catch { valid = false; }
      if (!valid) issue(issues, path, message, 'custom', true, output);
    }
    return output;
  }, schema._jsonSchema);
}

export function lazy(factory) {
  let cached = null;
  return new Schema((value, path, issues) => {
    cached ??= factory();
    assertSchema(cached);
    return cached._parser(value, path, issues);
  }, { 'x-kura-lazy': true });
}

export function unknown() { return new Schema(value => value, {}); }
export function any() { return unknown(); }
export function never(message = 'Value is not allowed.') { return new Schema((value, path, issues) => { issue(issues, path, message, 'never', null, value); return value; }, false); }

export function validate(schema, value) { assertSchema(schema); return schema.parse(value); }
export function safeValidate(schema, value) { assertSchema(schema); return schema.safeParse(value); }

export function validationMiddleware(config = {}) {
  const schemas = {
    params: config.params ?? null,
    query: config.query ?? null,
    headers: config.headers ?? null,
    body: config.body ?? null,
  };
  for (const schema of Object.values(schemas)) if (schema) assertSchema(schema);
  return async (context, next) => {
    try {
      const validated = {};
      if (schemas.params) validated.params = schemas.params.parse(context.params ?? {});
      if (schemas.query) validated.query = schemas.query.parse(Object.fromEntries(context.url.searchParams.entries()));
      if (schemas.headers) validated.headers = schemas.headers.parse(Object.fromEntries(context.request.headers.entries?.() ?? Object.entries(context.request.headers ?? {})));
      if (schemas.body) {
        const contentType = String(context.request?.headers?.['content-type'] ?? context.request?.headers?.get?.('content-type') ?? '').toLowerCase();
        let body;
        if (contentType.includes('application/json')) body = await context.json();
        else if (contentType.includes('application/x-www-form-urlencoded')) body = await context.form();
        else body = await context.text();
        validated.body = schemas.body.parse(body);
      }
      context.validated = Object.freeze(validated);
      return next();
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return {
        status: 422,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(error.toJSON()),
      };
    }
  };
}

export const formats = Object.freeze({
  email: options => string({ ...options, format: 'email' }),
  url: options => string({ ...options, format: 'uri' }),
  uuid: options => string({ ...options, format: 'uuid' }),
  ipv4: options => string({ ...options, format: 'ipv4' }),
  ipv6: options => string({ ...options, format: 'ipv6' }),
  date: options => string({ ...options, format: 'date' }),
  datetime: options => string({ ...options, format: 'date-time' }),
  hostname: options => string({ ...options, format: 'hostname' }),
});

const blockedKeys = new Set(['__proto__', 'prototype', 'constructor']);
const formatValidators = {
  email: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254,
  uri: value => { try { const url = new URL(value); return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol); } catch { return false; } },
  uuid: value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  ipv4: value => { const parts = value.split('.'); return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255); },
  ipv6: value => /^[0-9a-f:]+$/i.test(value) && value.includes(':'),
  date: value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
  'date-time': value => !Number.isNaN(Date.parse(value)),
  hostname: value => value.length <= 253 && value.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)),
};

function issue(issues, path, message, code, expected, received, extra = {}) { issues.push({ path, message, code, expected, received, ...extra }); }
function assertSchema(value) { if (!(value instanceof Schema)) throw new TypeError('Expected a Kura Schema'); }
function formatPath(path) { return path.length ? path.map(part => typeof part === 'number' ? `[${part}]` : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`).join('').replace(/^\./, '') : '<root>'; }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined)); }
function decorate(schema, options) { assertSchema(schema); return new Schema(schema._parser, { ...schema._jsonSchema, ...(options.description ? { description: options.description } : {}), ...(options.example !== undefined ? { example: options.example } : {}) }, { description: options.description ?? schema.description, example: options.example ?? schema.example, defaultValue: schema.defaultValue }); }
function finalizeJsonSchema(base, schema, options) { const output = structuredClone(base); if (schema.description) output.description = schema.description; if (schema.example !== undefined) output.example = schema.example; if (schema._hasDefault) output.default = schema.defaultValue; if (options.title) output.title = options.title; if (options.id) output.$id = options.id; return output; }
function cloneValue(value) { return value && typeof value === 'object' ? structuredClone(value) : value; }
function jsonType(value) { if (value === null) return 'null'; if (Array.isArray(value)) return 'array'; if (Number.isInteger(value)) return 'integer'; return typeof value === 'number' ? 'number' : typeof value; }
function sharedJsonType(values) { const types = new Set(values.map(jsonType)); return types.size === 1 ? [...types][0] : undefined; }
function stableStringify(value) { return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
