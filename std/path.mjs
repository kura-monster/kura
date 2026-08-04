// SPDX-License-Identifier: MIT OR Apache-2.0
import path from 'node:path';
export const joinPath = (...parts) => path.join(...parts);
export const resolvePath = (...parts) => path.resolve(...parts);
export const basename = value => path.basename(value);
export const dirname = value => path.dirname(value);
export const extension = value => path.extname(value);
export const normalizePath = value => path.normalize(value);
export const relativePath = (from, to) => path.relative(from, to);
export const isAbsolutePath = value => path.isAbsolute(value);
