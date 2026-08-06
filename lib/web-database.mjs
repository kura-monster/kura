// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_MIGRATION_NAME = /^[0-9]{4,20}[-_][A-Za-z0-9._-]+\.sql$/;

export class DatabaseError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'DatabaseError';
    this.code = options.code ?? 'KR-DB-0001';
    this.driver = options.driver ?? null;
    this.query = options.query ?? null;
    this.details = options.details ?? null;
  }
}

export function sql(strings, ...values) {
  if (!Array.isArray(strings) || !Object.hasOwn(strings, 'raw')) {
    throw new DatabaseError('sql must be used as a tagged template.', { code: 'KR-DB-0101' });
  }
  let text = '';
  for (let index = 0; index < strings.length; index++) {
    text += strings[index];
    if (index < values.length) text += `?`;
  }
  return Object.freeze({ text, values: Object.freeze([...values]) });
}

export function ident(value) {
  const parts = String(value).split('.');
  if (!parts.length || parts.some(part => !IDENTIFIER.test(part))) {
    throw new DatabaseError(`Unsafe SQL identifier '${value}'.`, {
      code: 'KR-DB-0102',
      details: 'Identifiers may contain letters, digits, and underscores and may not begin with a digit.',
    });
  }
  return parts.map(part => `"${part}"`).join('.');
}

export function raw(text) {
  const value = String(text);
  if (!value.trim()) throw new DatabaseError('Raw SQL cannot be empty.', { code: 'KR-DB-0103' });
  return Object.freeze({ __rawSql: value });
}

export function connect(url, driver = undefined) {
  return createDatabase({ url: String(url), ...(driver ? { driver: String(driver) } : {}) });
}

