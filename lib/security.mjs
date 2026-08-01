// SPDX-License-Identifier: MIT OR Apache-2.0
import { access, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { KuraCliError } from './diagnostics.mjs';

export const LIMITS = Object.freeze({
  sourceBytes: 4 * 1024 * 1024,
  configBytes: 256 * 1024,
  schemaBytes: 4 * 1024 * 1024,
  headerBytes: 8 * 1024 * 1024,
  generatedBytes: 32 * 1024 * 1024,
  sourceFiles: 10_000,
  directoryDepth: 32,
});

const BLOCKED_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SENSITIVE_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|AUTH|COOKIE|SESSION|AWS_|AZURE_|GCP_|GOOGLE_|GITHUB_|NPM_TOKEN)/i;

export class KuraSecurityError extends KuraCliError {
  constructor(summary, options = {}) {
    super(summary, {
      code: options.code ?? 'KR-SEC-0001',
      title: options.title ?? 'Kura blocked an unsafe operation',
      hint: options.hint ?? 'Review the path or security setting. Use an explicit opt-out only when you trust the project.',
      ...options,
    });
    this.name = 'KuraSecurityError';
  }
}

export async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export function assertSafeProjectName(name) {
  if (!name || typeof name !== 'string') {
    throw new KuraCliError('A project name is required.', {
      code: 'KR-CLI-0101',
      title: 'Kura needs a project name',
      hint: 'Example: kr new hello',
    });
  }
  if (name.includes('\0') || path.isAbsolute(name)) {
    throw new KuraSecurityError('The project name must be a relative path without control characters.', { code: 'KR-SEC-0101' });
  }
  const segments = name.split(/[\\/]+/);
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || WINDOWS_RESERVED.test(segment))) {
    throw new KuraSecurityError(`The project name '${name}' contains an unsafe or reserved path segment.`, {
      code: 'KR-SEC-0102',
      hint: 'Use letters, numbers, dashes, and underscores. Example: kr new my-app',
    });
  }
  if (!segments.every(segment => /^[\p{L}\p{N}._-]+$/u.test(segment))) {
    throw new KuraSecurityError(`The project name '${name}' contains unsupported characters.`, { code: 'KR-SEC-0103' });
  }
}

export function assertInsideRoot(candidate, root, label = 'path') {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return resolved;
  throw new KuraSecurityError(`The ${label} resolves outside the allowed project directory.`, {
    code: 'KR-SEC-0201',
    details: `${resolved} is outside ${resolvedRoot}`,
    hint: 'Choose a path inside the project, or pass --allow-outside-project only when you fully trust the destination.',
  });
}

export async function readTextFileSecure(file, options = {}) {
  const resolved = path.resolve(file);
  const maxBytes = options.maxBytes ?? LIMITS.sourceBytes;
  let info;
  try { info = await lstat(resolved); } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new KuraCliError(`File not found: ${resolved}`, {
        code: 'KR-FS-0001', title: 'Kura could not find this file', file: resolved,
        hint: 'Check the path and current directory. For a new project, run kr new <name>.', cause: error,
      });
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    if (options.allowSymlink !== true) {
      throw new KuraSecurityError(`Refusing to read the symbolic link: ${resolved}`, {
        code: 'KR-SEC-0202', file: resolved,
        hint: 'Use a regular file. Symlinks are blocked for configuration, cache, and generated output paths.',
      });
    }
    info = await stat(resolved);
  }
  if (!info.isFile()) {
    throw new KuraCliError(`Expected a regular file: ${resolved}`, {
      code: 'KR-FS-0003', title: 'This path is not a regular file', file: resolved,
    });
  }
  if (info.size > maxBytes) {
    throw new KuraSecurityError(`The file is too large to process safely (${formatBytes(info.size)}).`, {
      code: 'KR-SEC-0203', file: resolved,
      details: `Maximum allowed size: ${formatBytes(maxBytes)}`,
      hint: 'Split the file into smaller modules or reduce generated content.',
    });
  }
  return readFile(resolved, 'utf8');
}

export function parseJsonSecure(text, file = '<config>') {
  try {
    return JSON.parse(text, (key, value) => {
      if (BLOCKED_JSON_KEYS.has(key)) {
        throw new KuraSecurityError(`Unsafe JSON key '${key}' is not allowed.`, {
          code: 'KR-SEC-0301', file,
          hint: 'Remove prototype-related keys from the configuration file.',
        });
      }
      return value;
    });
  } catch (error) {
    if (error instanceof KuraSecurityError) throw error;
    const position = /position\s+(\d+)/i.exec(error.message)?.[1];
    const location = position ? offsetToLocation(text, Number(position)) : { line: 1, column: 1 };
    throw new KuraCliError('The JSON file contains invalid syntax.', {
      code: 'KR-CONFIG-0001', title: 'Kura could not read the configuration file', file,
      line: location.line, column: location.column, source: text,
      hint: 'Check commas, quotes, and closing braces. JSON does not allow comments or trailing commas.',
      details: error.message, cause: error,
    });
  }
}

