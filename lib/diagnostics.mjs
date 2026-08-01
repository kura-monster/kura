// SPDX-License-Identifier: MIT OR Apache-2.0
import path from 'node:path';
import process from 'node:process';

const SECRET_PATTERN = /(authorization|bearer|token|secret|password|passwd|api[_-]?key|private[_-]?key|session|cookie)(\s*[:=]\s*)([^\s,;]+)/gi;
const COMMANDS = ['new','run','build','check','fmt','bindgen','sql-check','gpu','doctor','bench','velocity','security','version','help'];

export class KuraCliError extends Error {
  constructor(summary, options = {}) {
    super(summary, options.cause ? { cause: options.cause } : undefined);
    this.name = 'KuraCliError';
    this.code = options.code ?? 'KR-CLI-0001';
    this.title = options.title ?? 'Kura could not complete the command';
    this.hint = options.hint ?? null;
    this.details = options.details ?? null;
    this.file = options.file ?? null;
    this.line = options.line ?? null;
    this.column = options.column ?? null;
    this.length = options.length ?? 1;
    this.source = options.source ?? null;
    this.exitCode = options.exitCode ?? 1;
    this.showStack = options.showStack ?? false;
  }
}

export function redactSecrets(value) {
  return String(value ?? '').replace(SECRET_PATTERN, (_match, key, separator) => `${key}${separator}[REDACTED]`);
}

export function suggestCommand(input) {
  let best = null;
  let score = Infinity;
  for (const command of COMMANDS) {
    const distance = levenshtein(input, command);
    if (distance < score) {
      score = distance;
      best = command;
    }
  }
  return score <= Math.max(2, Math.floor(String(input).length / 3)) ? best : null;
}

export async function printFriendlyError(error, options = {}) {
  const normalized = normalizeError(error);
  const source = normalized.source ?? options.source ?? null;
  const json = options.json === true;
  const verbose = options.verbose === true;

  if (json) {
    const payload = {
      ok: false,
      error: {
        code: normalized.code,
        title: normalized.title,
        summary: redactSecrets(normalized.message),
        hint: normalized.hint ? redactSecrets(normalized.hint) : null,
        details: normalized.details ? redactSecrets(normalized.details) : null,
        file: normalized.file,
        line: normalized.line,
        column: normalized.column,
        length: normalized.length,
      },
    };
    console.error(JSON.stringify(payload, null, 2));
    return;
  }

  const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
  const c = colorizer(useColor);
  const location = normalized.file
    ? `${relativeDisplay(normalized.file)}${normalized.line ? `:${normalized.line}${normalized.column ? `:${normalized.column}` : ''}` : ''}`
    : null;

  console.error('');
  console.error(`${c.red('Kura Error')} ${c.dim(`[${normalized.code}]`)}`);
  console.error(c.bold(normalized.title));
  console.error(`  ${redactSecrets(normalized.message)}`);

  if (location) console.error(`\n  ${c.cyan('-->')} ${location}`);
  if (source && normalized.line) {
    const frame = renderCodeFrame(source, normalized.line, normalized.column ?? 1, normalized.length ?? 1, c);
    if (frame) console.error(frame);
  }

  if (normalized.hint) console.error(`\n${c.green('Help:')} ${redactSecrets(normalized.hint)}`);
  if (normalized.details) console.error(`${c.yellow('Details:')} ${redactSecrets(normalized.details)}`);
  if (normalized.file && normalized.line) {
    console.error(`${c.blue('Docs:')} https://kr.klyn.site/docs#diagnostics`);
  }
  if (verbose && error?.stack) {
    console.error(`\n${c.dim('Technical details:')}`);
    console.error(c.dim(redactSecrets(error.stack)));
  } else {
    console.error(c.dim('\nRun the same command with --verbose for technical details.'));
  }
}

export function normalizeError(error) {
  if (error instanceof KuraCliError) return error;
  if (error && typeof error === 'object') {
    const summary = error.summary ?? error.message ?? String(error);
    return new KuraCliError(summary, {
      code: error.code ?? inferSystemCode(error),
      title: error.title ?? inferTitle(error),
      hint: error.hint ?? inferHint(error),
      details: error.details ?? null,
      file: error.file ?? null,
      line: error.line ?? null,
      column: error.column ?? null,
      length: error.length ?? 1,
      source: error.source ?? null,
      cause: error,
      exitCode: error.exitCode ?? 1,
    });
  }
  return new KuraCliError(String(error));
}

function inferSystemCode(error) {
  switch (error?.code) {
    case 'ENOENT': return 'KR-FS-0001';
    case 'EACCES':
    case 'EPERM': return 'KR-FS-0002';
    case 'EISDIR': return 'KR-FS-0003';
    case 'ELOOP': return 'KR-SEC-0004';
    default: return 'KR-CLI-0001';
  }
}

function inferTitle(error) {
  switch (error?.code) {
    case 'ENOENT': return 'The requested file was not found';
    case 'EACCES':
    case 'EPERM': return 'Kura does not have permission to access this path';
    case 'EISDIR': return 'A file was expected, but a directory was provided';
    default: return error?.name === 'SyntaxError' ? 'A configuration file is not valid JSON' : 'Kura could not complete the command';
  }
}

function inferHint(error) {
  switch (error?.code) {
    case 'ENOENT': return 'Check the path, file name, and current directory, then try again.';
    case 'EACCES':
    case 'EPERM': return 'Choose a writable project directory or update the file permissions.';
    case 'EISDIR': return 'Pass the path to a .kr file instead of a directory.';
    default: return null;
  }
}

function renderCodeFrame(source, lineNumber, column, length, c) {
  const lines = String(source).split(/\r?\n/);
  if (lineNumber < 1 || lineNumber > lines.length) return '';
  const start = Math.max(1, lineNumber - 1);
  const end = Math.min(lines.length, lineNumber + 1);
  const width = String(end).length;
  const output = [''];
  for (let line = start; line <= end; line++) {
    const marker = line === lineNumber ? c.red('>') : ' ';
    output.push(` ${marker} ${String(line).padStart(width)} | ${lines[line - 1]}`);
    if (line === lineNumber) {
      const safeColumn = Math.max(1, Math.min(column, lines[line - 1].length + 1));
      const safeLength = Math.max(1, Math.min(length, Math.max(1, lines[line - 1].length - safeColumn + 2)));
      output.push(`   ${' '.repeat(width)} | ${' '.repeat(safeColumn - 1)}${c.red('^'.repeat(safeLength))}`);
    }
  }
  return output.join('\n');
}

function relativeDisplay(file) {
  if (file === '<input>') return file;
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') ? relative : file;
}

function colorizer(enabled) {
  const wrap = code => value => enabled ? `\u001b[${code}m${value}\u001b[0m` : String(value);
  return {
    red: wrap('31'), green: wrap('32'), yellow: wrap('33'), blue: wrap('34'), cyan: wrap('36'),
    bold: wrap('1'), dim: wrap('2'),
  };
}

function levenshtein(a, b) {
  const left = String(a);
  const right = String(b);
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const old = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = old;
    }
  }
  return previous[right.length];
}
