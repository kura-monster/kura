// SPDX-License-Identifier: MIT OR Apache-2.0
import { parseArgs as nodeParseArgs } from 'node:util';
export function parseArgs(options = {}) { return nodeParseArgs({ args: options.args ?? process.argv.slice(2), options: options.options ?? {}, allowPositionals: options.allowPositionals ?? true, strict: options.strict ?? true }); }
