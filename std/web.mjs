// SPDX-License-Identifier: MIT OR Apache-2.0
import * as runtime from '../lib/web-runtime.mjs';

export {
  WebError,
  object,
  objectFrom,
  header,
  headers,
  response,
  text,
  html,
  json,
  bytes,
  empty,
  redirect,
  problem,
  cookie,
  clearCookie,
  sign,
  verifySigned,
  cors,
  securityHeaders,
  requestLogger,
  timeout,
  rateLimit,
  compression,
  staticFiles,
  sse,
  WebSocketConnection,
} from '../lib/web-runtime.mjs';

export function createApp(options = {}) {
  if (process.env.KURA_SECURITY_MODE === 'strict') {
    throw new runtime.WebError(
      403,
      'Strict security mode blocks Web server capabilities.',
      {
        code: 'WEB_STRICT_MODE',
        expose: true,
        details: {
          hint: 'Run reviewed server code without --secure. Keep --secure for capability-restricted scripts.',
        },
      },
    );
  }
  return new runtime.KuraWebApp(options);
}
