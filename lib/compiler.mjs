// SPDX-License-Identifier: MIT OR Apache-2.0

const KEYWORDS = new Set([
  'fn', 'let', 'const', 'if', 'else', 'while', 'for', 'in', 'return',
  'true', 'false', 'null', 'struct', 'enum', 'match', 'import', 'from',
  'export', 'async', 'await', 'trait', 'impl', 'where', 'pure', 'kernel', 'comptime',
]);

const INTERNAL_PREFIX = '__kr_';
const FORBIDDEN_BINDINGS = new Set(['__proto__', 'prototype', 'constructor', 'eval', 'Function']);
const STRICT_GLOBALS = new Set([
  'process', 'global', 'globalThis', 'require', 'module', 'Buffer', 'WebAssembly',
  'eval', 'Function', 'Deno', 'Bun',
]);
const DANGEROUS_NODE_MODULES = new Set([
  'node:child_process', 'node:cluster', 'node:dgram', 'node:dns', 'node:fs',
  'node:http', 'node:https', 'node:module', 'node:net', 'node:process', 'node:tls',
  'node:vm', 'node:worker_threads', 'node:wasi',
]);

export class KuraCompileError extends Error {
  constructor(summary, file = '<input>', line = 1, column = 1, options = {}) {
    super(summary);
    this.name = 'KuraCompileError';
    this.code = options.code ?? 'KR-PARSE-0001';
    this.title = options.title ?? 'Kura could not understand this code';
    this.hint = options.hint ?? null;
    this.details = options.details ?? null;
    this.file = file;
    this.line = line;
    this.column = column;
    this.length = options.length ?? 1;
    this.source = options.source ?? null;
  }
}

function compileError(summary, token, parser, options = {}) {
  return new KuraCompileError(summary, parser.file, token?.line ?? 1, token?.column ?? 1, {
    ...options,
    length: options.length ?? Math.max(1, token?.length ?? 1),
    source: parser.source,
  });
}

export function tokenize(source, file = '<input>') {
  if (typeof source !== 'string') {
    throw new KuraCompileError('The compiler expected source code as text.', file, 1, 1, {
      code: 'KR-INPUT-0001',
      title: 'Invalid compiler input',
      hint: 'Pass a UTF-8 string to compile(), parse(), or diagnose().',
    });
  }

  const tokens = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (type, value, startLine, startColumn, startOffset, endOffset = i) => {
    tokens.push({ type, value, line: startLine, column: startColumn, offset: startOffset, length: Math.max(1, endOffset - startOffset) });
  };

  while (i < source.length) {
    const char = source[i];
    const startLine = line;
    const startColumn = column;
    const startOffset = i;

    if (char === ' ' || char === '\t' || char === '\r') {
      i++;
      column++;
      continue;
    }
    if (char === '\n') {
      i++;
      line++;
      column = 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        i++;
        column++;
      }
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      i += 2;
      column += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          if (depth > 64) {
            throw new KuraCompileError('Block comments are nested too deeply.', file, line, column, {
              code: 'KR-SEC-1001',
              title: 'Comment nesting exceeded the safe limit',
              hint: 'Reduce nested block comments to fewer than 64 levels.',
              source,
              length: 2,
            });
          }
          i += 2;
          column += 2;
          continue;
        }
        if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          i += 2;
          column += 2;
          continue;
        }
        if (source[i] === '\n') {
          i++;
          line++;
          column = 1;
        } else {
          i++;
          column++;
        }
      }
      if (depth > 0) {
        throw new KuraCompileError('This block comment is missing its closing */.', file, startLine, startColumn, {
          code: 'KR-LEX-1001',
          title: 'Unclosed block comment',
          hint: 'Add */ where the comment should end.',
          source,
          length: 2,
        });
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = quote;
      i++;
      column++;
      let closed = false;
      while (i < source.length) {
        const current = source[i];
        if (current === '\n' || current === '\r') {
          throw new KuraCompileError('A string cannot continue onto the next line without an escape.', file, line, column, {
            code: 'KR-LEX-1002',
            title: 'String literal ended unexpectedly',
            hint: `Close the string with ${quote}, or use \\n inside the string.`,
            source,
          });
        }
        value += current;
        i++;
        column++;
        if (current === '\\') {
          if (i >= source.length) break;
          value += source[i];
          i++;
          column++;
          continue;
        }
        if (current === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new KuraCompileError(`This string is missing its closing ${quote}.`, file, startLine, startColumn, {
          code: 'KR-LEX-1003',
          title: 'Unclosed string literal',
          hint: `Add ${quote} at the end of the string.`,
          source,
        });
      }
      push('string', value, startLine, startColumn, startOffset);
      continue;
    }
    if (/[0-9]/.test(char)) {
      const rest = source.slice(i);
      const match = /^(?:0[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|(?:[0-9](?:_?[0-9])*)(?:\.(?:[0-9](?:_?[0-9])*)?)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/.exec(rest);
      if (!match) {
        throw new KuraCompileError('This number is not written in a valid format.', file, startLine, startColumn, {
          code: 'KR-LEX-1004',
          title: 'Invalid numeric literal',
          hint: 'Examples: 42, 3.14, 1_000, 0xff, 0b1010.',
          source,
        });
      }
      const value = match[0];
      i += value.length;
      column += value.length;
      push('number', value, startLine, startColumn, startOffset);
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
        value += source[i++];
        column++;
      }
      push(KEYWORDS.has(value) ? 'keyword' : 'identifier', value, startLine, startColumn, startOffset);
      continue;
    }

    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (three === '...') {
      i += 3;
      column += 3;
      push('symbol', three, startLine, startColumn, startOffset);
      continue;
    }
    if (['->', '=>', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '::', '?.', '??'].includes(two)) {
      i += 2;
      column += 2;
      push('symbol', two, startLine, startColumn, startOffset);
      continue;
    }
    if ('{}()[];,:.+-*/%<>=!&|?'.includes(char)) {
      i++;
      column++;
      push('symbol', char, startLine, startColumn, startOffset);
      continue;
    }

    throw new KuraCompileError(`Kura does not recognize the character ${JSON.stringify(char)}.`, file, startLine, startColumn, {
      code: 'KR-LEX-1005',
      title: 'Unexpected character',
      hint: 'Remove the character or replace it with a supported Kura symbol.',
      source,
    });
  }

  tokens.push({ type: 'eof', value: '', line, column, offset: i, length: 1 });
  return tokens;
}