export function validateProjectConfig(config, file) {
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    throw new KuraCliError('The project configuration must be a JSON object.', {
      code: 'KR-CONFIG-0002', title: 'Invalid kura.json structure', file,
      hint: 'Start with: { "name": "my-app", "entry": "src/main.kr", "target": "node" }',
    });
  }
  const allowed = new Set(['name', 'version', 'entry', 'target', 'security']);
  const unknown = Object.keys(config).filter(key => !allowed.has(key));
  if (unknown.length) {
    throw new KuraCliError(`Unknown configuration ${unknown.length === 1 ? 'key' : 'keys'}: ${unknown.join(', ')}`, {
      code: 'KR-CONFIG-0003', title: 'kura.json contains unsupported settings', file,
      hint: `Allowed keys: ${[...allowed].join(', ')}`,
    });
  }
  if (config.entry !== undefined && (typeof config.entry !== 'string' || !config.entry.endsWith('.kr'))) {
    throw new KuraCliError("The 'entry' setting must be a relative .kr file path.", {
      code: 'KR-CONFIG-0004', title: 'Invalid project entry', file,
      hint: 'Example: "entry": "src/main.kr"',
    });
  }
  if (config.entry && (path.isAbsolute(config.entry) || config.entry.includes('\0'))) {
    throw new KuraSecurityError("The 'entry' setting may not use an absolute path.", { code: 'KR-SEC-0302', file });
  }
  if (config.target !== undefined && !['node'].includes(config.target)) {
    throw new KuraCliError(`Unsupported target '${config.target}'.`, {
      code: 'KR-CONFIG-0005', title: 'This Kura build does not support the requested target', file,
      hint: "Use 'node' for Kura v1.0.0.",
    });
  }
  return config;
}

export async function atomicWriteFile(file, content, options = {}) {
  const resolved = path.resolve(file);
  const allowedRoot = options.root ? path.resolve(options.root) : null;
  if (allowedRoot && options.allowOutsideRoot !== true) assertInsideRoot(resolved, allowedRoot, 'output path');
  const parent = path.dirname(resolved);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertPathHasNoSymlink(parent, allowedRoot ?? path.parse(parent).root);
  if (await exists(resolved)) {
    const current = await lstat(resolved);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new KuraSecurityError(`Refusing to overwrite a non-regular output path: ${resolved}`, {
        code: 'KR-SEC-0204', file: resolved,
      });
    }
  }
  const temp = path.join(parent, `.${path.basename(resolved)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const handle = await open(temp, 'wx', options.mode ?? 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, resolved);
    } catch (error) {
      if ((error?.code === 'EEXIST' || error?.code === 'EPERM') && await exists(resolved)) {
        const current = await lstat(resolved);
        if (current.isSymbolicLink() || !current.isFile()) throw error;
        await rm(resolved);
        await rename(temp, resolved);
      } else throw error;
    }
    if (process.platform !== 'win32') await chmod(resolved, options.mode ?? 0o600);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function prepareSecureCache(projectRoot) {
  const root = path.resolve(projectRoot);
  const kuraDir = path.join(root, '.kura');
  const cacheDir = path.join(kuraDir, 'velocity');
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await assertPathHasNoSymlink(cacheDir, root);
  const info = await lstat(cacheDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new KuraSecurityError('The Velocity cache path is not a safe directory.', { code: 'KR-SEC-0401', file: cacheDir });
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new KuraSecurityError('The Velocity cache is owned by another user.', { code: 'KR-SEC-0402', file: cacheDir });
    }
    await chmod(kuraDir, 0o700).catch(() => {});
    await chmod(cacheDir, 0o700).catch(() => {});
  }
  const keyFile = path.join(kuraDir, 'cache.key');
  let key;
  if (await exists(keyFile)) {
    key = await readTextFileSecure(keyFile, { maxBytes: 256, allowSymlink: false });
    if (!/^[a-f0-9]{64}$/.test(key.trim())) {
      throw new KuraSecurityError('The Velocity cache signing key is invalid.', {
        code: 'KR-SEC-0403', file: keyFile,
        hint: 'Delete .kura/cache.key and rerun the command to regenerate it.',
      });
    }
    key = key.trim();
  } else {
    key = randomBytes(32).toString('hex');
    await atomicWriteFile(keyFile, `${key}\n`, { root, mode: 0o600 });
  }
  return { cacheDir, key };
}

export function signCache(code, key) {
  return createHmac('sha256', key).update(code).digest('hex');
}

export async function readVerifiedCache(file, key) {
  const content = await readTextFileSecure(file, { maxBytes: LIMITS.generatedBytes, allowSymlink: false });
  const match = /^\/\/ Kura-Cache-HMAC: ([a-f0-9]{64})\n/.exec(content);
  if (!match) return null;
  const body = content.slice(match[0].length);
  const expected = Buffer.from(signCache(body, key), 'hex');
  const actual = Buffer.from(match[1], 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return body;
}

export function wrapSignedCache(code, key) {
  return `// Kura-Cache-HMAC: ${signCache(code, key)}\n${code}`;
}

