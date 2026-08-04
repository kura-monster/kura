// SPDX-License-Identifier: MIT OR Apache-2.0
import { KuraSystemError, formatSystemType } from './system.mjs';

const KEYWORDS = new Set([
  'fn', 'let', 'const', 'static', 'if', 'else', 'while', 'return',
  'true', 'false', 'struct', 'pub', 'unsafe', 'extern', 'mut',
]);

export class KuraNativeCompileError extends KuraSystemError {
  constructor(message, token = {}, options = {}) {
    super(message, {
      code: options.code ?? 'KR-NATIVE-0001',
      details: {
        file: options.file ?? '<input>',
        line: token.line ?? 1,
        column: token.column ?? 1,
        hint: options.hint ?? null,
      },
    });
    this.name = 'KuraNativeCompileError';
    this.file = options.file ?? '<input>';
    this.line = token.line ?? 1;
    this.column = token.column ?? 1;
    this.hint = options.hint ?? null;
  }
}

export function fail(message, token, context, code = 'KR-NATIVE-0001', hint = null) {
  throw new KuraNativeCompileError(message, token, { file: context.file, code, hint });
}

export function decodeString(token, context) {
  try { return JSON.parse(token.value); }
  catch { fail('Invalid string literal.', token, context, 'KR-NATIVE-LEX-0002'); }
}

export function tokenizeNativeSource(source, options = {}) {
  const file = options.file ?? '<input>';
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const push = (type, value, startLine, startColumn) => tokens.push({ type, value, line: startLine, column: startColumn });

  while (index < source.length) {
    const startLine = line;
    const startColumn = column;
    const char = source[index];
    if (/[ \t\r]/.test(char)) { index++; column++; continue; }
    if (char === '\n') { index++; line++; column = 1; continue; }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') { index++; column++; }
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2; column += 2;
      let depth = 1;
      while (index < source.length && depth) {
        if (source.slice(index, index + 2) === '/*') { depth++; index += 2; column += 2; }
        else if (source.slice(index, index + 2) === '*/') { depth--; index += 2; column += 2; }
        else if (source[index] === '\n') { index++; line++; column = 1; }
        else { index++; column++; }
      }
      if (depth) throw new KuraNativeCompileError('Unclosed block comment.', { line: startLine, column: startColumn }, { file, code: 'KR-NATIVE-LEX-0001' });
      continue;
    }
    if (char === '"') {
      let raw = '"';
      index++; column++;
      let closed = false;
      while (index < source.length) {
        const current = source[index++];
        raw += current;
        column++;
        if (current === '\\' && index < source.length) { raw += source[index++]; column++; continue; }
        if (current === '"') { closed = true; break; }
        if (current === '\n') break;
      }
      if (!closed) throw new KuraNativeCompileError('Unclosed string literal.', { line: startLine, column: startColumn }, { file, code: 'KR-NATIVE-LEX-0002' });
      push('string', raw, startLine, startColumn);
      continue;
    }
    if (/[0-9]/.test(char)) {
      const match = /^(?:0[xX][\dA-Fa-f](?:_?[\dA-Fa-f])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|\d(?:_?\d)*)/.exec(source.slice(index));
      index += match[0].length;
      column += match[0].length;
      push('number', match[0], startLine, startColumn);
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) { value += source[index++]; column++; }
      push(KEYWORDS.has(value) ? 'keyword' : 'identifier', value, startLine, startColumn);
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (['#!', '->', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '<<', '>>', '::'].includes(pair)) {
      index += 2; column += 2; push('symbol', pair, startLine, startColumn); continue;
    }
    if ('@{}()[];,:.+-*/%<>=!&|^~'.includes(char)) {
      index++; column++; push('symbol', char, startLine, startColumn); continue;
    }
    throw new KuraNativeCompileError(`Unsupported character ${JSON.stringify(char)}.`, { line: startLine, column: startColumn }, { file, code: 'KR-NATIVE-LEX-0004' });
  }
  tokens.push({ type: 'eof', value: '', line, column });
  return tokens;
}

export function integerLiteral(value) {
  return BigInt(value.replaceAll('_', '')).toString();
}

export function parseInteger(value) {
  return BigInt(value.replaceAll('_', ''));
}

export function safeName(value) {
  return value.replace(/[^A-Za-z0-9_.$]/g, '_');
}

export const typeEquals = (left, right) => formatSystemType(left) === formatSystemType(right);
export const isInteger = type => type?.kind === 'integer';
export const isPointer = type => type?.kind === 'pointer';
export const attribute = (declaration, name) => declaration.attributes?.find(item => item.name === name) ?? null;
export const hasAttribute = (declaration, name) => Boolean(attribute(declaration, name));