class Parser {
  constructor(tokens, file, source) {
    this.tokens = tokens;
    this.index = 0;
    this.file = file;
    this.source = source;
  }

  current() { return this.tokens[this.index]; }
  next() { return this.tokens[this.index++]; }
  at(value) { return this.current().value === value; }
  match(value) { if (this.at(value)) { this.index++; return true; } return false; }

  expect(value, hint = null) {
    const token = this.current();
    if (token.value !== value) {
      throw compileError(`Expected '${value}', but found '${token.value || 'end of file'}'.`, token, this, {
        code: 'KR-PARSE-1101',
        title: `Missing or misplaced '${value}'`,
        hint: hint ?? `Add '${value}' before this position.`,
      });
    }
    return this.next();
  }

  expectIdentifier(purpose = 'name') {
    const token = this.current();
    if (token.type !== 'identifier') {
      throw compileError(`Expected a ${purpose}, but found '${token.value || 'end of file'}'.`, token, this, {
        code: 'KR-PARSE-1102',
        title: `Kura needs a valid ${purpose}`,
        hint: 'Use a name beginning with a letter or underscore, followed by letters, numbers, or underscores.',
      });
    }
    this.assertSafeBinding(token.value, token);
    return this.next().value;
  }

  assertSafeBinding(name, token) {
    if (name.startsWith(INTERNAL_PREFIX)) {
      throw compileError(`Names beginning with '${INTERNAL_PREFIX}' are reserved by the Kura runtime.`, token, this, {
        code: 'KR-SEC-1101',
        title: 'Reserved identifier',
        hint: `Rename '${name}' without the ${INTERNAL_PREFIX} prefix.`,
      });
    }
    if (FORBIDDEN_BINDINGS.has(name)) {
      throw compileError(`The name '${name}' is blocked because it can modify JavaScript object behavior.`, token, this, {
        code: 'KR-SEC-1102',
        title: 'Unsafe identifier blocked',
        hint: 'Choose a descriptive application-specific name instead.',
      });
    }
  }

  parse() {
    const body = [];
    while (this.current().type !== 'eof') body.push(this.declaration());
    return { kind: 'Program', body };
  }

  declaration() {
    const exported = this.match('export');
    const async = this.match('async');
    const pure = this.match('pure');
    const kernel = this.match('kernel');
    if (this.match('fn')) return this.functionDeclaration(exported, async, pure, kernel);
    if (this.match('struct')) return this.structDeclaration(exported);
    if (this.match('enum')) return this.enumDeclaration(exported);
    if (this.match('import')) return this.importDeclaration();
    return this.statement();
  }

  functionDeclaration(exported, async, pure, kernel) {
    const token = this.current();
    const name = this.expectIdentifier('function name');
    this.expect('(', 'Function parameters must be placed inside parentheses.');
    const params = [];
    while (!this.at(')')) {
      const paramToken = this.current();
      const paramName = this.expectIdentifier('parameter name');
      let type = null;
      if (this.match(':')) type = this.typeName();
      params.push({ name: paramName, type, line: paramToken.line, column: paramToken.column });
      if (!this.match(',')) break;
    }
    this.expect(')', 'Close the parameter list with a right parenthesis.');
    let returnType = null;
    if (this.match('->')) returnType = this.typeName();
    const body = this.block();
    return { kind: 'Function', name, params, body, returnType, exported, async, pure, kernel, line: token.line, column: token.column };
  }