export function sanitizeChildEnv(sourceEnv, options = {}) {
  const allowed = new Set(options.allow ?? []);
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (key === 'NODE_OPTIONS' || key === 'NODE_PATH') continue;
    if (options.strict && SENSITIVE_ENV.test(key) && !allowed.has(key)) continue;
    env[key] = value;
  }
  env.KURA_SECURITY_MODE = options.strict ? 'strict' : 'standard';
  return env;
}

export function nodeSecurityArgs(options = {}) {
  const args = ['--unhandled-rejections=strict', '--disable-proto=throw'];
  const memoryMb = clampInteger(options.memoryMb ?? (options.strict ? 256 : 768), 64, 8192);
  args.push(`--max-old-space-size=${memoryMb}`);
  if (options.strict && process.allowedNodeEnvironmentFlags.has('--permission')) {
    args.push('--permission', '--no-addons');
    for (const readPath of options.allowRead ?? []) args.push(`--allow-fs-read=${path.resolve(readPath)}`);
    for (const writePath of options.allowWrite ?? []) args.push(`--allow-fs-write=${path.resolve(writePath)}`);
  }
  return args;
}

export async function findKuraFiles(dir, options = {}) {
  const root = path.resolve(dir);
  const output = [];
  const maxFiles = options.maxFiles ?? LIMITS.sourceFiles;
  const maxDepth = options.maxDepth ?? LIMITS.directoryDepth;
  async function visit(current, depth) {
    if (depth > maxDepth) {
      throw new KuraSecurityError(`Directory nesting exceeds the safe limit of ${maxDepth}.`, { code: 'KR-SEC-0501', file: current });
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (['node_modules', '.git', '.kura', 'build', 'dist', 'coverage'].includes(entry.name)) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.kr')) {
        output.push(candidate);
        if (output.length > maxFiles) {
          throw new KuraSecurityError(`Project contains more than ${maxFiles.toLocaleString()} Kura files.`, { code: 'KR-SEC-0502', file: root });
        }
      }
    }
  }
  if (await exists(root)) await visit(root, 0);
  return output;
}

export async function auditProject(dir) {
  const root = path.resolve(dir);
  const findings = [];
  const files = await findKuraFiles(root);
  const rules = [
    { id: 'KR-AUDIT-001', severity: 'high', regex: /(?:node\s*:\s*["']child_process["']|["'](?:node:)?child_process["']|\bspawn\s*\(|\bexec\s*\()/, message: 'Process execution capability detected.' },
    { id: 'KR-AUDIT-002', severity: 'high', regex: /["'](?:data|javascript|https?):/i, message: 'Remote or executable URL import detected.' },
    { id: 'KR-AUDIT-003', severity: 'medium', regex: /(?:node\s*:\s*["'](?:fs|net|tls|http|https|dgram)["']|["'](?:node:)?(?:fs|net|tls|http|https|dgram)["'])/i, message: 'Sensitive filesystem or network capability detected.' },
    { id: 'KR-AUDIT-004', severity: 'medium', regex: /\b(?:eval|Function)\s*\(/, message: 'Dynamic code evaluation pattern detected.' },
    { id: 'KR-AUDIT-005', severity: 'medium', regex: /(?:password|token|secret|api[_-]?key)\s*[:=]\s*["'][^"']+["']/i, message: 'Possible hard-coded secret detected.' },
  ];
  for (const file of files) {
    const source = await readTextFileSecure(file, { maxBytes: LIMITS.sourceBytes, allowSymlink: true });
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of rules) {
        if (rule.regex.test(line)) findings.push({ ...rule, file: path.relative(root, file), line: index + 1 });
        rule.regex.lastIndex = 0;
      }
    });
  }
  const configFile = path.join(root, 'kura.json');
  if (await exists(configFile)) {
    const configText = await readTextFileSecure(configFile, { maxBytes: LIMITS.configBytes, allowSymlink: false });
    const config = validateProjectConfig(parseJsonSecure(configText, configFile), configFile);
    if (config.entry) assertInsideRoot(path.resolve(root, config.entry), root, 'configured entry');
  } else {
    findings.push({ id: 'KR-AUDIT-010', severity: 'low', file: 'kura.json', line: 1, message: 'No project configuration file was found.' });
  }
  return {
    root,
    scannedFiles: files.length,
    findings,
    counts: findings.reduce((acc, item) => ({ ...acc, [item.severity]: (acc[item.severity] ?? 0) + 1 }), {}),
    ok: !findings.some(item => item.severity === 'high'),
  };
}

async function assertPathHasNoSymlink(candidate, boundary) {
  const resolvedBoundary = path.resolve(boundary);
  let current = path.resolve(candidate);
  assertInsideRoot(current, resolvedBoundary, 'path');
  while (true) {
    if (await exists(current)) {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new KuraSecurityError(`A symbolic link was found in a protected path: ${current}`, { code: 'KR-SEC-0205', file: current });
      }
    }
    if (current === resolvedBoundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function offsetToLocation(text, offset) {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
