// SPDX-License-Identifier: MIT OR Apache-2.0
import * as runtime from '../lib/web-database.mjs';

export {
  DatabaseError,
  ConnectionPool,
  TableQuery,
  sql,
  ident,
  raw,
  values,
  loadMigrations,
  migrate,
  rollback,
  splitMigration,
  splitSqlStatements,
  inferDriver,
} from '../lib/web-database.mjs';

function assertDatabaseCapability() {
  if (process.env.KURA_SECURITY_MODE === 'strict') {
    throw new runtime.DatabaseError('Strict security mode blocks database connections.', {
      code: 'KR-DB-STRICT-0001',
      details: 'Run reviewed server code without --secure. Strict mode is intended for capability-restricted scripts.',
    });
  }
}

export function createDatabase(options = {}) {
  assertDatabaseCapability();
  return runtime.createDatabase(options);
}

export function connect(url, driver = undefined) {
  assertDatabaseCapability();
  return runtime.connect(url, driver);
}