  structDeclaration(exported) {
    const token = this.current();
    const name = this.expectIdentifier('struct name');
    this.expect('{');
    const fields = [];
    while (!this.at('}')) {
      const fieldToken = this.current();
      const fieldName = this.expectIdentifier('field name');
      this.expect(':', 'Struct fields use the form: name: Type');
      const type = this.typeName();
      this.match(',');
      this.match(';');
      fields.push({ name: fieldName, type, line: fieldToken.line, column: fieldToken.column });
    }
    this.expect('}');
    return { kind: 'Struct', name, fields, exported, line: token.line, column: token.column };
  }

  enumDeclaration(exported) {
    const token = this.current();
    const name = this.expectIdentifier('enum name');
    this.expect('{');
    const variants = [];
    while (!this.at('}')) {
      const variantToken = this.current();
      const variantName = this.expectIdentifier('enum variant');
      const fields = [];
      if (this.match('(')) {
        while (!this.at(')')) {
          fields.push(this.typeName());
          if (!this.match(',')) break;
        }
        this.expect(')');
      }
      variants.push({ name: variantName, fields, line: variantToken.line, column: variantToken.column });
      this.match(',');
    }
    this.expect('}');
    return { kind: 'Enum', name, variants, exported, line: token.line, column: token.column };
  }

  importDeclaration() {
    const token = this.current();
    const names = [];
    if (this.match('{')) {
      while (!this.at('}')) {
        names.push(this.expectIdentifier('imported name'));
        if (!this.match(',')) break;
      }
      this.expect('}');
    } else {
      names.push(this.expectIdentifier('imported name'));
    }
    this.expect('from', "Imports use the form: import name from \"package\";");
    const sourceToken = this.next();
    let specifier;
    if (sourceToken.type === 'string') {
      specifier = decodeStringLiteral(sourceToken.value, sourceToken, this);
    } else if (sourceToken.type === 'identifier' && this.match(':')) {
      const valueToken = this.next();
      if (valueToken.type !== 'string') {
        throw compileError(`Expected a quoted module name after '${sourceToken.value}:'.`, valueToken, this, {
          code: 'KR-PARSE-1201',
          title: 'Invalid import source',
          hint: `Example: import express from ${sourceToken.value}:\"express\";`,
        });
      }
      specifier = `${sourceToken.value}:${decodeStringLiteral(valueToken.value, valueToken, this)}`;
    } else {
      throw compileError('Expected a quoted import source.', sourceToken, this, {
        code: 'KR-PARSE-1202',
        title: 'Invalid import source',
        hint: 'Examples: from "./module.mjs", from npm:"express", or from node:"path".',
      });
    }
    this.match(';');
    return { kind: 'Import', names, source: specifier, line: token.line, column: token.column };
  }

  typeName() {
    let output = '';
    let depth = 0;
    while (true) {
      const token = this.current();
      if (token.type === 'eof') break;
      if (depth === 0 && [',', ')', '{', ';', '=', '}'].includes(token.value)) break;
      if (token.value === '<') depth++;
      if (token.value === '>') depth--;
      output += this.next().value;
      if (depth < 0) break;
    }
    return output || 'unknown';
  }

  block() {
    this.expect('{', 'Start the block with a left brace.');
    const body = [];
    while (!this.at('}')) {
      if (this.current().type === 'eof') {
        throw compileError('This block reaches the end of the file before a closing brace.', this.current(), this, {
          code: 'KR-PARSE-1103',
          title: 'Unclosed code block',
          hint: 'Add } to close the function, loop, or conditional block.',
        });
      }
      body.push(this.declaration());
    }
    this.expect('}');
    return body;
  }

  statement() {
    if (this.match('let') || this.match('const')) {
      const keywordToken = this.tokens[this.index - 1];
      const name = this.expectIdentifier('variable name');
      let type = null;
      if (this.match(':')) type = this.typeNameUntil(new Set(['=', ';']));
      let init = null;
      if (this.match('=')) init = this.expression();
      this.match(';');
      return { kind: 'Variable', keyword: keywordToken.value, name, type, init, line: keywordToken.line, column: keywordToken.column };
    }
    if (this.match('return')) {
      const token = this.tokens[this.index - 1];
      const value = this.at(';') || this.at('}') ? null : this.expression();
      this.match(';');
      return { kind: 'Return', value, line: token.line, column: token.column };
    }
    if (this.match('if')) {
      const token = this.tokens[this.index - 1];
      const test = this.parenthesizedOrExpression();
      const consequent = this.block();
      let alternate = null;
      if (this.match('else')) alternate = this.at('if') ? [this.statement()] : this.block();
      return { kind: 'If', test, consequent, alternate, line: token.line, column: token.column };
    }
    if (this.match('while')) {
      const token = this.tokens[this.index - 1];
      return { kind: 'While', test: this.parenthesizedOrExpression(), body: this.block(), line: token.line, column: token.column };
    }
    if (this.match('for')) {
      const token = this.tokens[this.index - 1];
      const name = this.expectIdentifier('loop variable');
      this.expect('in', "A for loop uses 'for item in collection'.");
      return { kind: 'For', name, iterable: this.expression(), body: this.block(), line: token.line, column: token.column };
    }
    const expression = this.expression();
    this.match(';');
    return { kind: 'ExpressionStatement', expression, line: expression.line, column: expression.column };
  }