export function values(...pairs) {
  if (pairs.length % 2 !== 0) throw new DatabaseError('values expects key/value pairs.', { code: 'KR-DB-0105' });
  const output = Object.create(null);
  for (let index = 0; index < pairs.length; index += 2) {
    const key = String(pairs[index]);
    if (!IDENTIFIER.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new DatabaseError(`Unsafe value key '${key}'.`, { code: 'KR-DB-0106' });
    output[key] = pairs[index + 1];
  }
  return output;
}

export function createDatabase(options = {}) {
  const driver = options.driver ?? inferDriver(options.url ?? process.env.DATABASE_URL ?? 'memory:');
  const adapterFactory = options.adapter ?? adapterFor(driver, { ...options, driver });
  const pool = new ConnectionPool({
    create: adapterFactory,
    max: options.maxConnections ?? defaultPoolSize(driver),
    min: options.minConnections ?? 0,
    acquireTimeoutMs: options.acquireTimeoutMs ?? 10_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
    maxLifetimeMs: options.maxLifetimeMs ?? 30 * 60_000,
  });
  return new Database({ ...options, driver, pool });
}

export class Database {
  constructor(options) {
    this.driver = options.driver;
    this.pool = options.pool;
    this.logger = options.logger ?? null;
    this.slowQueryMs = options.slowQueryMs ?? 250;
    this.closed = false;
  }

  async query(statement, values = undefined) {
    this.#assertOpen();
    const normalized = normalizeStatement(statement, values);
    return this.#withConnection(connection => this.#execute(connection, normalized));
  }

  async execute(statement, values = undefined) {
    const result = await this.query(statement, values);
    return Object.freeze({
      rowsAffected: Number(result.rowsAffected ?? result.affectedRows ?? 0),
      lastInsertId: result.lastInsertId ?? result.insertId ?? null,
      columns: Object.freeze([...(result.columns ?? [])]),
    });
  }

  async all(statement, values = undefined) {
    const result = await this.query(statement, values);
    return result.rows ?? [];
  }

  async one(statement, values = undefined) {
    const rows = await this.all(statement, values);
    if (rows.length !== 1) {
      throw new DatabaseError(`Expected exactly one row, received ${rows.length}.`, {
        code: 'KR-DB-0201', driver: this.driver,
      });
    }
    return rows[0];
  }

  async maybeOne(statement, values = undefined) {
    const rows = await this.all(statement, values);
    if (rows.length > 1) {
      throw new DatabaseError(`Expected zero or one row, received ${rows.length}.`, {
        code: 'KR-DB-0202', driver: this.driver,
      });
    }
    return rows[0] ?? null;
  }

  async scalar(statement, values = undefined) {
    const row = await this.one(statement, values);
    const keys = Object.keys(row);
    if (keys.length !== 1) {
      throw new DatabaseError(`Expected one scalar column, received ${keys.length}.`, {
        code: 'KR-DB-0203', driver: this.driver,
      });
    }
    return row[keys[0]];
  }

  async transaction(callback, options = {}) {
    this.#assertOpen();
    if (typeof callback !== 'function') throw new TypeError('transaction callback must be a function');
    const lease = await this.pool.acquire();
    const connection = lease.connection;
    const isolation = normalizeIsolation(options.isolation);
    let began = false;
    try {
      if (typeof connection.begin === 'function') await connection.begin({ isolation, readOnly: Boolean(options.readOnly) });
      else await connection.query({ text: beginSql(this.driver, isolation, options.readOnly), values: [] });
      began = true;
      const transactionDb = new TransactionDatabase(this, connection);
      const value = await callback(transactionDb);
      if (typeof connection.commit === 'function') await connection.commit();
      else await connection.query({ text: 'COMMIT', values: [] });
      lease.release();
      return value;
    } catch (error) {
      if (began) {
        try {
          if (typeof connection.rollback === 'function') await connection.rollback();
          else await connection.query({ text: 'ROLLBACK', values: [] });
        } catch (rollbackError) {
          lease.destroy();
          throw new DatabaseError('Database transaction failed and rollback also failed.', {
            code: 'KR-DB-0302', driver: this.driver, cause: error,
            details: String(rollbackError?.message ?? rollbackError),
          });
        }
      }
      lease.release();
      throw decorateDatabaseError(error, this.driver);
    }
  }

  table(name) {
    return new TableQuery(this, name);
  }

  async ping() {
    const statement = this.driver === 'oracle' ? 'SELECT 1 FROM dual' : 'SELECT 1 AS ok';
    const result = await this.query(statement);
    return Boolean(result.rows?.length ?? 1);
  }

  stats() {
    return this.pool.stats();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.close();
  }

  async #withConnection(callback) {
    const lease = await this.pool.acquire();
    try {
      return await callback(lease.connection);
    } catch (error) {
      if (isConnectionFatal(error)) lease.destroy();
      throw decorateDatabaseError(error, this.driver);
    } finally {
      lease.release();
    }
  }

  async #execute(connection, statement) {
    const started = performance.now();
    const prepared = rewritePlaceholders(statement, this.driver);
    try {
      const result = await connection.query(prepared);
      const elapsedMs = performance.now() - started;
      this.#logQuery(prepared, elapsedMs, result);
      return normalizeResult(result);
    } catch (error) {
      const elapsedMs = performance.now() - started;
      this.#logQuery(prepared, elapsedMs, null, error);
      throw error;
    }
  }

  #logQuery(statement, elapsedMs, result = null, error = null) {
    if (!this.logger) return;
    const record = {
      event: error ? 'database.query.error' : 'database.query',
      driver: this.driver,
      durationMs: elapsedMs,
      slow: elapsedMs >= this.slowQueryMs,
      sql: statement.text,
      parameterCount: statement.values.length,
      rowCount: result?.rows?.length ?? result?.rowCount ?? null,
      error: error ? String(error?.message ?? error) : null,
    };
    const method = error ? 'error' : record.slow ? 'warn' : 'debug';
    this.logger[method]?.(record.event, record);
  }

  #assertOpen() {
    if (this.closed) throw new DatabaseError('Database is closed.', { code: 'KR-DB-0002', driver: this.driver });
  }
}

class TransactionDatabase {
  constructor(parent, connection) {
    this.parent = parent;
    this.connection = connection;
    this.driver = parent.driver;
    this.finished = false;
  }

  async query(statement, values = undefined) {
    if (this.finished) throw new DatabaseError('Transaction is no longer active.', { code: 'KR-DB-0301' });
    return executeConnection(this.connection, normalizeStatement(statement, values), this.driver);
  }

  async execute(statement, values = undefined) {
    const result = await this.query(statement, values);
    return { rowsAffected: result.rowsAffected ?? 0, lastInsertId: result.lastInsertId ?? null };
  }

  async all(statement, values = undefined) { return (await this.query(statement, values)).rows ?? []; }
  async one(statement, values = undefined) {
    const rows = await this.all(statement, values);
    if (rows.length !== 1) throw new DatabaseError(`Expected one row, received ${rows.length}.`, { code: 'KR-DB-0201' });
    return rows[0];
  }
  async maybeOne(statement, values = undefined) {
    const rows = await this.all(statement, values);
    if (rows.length > 1) throw new DatabaseError(`Expected zero or one row, received ${rows.length}.`, { code: 'KR-DB-0202' });
    return rows[0] ?? null;
  }
  async scalar(statement, values = undefined) {
    const row = await this.one(statement, values);
    const key = Object.keys(row);
    if (key.length !== 1) throw new DatabaseError('Scalar query returned multiple columns.', { code: 'KR-DB-0203' });
    return row[key[0]];
  }
  table(name) { return new TableQuery(this, name); }
}

