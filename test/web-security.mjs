// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { createApp } from '../std/web.mjs';

const previous = process.env.KURA_SECURITY_MODE;
try {
  process.env.KURA_SECURITY_MODE = 'strict';
  assert.throws(
    () => createApp(),
    error => error?.code === 'WEB_STRICT_MODE' && error?.status === 403,
  );
} finally {
  if (previous === undefined) delete process.env.KURA_SECURITY_MODE;
  else process.env.KURA_SECURITY_MODE = previous;
}

const app = createApp({ poweredBy: false });
assert.equal(typeof app.listen, 'function');
assert.equal(typeof app.close, 'function');

console.log('web security boundary tests passed');