  typeNameUntil(stop) {
    let output = '';
    while (this.current().type !== 'eof' && !stop.has(this.current().value)) output += this.next().value;
    return output;
  }

  parenthesizedOrExpression() {
    if (this.match('(')) {
      const expression = this.expression();
      this.expect(')', 'Close the condition with a right parenthesis.');
      return expression;
    }
    return this.expression();
  }

  expression(minimumPrecedence = 0) {
    let left = this.prefix();
    const precedence = { '=': 1, '??': 2, '||': 3, '&&': 4, '==': 5, '!=': 5, '<': 6, '>': 6, '<=': 6, '>=': 6, '+': 7, '-': 7, '*': 8, '/': 8, '%': 8 };
    while (true) {
      const operation = this.current().value;
      const operationPrecedence = precedence[operation] ?? -1;
      if (operationPrecedence < minimumPrecedence) break;
      const token = this.next();
      const right = this.expression(operationPrecedence + (operation === '=' ? 0 : 1));
      left = { kind: 'Binary', op: operation, left, right, line: token.line, column: token.column };
    }
    return left;
  }

  prefix() {
    const token = this.next();
    let node;
    if (token.value === '!' || token.value === '-' || token.value === '+') {
      node = { kind: 'Unary', op: token.value, value: this.expression(9), line: token.line, column: token.column };
    } else if (token.value === 'await') {
      node = { kind: 'Await', value: this.expression(9), line: token.line, column: token.column };
    } else if (token.type === 'number' || token.type === 'string' || ['true', 'false', 'null'].includes(token.value)) {
      node = { kind: 'Literal', value: token.value, line: token.line, column: token.column };
    } else if (token.type === 'identifier' || token.type === 'keyword') {
      node = { kind: 'Identifier', name: token.value, line: token.line, column: token.column };
    } else if (token.value === '(') {
      node = this.expression();
      this.expect(')', 'Close this expression with a right parenthesis.');
    } else if (token.value === '[') {
      const items = [];
      while (!this.at(']')) {
        items.push(this.expression());
        if (!this.match(',')) break;
      }
      this.expect(']', 'Close the array with a right bracket.');
      node = { kind: 'Array', items, line: token.line, column: token.column };
    } else {
      throw compileError(`An expression cannot begin with '${token.value || 'end of file'}'.`, token, this, {
        code: 'KR-PARSE-1104',
        title: 'Incomplete expression',
        hint: 'Add a value, variable, function call, or parenthesized expression here.',
      });
    }

    while (true) {
      if (this.match('(')) {
        const args = [];
        while (!this.at(')')) {
          args.push(this.expression());
          if (!this.match(',')) break;
        }
        this.expect(')', 'Close the function call with a right parenthesis.');
        node = { kind: 'Call', callee: node, args, line: node.line, column: node.column };
        continue;
      }
      if (this.match('.')) {
        const propertyToken = this.current();
        const property = this.expectIdentifier('property name');
        node = { kind: 'Member', object: node, property, line: propertyToken.line, column: propertyToken.column };
        continue;
      }
      if (this.match('[')) {
        const index = this.expression();
        this.expect(']', 'Close the index expression with a right bracket.');
        node = { kind: 'Index', object: node, index, line: node.line, column: node.column };
        continue;
      }
      break;
    }
    return node;
  }
}

export function parse(source, options = {}) {
  const file = options.file ?? '<input>';
  return new Parser(tokenize(source, file), file, source).parse();
}