async function executeConnection(connection, statement, driver) {
  const prepared = rewritePlaceholders(statement, driver);
  try { return normalizeResult(await connection.query(prepared)); }
  catch (error) { throw decorateDatabaseError(error, driver); }
}

export class ConnectionPool {
  constructor(options) {
    if (typeof options.create !== 'function') throw new TypeError('ConnectionPool needs a create function');
    this.createConnection = options.create;
    this.max = clampInteger(options.max ?? 10, 1, 1024);
    this.min = clampInteger(options.min ?? 0, 0, this.max);
    this.acquireTimeoutMs = clampInteger(options.acquireTimeoutMs ?? 10_000, 1, 300_000);
    this.idleTimeoutMs = clampInteger(options.idleTimeoutMs ?? 30_000, 100, 86_400_000);
    this.maxLifetimeMs = clampInteger(options.maxLifetimeMs ?? 1_800_000, 1_000, 86_400_000);
    this.idle = [];
    this.busy = new Set();
    this.waiters = [];
    this.total = 0;
    this.closed = false;
    this.creating = 0;
    this.reaper = setInterval(() => void this.#reap(), Math.min(this.idleTimeoutMs, 5_000));
    this.reaper.unref?.();
  }

  async acquire() {
    if (this.closed) throw new DatabaseError('Connection pool is closed.', { code: 'KR-DB-0401' });
    const now = Date.now();
    while (this.idle.length) {
      const item = this.idle.pop();
      if (now - item.createdAt >= this.maxLifetimeMs || item.destroyed) {
        await this.#destroy(item);
        continue;
      }
      item.lastUsedAt = now;
      this.busy.add(item);
      return this.#lease(item);
    }
    if (this.total + this.creating < this.max) return this.#createLease();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new DatabaseError(`Timed out after ${this.acquireTimeoutMs} ms waiting for a database connection.`, { code: 'KR-DB-0402' }));
      }, this.acquireTimeoutMs);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  stats() {
    return Object.freeze({
      max: this.max,
      total: this.total,
      idle: this.idle.length,
      busy: this.busy.size,
      waiting: this.waiters.length,
      creating: this.creating,
      closed: this.closed,
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.reaper);
    const error = new DatabaseError('Connection pool closed while waiting.', { code: 'KR-DB-0403' });
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
    const entries = [...this.idle, ...this.busy];
    this.idle.length = 0;
    this.busy.clear();
    await Promise.allSettled(entries.map(item => this.#destroy(item)));
  }

  async #createLease() {
    this.creating++;
    try {
      const connection = await this.createConnection();
      const item = { connection, createdAt: Date.now(), lastUsedAt: Date.now(), destroyed: false };
      this.total++;
      this.busy.add(item);
      return this.#lease(item);
    } catch (error) {
      throw decorateDatabaseError(error, 'pool');
    } finally {
      this.creating--;
    }
  }

  #lease(item) {
    let returned = false;
    return Object.freeze({
      connection: item.connection,
      release: () => {
        if (returned) return;
        returned = true;
        this.#release(item);
      },
      destroy: () => {
        if (returned) return;
        returned = true;
        item.destroyed = true;
      },
    });
  }

  #release(item) {
    this.busy.delete(item);
    if (item.destroyed || this.closed || Date.now() - item.createdAt >= this.maxLifetimeMs) {
      void this.#destroy(item);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      item.lastUsedAt = Date.now();
      this.busy.add(item);
      waiter.resolve(this.#lease(item));
      return;
    }
    item.lastUsedAt = Date.now();
    this.idle.push(item);
  }

  async #destroy(item) {
    if (!item || item.destroyed === 'closed') return;
    item.destroyed = 'closed';
    this.busy.delete(item);
    const idleIndex = this.idle.indexOf(item);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    this.total = Math.max(0, this.total - 1);
    try { await item.connection.close?.(); } catch { }
  }

