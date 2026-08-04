// SPDX-License-Identifier: MIT OR Apache-2.0
import { KuraCliError } from './diagnostics.mjs';

const OPERATORS = new Set(['=', '==', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '&&', '||', '??', '->', '=>', '+=', '-=', '*=', '/=']);
const CONTROL_WORDS = new Set(['if', 'while', 'for', 'match']);

export function formatKura(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('formatKura expects a string');
  const indentText = options.useTabs ? '\t' : ' '.repeat(clamp(options.indentWidth ?? 2, 1, 8));
  const tokens = scan(source);
  const lines = [];
  let current = '';
  let depth = 0;
  let pendingBlank = 0;
  let previous = null;

  const indentation = () => indentText.repeat(Math.max(0, depth));
  const write = text => {
    if (!current) current = indentation();
    current += text;
  };
  const trimRight = () => { current = current.replace(/[ \t]+$/g, ''); };
  const newline = (force = false) => {
    trimRight();
    const body = current.trimEnd();
    if (body.trim() || force) lines.push(body);
    current = '';
  };
  const blank = () => {
    newline();
    pendingBlank = Math.max(pendingBlank, 1);
  };
  const flushBlank = () => {
    if (pendingBlank && lines.length && lines.at(-1) !== '') lines.push('');
    pendingBlank = 0;
  };
  const ensureSpace = () => {
    if (!current) current = indentation();
    if (!/[ \t]$/.test(current)) current += ' ';
  };
  const nextSignificant = index => {
    for (let i = index + 1; i < tokens.length; i++) if (!['newline', 'whitespace'].includes(tokens[i].type)) return tokens[i];
    return null;
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'whitespace') continue;
    if (token.type === 'newline') {
      if (current.trim()) newline();
      else if (previous?.type === 'newline') pendingBlank = 1;
      previous = token;
      continue;
    }
    flushBlank();

    if (token.type === 'lineComment') {
      if (current.trim()) ensureSpace();
      write(token.value.trimEnd());
      newline(true);
      previous = token;
      continue;
    }
    if (token.type === 'blockComment') {
      if (current.trim()) ensureSpace();
      const commentLines = token.value.split(/\r?\n/);
      if (commentLines.length === 1) write(commentLines[0]);
      else {
        write(commentLines[0].trimEnd());
        newline(true);
        for (let i = 1; i < commentLines.length; i++) {
          write(commentLines[i].trim());
          newline(true);
        }
      }
      previous = token;
      continue;
    }

    const value = token.value;
    if (value === '}') {
      if (current.trim()) newline();
      depth = Math.max(0, depth - 1);
      write('}');
      const next = nextSignificant(index);
      if (next?.value === 'else') ensureSpace();
      else if (next?.value === ';' || next?.value === ',' || next?.value === ')') {
        // Keep the line open for punctuation.
      } else newline();
      previous = token;
      continue;
    }
    if (value === '{') {
      if (current.trim()) ensureSpace();
      write('{');
      newline(true);
      depth++;
      previous = token;
      continue;
    }
    if (value === ';') {
      trimRight();
      write(';');
      const next = nextSignificant(index);
      if (next?.type === 'lineComment') ensureSpace();
      else newline(true);
      previous = token;
      continue;
    }
    if (value === ',') {
      trimRight();
      write(',');
      ensureSpace();
      previous = token;
      continue;
    }
    if (value === ':') {
      trimRight();
      write(':');
      ensureSpace();
      previous = token;
      continue;
    }
    if (value === '.') {
      trimRight();
      write('.');
      previous = token;
      continue;
    }
    if (value === '(') {
      const previousWord = previous?.type === 'word' ? previous.value : null;
      trimRight();
      if (previousWord && CONTROL_WORDS.has(previousWord)) write(' ');
      write('(');
      previous = token;
      continue;
    }
    if (value === '[') {
      trimRight();
      write('[');
      previous = token;
      continue;
    }
    if (value === ')' || value === ']') {
      trimRight();
      write(value);
      previous = token;
      continue;
    }
    if (OPERATORS.has(value)) {
      trimRight();
      ensureSpace();
      write(value);
      ensureSpace();
      previous = token;
      continue;
    }
    if (value === '!') {
      if (previous?.type === 'word' || previous?.type === 'number' || previous?.type === 'string') ensureSpace();
      write('!');
      previous = token;
      continue;
    }

    const needsSpace = current.trim() && !/[\s.(\[]$/.test(current) && ![')', ']', '.', ','].includes(previous?.value);
    if (needsSpace) ensureSpace();
    write(value);
    previous = token;
  }

  if (current.trim()) newline();
  while (lines.length && lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

export function checkFormatting(source, options = {}) {
  const formatted = formatKura(source, options);
  return { formatted, changed: formatted !== source };
}

function scan(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === ' ' || char === '\t' || char === '\r') {
      let end = index + 1;
      while (end < source.length && [' ', '\t', '\r'].includes(source[end])) end++;
      tokens.push({ type: 'whitespace', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (char === '\n') {
      tokens.push({ type: 'newline', value: '\n' }); index++; continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      let end = index + 2;
      while (end < source.length && source[end] !== '\n') end++;
      tokens.push({ type: 'lineComment', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      let end = index + 2; let depth = 1;
      while (end < source.length && depth > 0) {
        if (source[end] === '/' && source[end + 1] === '*') { depth++; end += 2; continue; }
        if (source[end] === '*' && source[end + 1] === '/') { depth--; end += 2; continue; }
        end++;
      }
      if (depth > 0) throw new KuraCliError('A block comment is missing */.', { code: 'KR-FMT-0101', title: 'Formatter found an unclosed comment', hint: 'Close the comment before formatting.' });
      tokens.push({ type: 'blockComment', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char; let end = index + 1; let closed = false;
      while (end < source.length) {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === quote) { end++; closed = true; break; }
        end++;
      }
      if (!closed) throw new KuraCliError('A string is missing its closing quote.', { code: 'KR-FMT-0102', title: 'Formatter found an unclosed string', hint: `Add ${quote} before formatting.` });
      tokens.push({ type: 'string', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end++;
      tokens.push({ type: 'word', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[0-9A-Za-z_.]/.test(source[end])) end++;
      tokens.push({ type: 'number', value: source.slice(index, end) });
      index = end;
      continue;
    }
    const three = source.slice(index, index + 3);
    const two = source.slice(index, index + 2);
    if (three === '...') { tokens.push({ type: 'symbol', value: three }); index += 3; continue; }
    if (['->', '=>', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '::', '?.', '??'].includes(two)) {
      tokens.push({ type: 'symbol', value: two }); index += 2; continue;
    }
    tokens.push({ type: 'symbol', value: char }); index++;
  }
  return tokens;
}

function clamp(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.trunc(number))) : minimum;
}