function decodeStringLiteral(raw, token = null, parser = null) {
  const quote = raw[0];
  const body = raw.slice(1, -1);
  let output = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== '\\') {
      output += char;
      continue;
    }
    i++;
    if (i >= body.length) throw invalidEscape(raw, token, parser);
    const escaped = body[i];
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'" };
    if (escaped in simple) {
      output += simple[escaped];
      continue;
    }
    if (escaped === 'x') {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw invalidEscape(raw, token, parser);
      output += String.fromCharCode(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    if (escaped === 'u') {
      const hex = body.slice(i + 1, i + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw invalidEscape(raw, token, parser);
      output += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
      continue;
    }
    if (escaped === quote) {
      output += quote;
      continue;
    }
    throw invalidEscape(raw, token, parser);
  }
  return output;
}

function invalidEscape(raw, token, parser) {
  return new KuraCompileError(`The string ${raw} contains an invalid escape sequence.`, parser?.file ?? '<input>', token?.line ?? 1, token?.column ?? 1, {
    code: 'KR-LEX-1006',
    title: 'Invalid string escape',
    hint: 'Use supported escapes such as \\n, \\t, \\\\, \\" or \\u0041.',
    source: parser?.source ?? null,
    length: token?.length ?? 1,
  });
}

function validateProgramSecurity(ast, source, options) {
  const mode = options.securityMode ?? 'standard';
  const file = options.file ?? '<input>';
  const visit = node => {
    if (node.kind === 'Import') {
      node.source = normalizeImportSpecifier(node.source, mode, file, node, source);
    }
    if (mode === 'strict' && node.kind === 'Identifier' && STRICT_GLOBALS.has(node.name)) {
      throw new KuraCompileError(`Strict security mode blocks direct access to '${node.name}'.`, file, node.line ?? 1, node.column ?? 1, {
        code: 'KR-SEC-1201',
        title: 'Restricted global capability',
        hint: 'Remove the global access, or rerun without --secure only when the code is trusted.',
        source,
        length: node.name.length,
      });
    }
  };
  walkStatements(ast.body, visit);
}

function normalizeImportSpecifier(specifier, mode, file, node, source) {
  let value = String(specifier);
  if (value.length > 512 || /[\0-\x1f\x7f]/.test(value)) {
    throw new KuraCompileError('The import source contains control characters or is too long.', file, node.line ?? 1, node.column ?? 1, {
      code: 'KR-SEC-1202', title: 'Unsafe import source', hint: 'Use a short local, npm, or node module name.', source,
    });
  }
  if (value.startsWith('npm:')) value = value.slice(4);
  if (/^(?:data|javascript|https?|file):/i.test(value)) {
    throw new KuraCompileError(`Imports using '${value.split(':', 1)[0]}:' are blocked.`, file, node.line ?? 1, node.column ?? 1, {
      code: 'KR-SEC-1203',
      title: 'Remote or executable import blocked',
      hint: 'Install the dependency locally and import it by package name, or use a relative project path.',
      source,
    });
  }
  if (pathLikeAbsolute(value)) {
    throw new KuraCompileError('Absolute filesystem imports are blocked.', file, node.line ?? 1, node.column ?? 1, {
      code: 'KR-SEC-1204', title: 'Import escapes the project', hint: 'Use a relative import beginning with ./ or ../.', source,
    });
  }
  if (value.startsWith('node:') && mode === 'strict' && DANGEROUS_NODE_MODULES.has(value)) {
    throw new KuraCompileError(`Strict security mode blocks '${value}'.`, file, node.line ?? 1, node.column ?? 1, {
      code: 'KR-SEC-1205',
      title: 'Sensitive Node.js capability blocked',
      hint: 'Use a safer API, or run trusted code without --secure after reviewing the dependency.',
      source,
    });
  }
  if (moe === 'strict' && !value.startsWith('./') && !value.startsWith('../') && !value.startsWith('node:')) {
    throw new KuraCompileError(`Strict security mode does not allow the package import '${value}'.`, file, node.line ?? 1, node.column ?? 1, {
      code: 'KR-SEC-1206',
      title: 'Third-party package blocked in strict mode',
      hint: 'Vendor the reviewed module locally, or run without --secure only when the package is trusted.',
      source,
    });
  }
  if (!value.startsWith('./') && !value.startsWith('../') && !value.startsWith('node:') && !/^@?[A-Za-z0-9][A-Za-z0-9._@/-]*$/.test(value)) {
    throw new KuraCompileError(`The package name '${value}' is not valid.`, file, node.line ?? 1, node.column ?? 1, {
      code: 'KR-PARSE-1203', title: 'Invalid package import', hint: 'Use a valid npm package name such as express or @scope/package.', source,
    });
  }
  return value;
}

function pathLikeAbsolute(value) {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
}

const indent = level => '  '.repeat(level);

function literalValue(node) {
  if (node?.kind !== 'Literal') return { known: false, value: undefined };
  const raw = node.value;
  if (raw === 'true') return { known: true, value: true };
  if (raw === 'false') return { known: true, value: false };
  if (raw === 'null') return { known: true, value: null };
  if (raw.startsWith('"') || raw.startsWith("'")) {
    try { return { known: true, value: decodeStringLiteral(raw) }; } catch { return { known: false, value: undefined }; }
  }
  const normalized = raw.replaceAll('_', '');
  const value = Number(normalized);
  return Number.isFinite(value) ? { known: true, value } : { known: false, value: undefined };
}

function serializeLiteral(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'null';
  return null;
}

function foldExpression(node) {
  if (!node) return node;
  if (node.kind === 'Array') return { ...node, items: node.items.map(foldExpression) };
  if (node.kind === 'Unary') {
    const value = foldExpression(node.value);
    const known = literalValue(value);
    if (known.known) {
      let result;
      if (node.op === '!') result = !known.value;
      else if (node.op === '-') result = -known.value;
      else if (node.op === '+') result = +known.value;
      const encoded = serializeLiteral(result);
      if (encoded !== null) return { kind: 'Literal', value: encoded, line: node.line, column: node.column };
    }
    return { ...node, value };
  }
  if (node.kind === 'Binary') {
    const left = foldExpression(node.left);
    const right = foldExpression(node.right);
    const a = literalValue(left);
    const b = literalValue(right);
    if (a.known && b.known && node.op !== '=') {
      let result;
      switch (node.op) {
        case '+': result = a.value + b.value; break;
        case '-': result = a.value - b.value; break;
        case '*': result = a.value * b.value; break;
        case '/': result = a.value / b.value; break;
        case '%': result = a.value % b.value; break;
        case '==': result = a.value === b.value; break;
        case '!=': result = a.value !== b.value; break;
        case '<': result = a.value < b.value; break;
        case '>': result = a.value > b.value; break;
        case '<=': result = a.value <= b.value; break;
        case '>=': result = a.value >= b.value; break;
        case '&&': result = a.value && b.value; break;
        case '||': result = a.value || b.value; break;
        case '??': result = a.value ?? b.value; break;
        default: return { ...node, left, right };
      }
      const encoded = serializeLiteral(result);
      if (encoded !== null) return { kind: 'Literal', value: encoded, line: node.line, column: node.column };
    }
    return { ...node, left, right };
  }
  if (node.kind === 'Await') return { ...node, value: foldExpression(node.value) };
  if (node.kind === 'Call') return { ...node, callee: foldExpression(node.callee), args: node.args.map(foldExpression) };
  if (node.kind === 'Member') return { ...node, object: foldExpression(node.object) };
  if (node.kind === 'Index') return { ...node, object: foldExpression(node.object), index: foldExpression(node.index) };
  return node;
}

function optimizeStatements(body) {
  const output = [];
  for (const node of body) {
    if (node.kind === 'Function') output.push({ ...node, body: optimizeStatements(node.body) });
    else if (node.kind === 'Variable') output.push({ ...node, init: foldExpression(node.init) });
    else if (node.kind === 'Return') output.push({ ...node, value: foldExpression(node.value) });
    else if (node.kind === 'ExpressionStatement') output.push({ ...node, expression: foldExpression(node.expression) });
    else if (node.kind === 'While') output.push({ ...node, test: foldExpression(node.test), body: optimizeStatements(node.body) });
    else if (node.kind === 'For') output.push({ ...node, iterable: foldExpression(node.iterable), body: optimizeStatements(node.body) });
    else if (node.kind === 'If') {
      const test = foldExpression(node.test);
      const known = literalValue(test);
      if (known.known) {
        output.push(...optimizeStatements(known.value ? node.consequent : (node.alternate || [])));
        continue;
      }
      output.push({ ...node, test, consequent: optimizeStatements(node.consequent), alternate: node.alternate ? optimizeStatements(node.alternate) : null });
    } else output.push(node);
  }
  return output;
}

function optimizeAst(ast) { return { ...ast, body: optimizeStatements(ast.body) }; }

function emitExpression(node) {
  switch (node.kind) {
    case 'Literal': return node.value;
    case 'Identifier': return builtin(node.name);
    case 'Array': return `[${node.items.map(emitExpression).join(', ')}]`;
    case 'Unary': return `${node.op}${emitExpression(node.value)}`;
    case 'Await': return `await ${emitExpression(node.value)}`;
    case 'Binary': return `${emitExpression(node.left)} ${node.op} ${emitExpression(node.right)}`;
    case 'Call': return `${emitExpression(node.callee)}(${node.args.map(emitExpression).join(', ')})`;
    case 'Member': return `${emitExpression(node.object)}.${node.property}`;
    case 'Index': return `${emitExpression(node.object)}[${emitExpression(node.index)}]`;
    default: throw new Error(`Unknown expression kind: ${node.kind}`);
  }
}

function builtin(name) {
  return ({ println: 'console.log', print: 'process.stdout.write', len: '__kr_len', str: 'String', int: 'Number', float: 'Number', range: '__kr_range', panic: '__kr_panic' })[name] ?? name;
}

function isRangeCall(node) {
  return node?.kind === 'Call' && node.callee?.kind === 'Identifier' && node.callee.name === 'range' && node.args.length === 2;
}

function emitStatement(node, depth = 0) {
  const prefix = indent(depth);
  switch (node.kind) {
    case 'Function':
      return `${prefix}${node.exported ? 'export ' : ''}${node.async ? 'async ' : ''}function ${node.name}(${node.params.map(x => x.name).join(', ')}) {\n${node.body.map(x => emitStatement(x, depth + 1)).join('\n')}\n${prefix}}`;
    case 'Variable':
      return `${prefix}${node.keyword === 'const' ? 'const' : 'let'} ${node.name}${node.init ? ` = ${emitExpression(node.init)}` : ''};`;
    case 'Return':
      return `${prefix}return${node.value ? ` ${emitExpression(node.value)}` : ''};`;
    case 'If':
      return `${prefix}if (${emitExpression(node.test)}) {\n${node.consequent.map(x => emitStatement(x, depth + 1)).join('\n')}\n${prefix}}${node.alternate ? ` else {\n${node.alternate.map(x => emitStatement(x, depth + 1)).join('\n')}\n${prefix}}` : ''}`;
    case 'While':
      return `${prefix}while (${emitExpression(node.test)}) {\n${node.body.map(ditem => emitStatement(ditem, depth + 1)).join('\n')}\n${prefix}}`;
    case 'For': {
      if (isRangeCall(node.iterable)) {
        const [start, end] = node.iterable.args;
        const stop = `__kr_end_${node.name}_${depth}`;
        return `${prefix}for (let ${node.name} = ${emitExpression(start)}, ${stop} = ${emitExpression(end)}; ${node.name} < ${stop}; ${node.name}++) {\n${node.body.map(x => emitStatement(x, depth + 1)).join('\n')}\n${prefix}}`;
      }
      return `${prefix}for (const ${node.name} of ${emitExpression(node.iterable)}) {\n${node.body.map(x => emitStatement(x, depth + 1)).join('\n')}\n${prefix}}`;
    }
    case 'ExpressionStatement':
      return `${prefix}${emitExpression(node.expression)};`;
    case 'Struct':
      return `${prefix}${node.exported ? 'export ' : ''}class ${node.name} { constructor(${node.fields.map(f => f.name).join(', ')}) { ${node.fields.map(f => `this.${f.name}=${f.name};`).join(' ')} } }`;
    case 'Enum':
      return `${prefix}${node.exported ? 'export ' : ''}const ${node.name}=Object.freeze({${node.variants.map(v => `${v.name}:${v.fields.length ? `(...values)=>Object.freeze({tag:${JSON.stringify(v.name)},values:Object.freeze(values)})` : `Object.freeze({tag:${JSON.stringify(v.name)}})`}`).join(',')}});`;
    case 'Import':
      return `${prefix}import { ${node.names.join(', ')} } from ${JSON.stringify(node.source)};`;
    default:
      throw new Error(`Unknown statement kind: ${node.kind}`);
  }
}

function walkExpression(node, visit) {
  if (!node) return;
  visit(node);
  switch (node.kind) {
    case 'Array': node.items.forEach(x => walkExpression(x, visit)); break;
    case 'Unary':
    case 'Await': walkExpression(node.value, visit); break;
    case 'Binary': walkExpression(node.left, visit); walkExpression(node.right, visit); break;
    case 'Call': walkExpression(node.callee, visit); node.args.forEach(x => walkExpression(x, visit)); break;
    case 'Member': walkExpression(node.object, visit); break;
    case 'Index': walkExpression(node.object, visit); walkExpression(node.index, visit); break;
  }
}

function walkStatements(body, visit) {
  for (const node of body) {
    visit(node);
    if (node.kind === 'Function' || node.kind === 'While' || node.kind === 'For') walkStatements(node.body, visit);
    if (node.kind === 'If') {
      walkStatements(node.consequent, visit);
      if (node.alternate) walkStatements(node.alternate, visit);
    }
    for (const key of ['init', 'value', 'expression', 'test', 'iterable'])
      walkExpression(node[key], visit);
  }
}

function buildPrelude(body) {
  const lines = [];
  if (body.includes('__kr_len')) lines.push('const __kr_len = value => value.length;');
  if (body.includes('__kr_range')) lines.push('const __kr_range = (start, end) => ({[Symbol.iterator]: function*(){for(let i=start;i<end;i++)yield i;}});');
  if (body.includes('__kr_panic')) lines.push('const __kr_panic = message => { throw new Error(String(message)); };');
  return lines.join('\n');
}

export function compile(source, options = {}) {
  const parsed = parse(source, options);
  validateProgramSecurity(parsed, source, options);
  const ast = options.optimize ? optimizeAst(parsed) : parsed;
  const body = ast.body.map((x => emitStatement(x, 0)).join(options.compact ? '\n' : '\n\n');
  const prelude = buildPrelude(body);
  const mainFunctions = ast.body.filter(x => x.kind === 'Function' && x.name === 'main');
  if (mainFunctions.length > 1) {
    const duplicate = mainFunctions[1];
    throw new KuraCompileError('A Kura program may contain only one main function.', options.file ?? '<input>', duplicate.line ?? 1, duplicate.column ?? 1, {
      code: 'KR-CHECK-1301',
      title: 'Duplicate main function',
      hint: 'Rename or remove the second main function.',
      source,
      length: 4,
    });
  }
  const hasMain = mainFunctions.length === 1;
  const benchmarkFunction = ast.body.find(x => x.kind === 'Function' && x.kernel);
  const exports = [];
  if (hasMain && options.exposeMain) exports.push('main as __kr_main');
  if (benchmarkFunction && options.exposeBenchmark) exports.push(`${benchmarkFunction.name} as __kr_bench`);
  const expose = exports.length ? `\nexport { ${exports.join(', ')} };` : '';
  const autoRun = options.autoRun !== false;
  const epilogue = hasMain && autoRun ? "\n\nconst __kr_result = await main();\nif (typeof __kr_result === 'number') process.exitCode = __kr_result;" : '';
  const banner = options.banner === false ? '' : `// Generated by Kura v1.0.0${options.optimize ? ' Velocity Engine' : ''}\n`;
  const sections = [banner.trimEnd(), prelude, body + expose + epilogue].filter(Boolean);
  return {
    ast,
    code: sections.join(options.compact ? '\n' : '\n\n') + '\n',
    target: options.target ?? 'node',
    optimized: Boolean(options.optimize),
    securityMode: options.securityMode ?? 'standard',
  };
}

export function format(source, options = {}) {
  const { ast } = compile(source, { ...options, autoRun: false, banner: false });
  return ast.body.map(x => formatStatement(x, 0)).join('\n\n') + '\n';
}

function formatStatement(node, depth) {
  const prefix = indent(depth);
  switch (node.kind) {
    case 'Function':
      return `${prefix}${node.exported ? 'export ' : ''}${node.async ? 'async ' : ''}${node.pure ? 'pure ' : ''}${node.kernel ? 'kernel ' : ''}fn ${node.name}(${node.params.map(param => param.name + (param.type ? `: ${param.type}` : '')).join(', ')})${node.returnType ? ` -> ${node.returnType}` : ''} {\n${node.body.map(x => formatStatement(x, depth + 1)).join('\n')}\n${prefix}}`;
    case 'Variable': return `${prefix}${node.keyword} ${node.name}${node.type ? `: ${node.type}` : ''}${node.init ? ` = ${emitExpression(node.init)}` : ''};`;
    case 'Return': return `${prefix}return${node.value ? ` ${emitExpression(node.value)}` : ''};`;
    case 'ExpressionStatement': return `${prefix}${emitExpression(node.expression)};`;
    case 'If': return `${prefix}if (${emitExpression(node.test)}) {\n${node.consequent.map(x => formatStatement(x, depth + 1)).join('\n')}\n${prefix}}${node.alternate ? ` else {\n${node.alternate.map(x => formatStatement(x, depth + 1)).join('\n')}\n${prefix}}` : ''}`;
    case 'While': return `${prefix}while (${emitExpression(node.test)}) {\n${node.body.map(ditem => formatStatement(ditem, depth + 1)).join('\n')}\n${prefix}}`;
    case 'For': return `${prefix}for ${node.name} in ${emitExpression(node.iterable)} {\n${node.body.map(x => formatStatement(x, depth + 1)).join('\n')}\n${prefix}}`;
    case 'Struct': return `${prefix}${node.exported ? 'export ' : ''}struct ${node.name} {\n${node.fields.map(field => `${indent(depth + 1)}${field.name}: ${field.type},`).join('\n')}\n${prefix}}`;
    case 'Enum': return `${prefix}${node.exported ? 'export ' : ''}enum ${node.name} {\n${node.variants.map(variant => `${indent(depth + 1)}${variant.name}${variant.fields.length ? `(${variant.fields.join(', ')})` : ''},`).join('\n')}\n${prefix}}`;
    case 'Import': return `${prefix}import { ${node.names.join(', ')} } from ${JSON.stringify(node.source)};`;
    default: return prefix;
  }
}

export function diagnose(source, options = {}) {
  try {
    const result = compile(source, { ...options, autoRun: false });
    return { ok: true, messages: [], ast: result.ast };
  } catch (error) {
    return {
      ok: false,
      messages: [{
        severity: 'error',
        code: error.code ?? 'KR-CHECK-0001',
        title: error.title ?? 'Compilation failed',
        message: error.message ?? String(error),
        hint: error.hint ?? null,
        details: error.details ?? null,
        file: error.file ?? options.file ?? '<input>',
        line: error.line ?? 1,
        column: error.column ?? 1,
        length: error.length ?? 1,
        source: error.source ?? source,
      }],
    };
  }
}