  async #reap() {
    if (this.closed) return;
    const now = Date.now();
    const candidates = [];
    while (this.idle.length > this.min) {
      const item = this.idle[0];
      if (now - item.lastUsedAt < this.idleTimeoutMs && now - item.createdAt < this.maxLifetimeMs) break;
      candidates.push(this.idle.shift());
    }
    await Promise.allSettled(candidates.map(item => this.#destroy(item)));
  }
}

export class TableQuery {
  constructor(database, tableName) {
    if (!IDENTIFIER.test(String(tableName))) throw new DatabaseError(`Invalid table name '${tableName}'.`, { code: 'KR-DB-0501' });
    this.database = database;
    this.tableName = String(tableName);
    this.mode = 'select';
    this.columns = ['*'];
    this.conditions = [];
    this.orderings = [];
    this.limitValue = null;
    this.offsetValue = null;
    this.payload = null;
    this.returningColumns = [];
  }

  select(...columns) {
    const clone = this.#clone();
    clone.mode = 'select';
    clone.columns = columns.flat().length ? columns.flat().map(column => column === '*' ? '*' : validateColumn(column)) : ['*'];
    return clone;
  }

  where(column, operator, value = undefined) {
    const clone = this.#clone();
    if (value === undefined) { value = operator; operator = '='; }
    const normalizedOperator = String(operator).toUpperCase();
    const allowed = new Set(['=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'IS', 'IS NOT']);
    if (!allowed.has(normalizedOperator)) throw new DatabaseError(`Unsupported where operator '${operator}'.`, { code: 'KR-DB-0502' });
    clone.conditions.push({ type: 'basic', column: validateColumn(column), operator: normalizedOperator, value });
    return clone;
  }

  whereIn(column, values) {
    const list = [...values];
    if (!list.length) return this.whereRaw('1 = 0');
    const clone = this.#clone();
    clone.conditions.push({ type: 'in', column: validateColumn(column), values: list });
    return clone;
  }

  whereNull(column) {
    const clone = this.#clone();
    clone.conditions.push({ type: 'raw', text: `${ident(validateColumn(column))} IS NULL`, values: [] });
    return clone;
  }

  whereRaw(text, values = []) {
    const clone = this.#clone();
    clone.conditions.push({ type: 'raw', text: String(text), values: [...values] });
    return clone;
  }

  orderBy(column, direction = 'asc') {
    const normalized = String(direction).toUpperCase();
    if (!['ASC', 'DESC'].includes(normalized)) throw new DatabaseError(`Invalid sort direction '${direction}'.`, { code: 'KR-DB-0503' });
    const clone = this.#clone();
    clone.orderings.push({ column: validateColumn(column), direction: normalized });
    return clone;
  }

  limit(value) { const clone = this.#clone(); clone.limitValue = clampInteger(value, 0, 1_000_000); return clone; }
  offset(value) { const clone = this.#clone(); clone.offsetValue = clampInteger(value, 0, Number.MAX_SAFE_INTEGER); return clone; }

  insert(values) { const clone = this.#clone(); clone.mode = 'insert'; clone.payload = { ...values }; return clone; }
  update(values) { const clone = this.#clone(); clone.mode = 'update'; clone.payload = { ...values }; return clone; }
  delete() { const clone = this.#clone(); clone.mode = 'delete'; return clone; }
  returning(...columns) { const clone = this.#clone(); clone.returningColumns = columns.flat().map(validateColumn); return clone; }

  toSQL() {
    const table = ident(this.tableName);
    const values = [];
    let text;
    if (this.mode === 'select') {
      const columns = this.columns.map(column => column === '*' ? '*' : ident(column)).join(', ');
      text = `SELECT ${columns} FROM ${table}`;
    } else if (this.mode === 'insert') {
      const entries = Object.entries(this.payload ?? {});
      if (!entries.length) throw new DatabaseError('Insert payload cannot be empty.', { code: 'KR-DB-0504' });
      text = `INSERT INTO ${table} (${entries.map(([key]) => ident(validateColumn(key))).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`;
      values.push(...entries.map(([, value]) => value));
    } else if (this.mode === 'update') {
      const entries = Object.entries(this.payload ?? {});
      if (!entries.length) throw new DatabaseError('Update payload cannot be empty.', { code: 'KR-DB-0505' });
      text = `UPDATE ${table} SET ${entries.map(([key]) => `${ident(validateColumn(key))} = ?`).join(', ')}`;
      values.push(...entries.map(([, value]) => value));
    } else {
      text = `DELETE FROM ${table}`;
    }
    const where = compileConditions(this.conditions);
    if (where.text) { text += ` WHERE ${where.text}`; values.push(...where.values); }
    if (this.mode === 'update' || this.mode === 'delete') {
      if (!this.conditions.length) throw new DatabaseError(`${this.mode} requires at least one where clause.`, { code: 'KR-DB-0506' });
    }
    if (this.orderings.length && this.mode === 'select') text += ` ORDER BY ${this.orderings.map(item => `${ident(item.column)} ${item.direction}`).join(', ')}`;
    if (this.limitValue !== null && this.mode === 'select') { text += ' LIMIT ?'; values.push(this.limitValue); }
    if (this.offsetValue !== null && this.mode === 'select') { text += ' OFFSET ?'; values.push(this.offsetValue); }
    if (this.returningColumns.length) text += ` RETURNING ${this.returningColumns.map(ident).join(', ')}`;
    return Object.freeze({ text, values: Object.freeze(values) });
  }

  async all() { return this.database.all(this.toSQL()); }
  async one() { return this.database.one(this.toSQL()); }
  async maybeOne() { return this.database.maybeOne(this.toSQL()); }
  async run() { return this.database.query(this.toSQL()); }

  #clone() {
    const clone = new TableQuery(this.database, this.tableName);
    clone.mode = this.mode;
    clone.columns = [...this.columns];
    clone.conditions = this.conditions.map(item => ({ ...item, values: item.values ? [...item.values] : undefined }));
    clone.orderings = this.orderings.map(item => ({ ...item }));
    clone.limitValue = this.limitValue;
    clone.offsetValue = this.offsetValue;
    clone.payload = this.payload ? { ...this.payload } : null;
    clone.returningColumns = [...this.returningColumns];
    return clone;
  }
}

export async function loadMigrations(directory) {
  const root = path.resolve(directory);
  const names = (await readdir(root)).filter(name => SAFE_MIGRATION_NAME.test(name)).sort();
  const migrations = [];
  for (const name of names) {
    const file = path.join(root, name);
    const source = await readFile(file, 'utf8');
    if (Buffer.byteLength(source) > 8 * 1024 * 1024) throw new DatabaseError(`Migration is too large: ${name}`, { code: 'KR-DB-0601' });
    const sections = splitMigration(source);
    migrations.push(Object.freeze({
      id: name.replace(/\.sql$/, ''),
      name,
      file,
      up: sections.up,
      down: sections.down,
      checksum: createHash('sha256').update(source).digest('hex'),
    }));
  }
  return Object.freeze(migrations);
}

export async function migrate(database, migrations, options = {}) {
  const table = options.table ?? '_kura_migrations';
  if (!IDENTIFIER.test(table)) throw new DatabaseError('Migration table name is invalid.', { code: 'KR-DB-0602' });
  await ensureMigrationTable(database, table);
  const appliedRows = await database.all(`SELECT id, checksum, applied_at FROM ${ident(table)} ORDER BY id`);
  const applied = new Map(appliedRows.map(row => [String(row.id), row]));
  const plan = [];
  for (const migration of migrations) {
    const existing = applied.get(migration.id);
    if (existing && existing.checksum !== migration.checksum) {
      throw new DatabaseError(`Applied migration '${migration.id}' was modified.`, { code: 'KR-DB-0603' });
    }
    if (!existing) plan.push(migration);
  }
  if (options.dryRun) return Object.freeze({ applied: [], pending: plan.map(item => item.id), dryRun: true });
  const completed = [];
  for (const migration of plan) {
    await database.transaction(async transaction => {
      for (const statement of splitSqlStatements(migration.up)) await transaction.query(statement);
      await transaction.query(`INSERT INTO ${ident(table)} (id, checksum, applied_at) VALUES (?, ?, ?)`, [migration.id, migration.checksum, new Date().toISOString()]);
    });
    completed.push(migration.id);
  }
  return Object.freeze({ applied: completed, pending: [], dryRun: false });
}

export async function rollback(database, migrations, options = {}) {
  const table = options.table ?? '_kura_migrations';
  const steps = clampInteger(options.steps ?? 1, 1, 10_000);
  await ensureMigrationTable(database, table);
  const rows = await database.all(`SELECT id, checksum, applied_at FROM ${ident(table)} ORDER BY id DESC`);
  const byId = new Map(migrations.map(item => [item.id, item]));
  const targets = rows.slice(0, steps);
  const completed = [];
  for (const row of targets) {
    const migration = byId.get(String(row.id));
    if (!migration) throw new DatabaseError(`Migration source '${row.id}' is missing.`, { code: 'KR-DB-0604' });
    if (!migration.down.trim()) throw new DatabaseError(`Migration '${row.id}' has no down section.`, { code: 'KR-DB-0605' });
    await database.transaction(async transaction => {
      for (const statement of splitSqlStatements(migration.down)) await transaction.query(statement);
      await transaction.query(`DELETE FROM ${ident(table)} WHERE id = ?`, [migration.id]);
    });
    completed.push(migration.id);
  }
  return Object.freeze({ rolledBack: completed });
}

export function splitMigration(source) {
  const text = String(source).replace(/^\uFEFF/, '');
  const downMarker = /^\s*--\s*down\s*$/im;
  const match = downMarker.exec(text);
  if (!match) return Object.freeze({ up: text.trim(), down: '' });
  const up = text.slice(0, match.index).replace(/^\s*--\s*up\s*$/im, '').trim();
  const down = text.slice(match.index + match[0].length).trim();
  return Object.freeze({ up, down });
}

export function splitSqlStatements(source) {
  const text = String(source);
  const output = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      current += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') { current += next; index++; blockComment = false; }
      continue;
    }
    if (!quote && char === '-' && next === '-') { current += char + next; index++; lineComment = true; continue; }
    if (!quote && char === '/' && next === '*') { current += char + next; index++; blockComment = true; continue; }
    if (quote) {
      current += char;
      if (char === quote) {
        if (text[index + 1] === quote) { current += quote; index++; }
        else quote = null;
      } else if (char === '\\' && index + 1 < text.length) { current += text[++index]; }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; current += char; continue; }
    if (char === ';') {
      if (current.trim()) output.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) output.push(current.trim());
  return Object.freeze(output);
}

export function inferDriver(url) {
  const value = String(url ?? '').toLowerCase();
  if (value.startsWith('postgres:') || value.startsWith('postgresql:')) return 'postgres';
  if (value.startsWith('mysql:') || value.startsWith('mariadb:')) return 'mysql';
  if (value.startsWith('libsql:') || value.startsWith('turso:') || value.includes('turso.io')) return 'turso';
  if (value.startsWith('sqlite:') || value.endsWith('.sqlite') || value.endsWith('.db')) return 'sqlite';
  if (value.startsWith('memory:') || value === ':memory:') return 'memory';
  return 'postgres';
}

function adapterFor(driver, options) {
  switch (driver) {
    case 'postgres': return createPostgresFactory(options);
    case 'mysql': return createMysqlFactory(options);
    case 'sqlite': return createSqliteFactory(options);
    case 'turso': return createTursoFactory(options);
    case 'memory': return createMemoryFactory(options);
    default: throw new DatabaseError(`Unsupported database driver '${driver}'.`, { code: 'KR-DB-0701', driver });
  }
}

function createPostgresFactory(options) {
  return async () => {
    let module;
    try { module = await import('pg'); }
    catch (error) { throw missingDriver('pg', 'kr add pg', error); }
    const Client = module.Client ?? module.default?.Client;
    const client = new Client({ connectionString: options.url ?? process.env.DATABASE_URL, ...(options.connection ?? {}) });
    await client.connect();
    return {
      async query(statement) {
        const result = await client.query(statement.text, statement.values);
        return { rows: result.rows, rowsAffected: result.rowCount, columns: result.fields?.map(field => field.name) ?? [] };
      },
      async begin(config = {}) {
        await client.query('BEGIN');
        if (config.isolation) await client.query(`SET TRANSACTION ISOLATION LEVEL ${config.isolation}`);
        if (config.readOnly) await client.query('SET TRANSACTION READ ONLY');
      },
      commit: () => client.query('COMMIT'),
      rollback: () => client.query('ROLLBACK'),
      close: () => client.end(),
    };
  };
}

function createMysqlFactory(options) {
  return async () => {
    let module;
    try { module = await import('mysql2/promise'); }
    catch (error) { throw missingDriver('mysql2', 'kr add mysql2', error); }
    const connection = await module.createConnection(options.url ?? process.env.DATABASE_URL ?? options.connection);
    return {
      async query(statement) {
        const [rows, fields] = await connection.execute(statement.text, statement.values);
        if (Array.isArray(rows)) return { rows, rowsAffected: rows.length, columns: fields?.map(field => field.name) ?? [] };
        return { rows: [], rowsAffected: rows.affectedRows ?? 0, lastInsertId: rows.insertId ?? null, columns: [] };
      },
      async begin(config = {}) {
        if (config.isolation) await connection.query(`SET TRANSACTION ISOLATION LEVEL ${config.isolation}`);
        await connection.beginTransaction();
      },
      commit: () => connection.commit(),
      rollback: () => connection.rollback(),
      close: () => connection.end(),
    };
  };
}

function createSqliteFactory(options) {
  return async () => {
    const file = sqliteFile(options.url ?? options.filename ?? ':memory:');
    try {
      const module = await import('node:sqlite');
      const DatabaseSync = module.DatabaseSync;
      const database = new DatabaseSync(file);
      return sqliteConnection(database);
    } catch (nodeError) {
      try {
        const module = await import('better-sqlite3');
        const DatabaseSync = module.default ?? module;
        return sqliteConnection(new DatabaseSync(file));
      } catch (externalError) {
        throw missingDriver('SQLite', 'Use Node.js with node:sqlite support or run kr add better-sqlite3', externalError ?? nodeError);
      }
    }
  };
}

function sqliteConnection(database) {
  return {
    async query(statement) {
      const prepared = database.prepare(statement.text);
      const keyword = statement.text.trimStart().split(/\s+/, 1)[0]?.toUpperCase();
      if (['SELECT', 'WITH', 'PRAGMA', 'EXPLAIN'].includes(keyword)) {
        const rows = prepared.all(...statement.values);
        return { rows, rowsAffected: rows.length, columns: rows[0] ? Object.keys(rows[0]) : [] };
      }
      const result = prepared.run(...statement.values);
      return { rows: [], rowsAffected: Number(result.changes ?? result.changes64 ?? 0), lastInsertId: result.lastInsertRowid ?? null, columns: [] };
    },
    begin: () => database.exec('BEGIN IMMEDIATE'),
    commit: () => database.exec('COMMIT'),
    rollback: () => database.exec('ROLLBACK'),
    close: () => database.close(),
  };
}

function createTursoFactory(options) {
  const rawUrl = options.url ?? process.env.DATABASE_URL;
  const token = options.authToken ?? process.env.DATABASE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN;
  if (!rawUrl) throw new DatabaseError('Turso URL is required.', { code: 'KR-DB-0710', driver: 'turso' });
  const endpoint = normalizeTursoUrl(rawUrl);
  return async () => ({
    async query(statement) {
      const response = await fetch(`${endpoint}/v2/pipeline`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: statement.text, args: statement.values.map(toLibsqlArgument) } }, { type: 'close' }] }),
      });
      if (!response.ok) throw new DatabaseError(`Turso HTTP ${response.status}.`, { code: 'KR-DB-0711', driver: 'turso', details: await response.text() });
      const payload = await response.json();
      const result = payload.results?.[0]?.response?.result;
      if (!result) {
        const error = payload.results?.[0]?.error;
        throw new DatabaseError(error?.message ?? 'Turso query failed.', { code: 'KR-DB-0712', driver: 'turso' });
      }
      const columns = result.cols?.map(column => column.name) ?? [];
      const rows = (result.rows ?? []).map(row => Object.fromEntries(row.map((cell, index) => [columns[index], fromLibsqlValue(cell)])));
      return { rows, rowsAffected: Number(result.affected_row_count ?? 0), lastInsertId: result.last_insert_rowid ?? null, columns };
    },
    close() {},
  });
}

function createMemoryFactory(options) {
  const handler = options.memoryHandler;
  return async () => {
    const statements = [];
    return {
      async query(statement) {
        statements.push({ text: statement.text, values: [...statement.values] });
        if (typeof handler === 'function') return normalizeResult(await handler(statement, statements));
        if (/^\s*select\s+1\b/i.test(statement.text)) return { rows: [{ ok: 1 }], rowsAffected: 1, columns: ['ok'] };
        return { rows: [], rowsAffected: 0, columns: [] };
      },
      begin() {}, commit() {}, rollback() {}, close() {},
      statements,
    };
  };
}

function normalizeStatement(statement, values) {
  if (typeof statement === 'string') return Object.freeze({ text: statement, values: Object.freeze([...(values ?? [])]) });
  if (!statement || typeof statement.text !== 'string') throw new DatabaseError('Query must be SQL text or a statement object.', { code: 'KR-DB-0104' });
  return Object.freeze({ text: statement.text, values: Object.freeze([...(statement.values ?? values ?? [])]) });
}

function rewritePlaceholders(statement, driver) {
  if (driver !== 'postgres') return statement;
  let index = 0;
  let quote = null;
  let output = '';
  for (let position = 0; position < statement.text.length; position++) {
    const char = statement.text[position];
    if (quote) {
      output += char;
      if (char === quote) quote = null;
      else if (char === '\\') output += statement.text[++position] ?? '';
      continue;
    }
    if (char === "'" || char === '"') { quote = char; output += char; continue; }
    if (char === '?') { output += `$${++index}`; continue; }
    output += char;
  }
  return Object.freeze({ text: output, values: statement.values });
}

function normalizeResult(result) {
  if (!result) return Object.freeze({ rows: Object.freeze([]), rowsAffected: 0, lastInsertId: null, columns: Object.freeze([]) });
  if (Array.isArray(result)) return Object.freeze({ rows: Object.freeze(result), rowsAffected: result.length, lastInsertId: null, columns: Object.freeze(result[0] ? Object.keys(result[0]) : []) });
  return Object.freeze({
    rows: Object.freeze([...(result.rows ?? [])]),
    rowsAffected: Number(result.rowsAffected ?? result.affectedRows ?? result.rowCount ?? 0),
    lastInsertId: result.lastInsertId ?? result.insertId ?? null,
    columns: Object.freeze([...(result.columns ?? [])]),
  });
}

function compileConditions(conditions) {
  const parts = [];
  const values = [];
  for (const condition of conditions) {
    if (condition.type === 'basic') { parts.push(`${ident(condition.column)} ${condition.operator} ?`); values.push(condition.value); }
    else if (condition.type === 'in') { parts.push(`${ident(condition.column)} IN (${condition.values.map(() => '?').join(', ')})`); values.push(...condition.values); }
    else { parts.push(`(${condition.text})`); values.push(...condition.values); }
  }
  return { text: parts.join(' AND '), values };
}

function validateColumn(value) {
  const text = String(value);
  const parts = text.split('.');
  if (!parts.length || parts.some(part => !IDENTIFIER.test(part))) throw new DatabaseError(`Invalid column '${value}'.`, { code: 'KR-DB-0507' });
  return text;
}

async function ensureMigrationTable(database, table) {
  await database.query(`CREATE TABLE IF NOT EXISTS ${ident(table)} (id VARCHAR(255) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at VARCHAR(64) NOT NULL)`);
}

function beginSql(driver, isolation, readOnly) {
  if (driver === 'sqlite') return 'BEGIN IMMEDIATE';
  let text = 'BEGIN';
  if (isolation) text += ` ISOLATION LEVEL ${isolation}`;
  if (readOnly) text += ' READ ONLY';
  return text;
}

function normalizeIsolation(value) {
  if (!value) return null;
  const normalized = String(value).replaceAll('_', ' ').toUpperCase();
  const allowed = new Set(['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);
  if (!allowed.has(normalized)) throw new DatabaseError(`Invalid transaction isolation '${value}'.`, { code: 'KR-DB-0303' });
  return normalized;
}

function defaultPoolSize(driver) { return ['sqlite', 'turso', 'memory'].includes(driver) ? 1 : 10; }
function clampInteger(value, minimum, maximum) { const number = Number(value); if (!Number.isInteger(number) || number < minimum || number > maximum) throw new RangeError(`Expected integer from ${minimum} to ${maximum}`); return number; }
function decorateDatabaseError(error, driver) { if (error instanceof DatabaseError) return error; return new DatabaseError(String(error?.message ?? error), { code: error?.code ?? 'KR-DB-0001', driver, cause: error }); }
function isConnectionFatal(error) { return ['ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST', '57P01', '57P02', '57P03'].includes(error?.code); }
function missingDriver(name, command, cause) { return new DatabaseError(`${name} database driver is not installed.`, { code: 'KR-DB-0702', cause, details: command }); }
function sqliteFile(url) { const value = String(url); if (value === ':memory:' || value === 'sqlite::memory:' || value === 'memory:') return ':memory:'; return value.replace(/^sqlite:(?:\/\/)?/, '') || ':memory:'; }
function normalizeTursoUrl(url) { const value = String(url).replace(/^libsql:/, 'https:').replace(/^turso:/, 'https:').replace(/\/$/, ''); return value; }
function toLibsqlArgument(value) { if (value === null || value === undefined) return { type: 'null' }; if (typeof value === 'number') return Number.isInteger(value) ? { type: 'integer', value: String(value) } : { type: 'float', value }; if (typeof value === 'bigint') return { type: 'integer', value: value.toString() }; if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' }; if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(value).toString('base64') }; return { type: 'text', value: String(value) }; }
function fromLibsqlValue(value) { if (!value || value.type === 'null') return null; if (value.type === 'integer') { const number = Number(value.value); return Number.isSafeInteger(number) ? number : BigInt(value.value); } if (value.type === 'float') return Number(value.value); if (value.type === 'blob') return Buffer.from(value.base64, 'base64'); return value.value; }
