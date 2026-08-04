// SPDX-License-Identifier: MIT OR Apache-2.0

import {
  KuraIrFunctionBuilder,
  KuraSystemError,
  createKuraIrModule,
  emitLlvmIr,
  parseSystemType,
  resolveSystemTarget,
} from './system.mjs';

const SYSTEM_KEYWORDS = new Set([
  'fn', 'pub', 'extern', 'unsafe', 'return', 'true', 'false', 'never',
]);

export class KuraSystemSourceError extends KuraSystemError {
  constructor(message, token, source, options = {}) {
    super(message, {
      code: options.code ?? 'KR-SYS-SOURCE-0001',
      details: {
        line: token?.line ?? 1,
        column: token?.column ?? 1,
        length: token?.length ?? 1,
        source,
        hint: options.hint ?? null,
      },
    });
    this.name = 'KuraSystemSourceError';
    this.line = token?.line ?? 1;
    this.column = token?.column ?? 1;
  }
}

function sourceError(message, token, source, options = {}) {
  return new KuraSystemSourceError(message, token, source, options);
}

export function tokenizeSystemSource(source) {
  if (typeof source !== 'string') {
    throw new KuraSystemSourceError('Kura system source must be text.', null, '', {
      code: 'KR-SYS-SOURCE-1001',
    });
  }

  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const push = (type, value, startLine, startColumn, start, end = index) => {
    tokens.push({ type, value, line: startLine, column: startColumn, offset: start, length: Math.max(1, end - start) });
  };

  while (index < source.length) {
    const char = source[index];
    const start = index;
    const startLine = line;
    const startColumn = column;

    if (char === ' ' || char === '\t' || char === '\r') {
      index++;
      column++;
      continue;
    }
    if (char === '\n') {
      index++;
      line++;
      column = 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') {
        index++;
        column++;
      }
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      column += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source[index] === '/' && source[index + 1] === '*') {
          depth++;
          index += 2;
          column += 2;
          continue;
        }
        if (source[index] === '*' && source[index + 1] === '/') {
          depth--;
          index += 2;
          column += 2;
          continue;
        }
        if (source[index] === '\n') {
          index++;
          line++;
          column = 1;
        } else {
          index++;
          column++;
        }
      }
      if (depth !== 0) {
        throw sourceError('Unclosed block comment.', { line: startLine, column: startColumn, length: 2 }, source, {
          code: 'KR-SYS-SOURCE-1002',
        });
      }
      continue;
    }
    if (char === '"') {
      index++;
      column++;
      let value = '';
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (current === '"') {
          index++;
          column++;
          closed = true;
          break;
        }
        if (current === '\\') {
          const escaped = source[index + 1];
          const mapping = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
          if (!(escaped in mapping)) {
            throw sourceError(`Unsupported string escape \\${escaped}.`, { line, column, length: 2 }, source, {
              code: 'KR-SYS-SOURCE-1003',
            });
          }
          value += mapping[escaped];
          index += 2;
          column += 2;
          continue;
        }
        if (current === '\n') {
          throw sourceError('System string literals cannot span lines.', { line, column, length: 1 }, source, {
            code: 'KR-SYS-SOURCE-1004',
          });
        }
        value += current;
        index++;
        column++;
      }
      if (!closed) {
        throw sourceError('Unclosed string literal.', { line: startLine, column: startColumn, length: 1 }, source, {
          code: 'KR-SYS-SOURCE-1005',
        });
      }
      push('string', value, startLine, startColumn, start);
      continue;
    }
    if (/[0-9]/.test(char)) {
      const match = /^(?:0[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|[0-9](?:_?[0-9])*)/.exec(source.slice(index));
      const value = match[0];
      index += value.length;
      column += value.length;
      push('number', value, startLine, startColumn, start);
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) {
        value += source[index++];
        column++;
      }
      push(SYSTEM_KEYWORDS.has(value) ? 'keyword' : 'identifier', value, startLine, startColumn, start);
      continue;
    }

    const two = source.slice(index, index + 2);
    if (['#!', '->', '::'].includes(two)) {
      index += 2;
      column += 2;
      push('symbol', two, startLine, startColumn, start);
      continue;
    }
    if ('@{}()[];,:.<>*=+-'.includes(char)) {
      index++;
      column++;
      push('symbol', char, startLine, startColumn, start);
      continue;
    }

    throw sourceError(`Unexpected character ${JSON.stringify(char)}.`, { line, column, length: 1 }, source, {
      code: 'KR-SYS-SOURCE-1006',
    });
  }

  tokens.push({ type: 'eof', value: '', line, column, offset: index, length: 1 });
  return tokens;
}

class SystemParser {
  constructor(source, options = {}) {
    this.source = source;
    this.tokens = tokenizeSystemSource(source);
    this.index = 0;
    this.defaultTarget = options.target ?? 'x86_64-unknown-none';
  }

  current() { return this.tokens[this.index]; }
  next() { return this.tokens[this.index++]; }
  at(value) { return this.current().value === value; }
  match(value) { if (this.at(value)) { this.index++; return true; } return false; }

  expect(value, message = null) {
    const token = this.current();
    if (!this.match(value)) {
      throw sourceError(message ?? `Expected '${value}', found '${token.value || 'end of file'}'.`, token, this.source, {
        code: 'KR-SYS-SOURCE-1101',
      });
    }
    return token;
  }

  expectIdentifier(purpose = 'identifier') {
    const token = this.current();
    if (token.type !== 'identifier' && token.type !== 'keyword') {
      throw sourceError(`Expected ${purpose}.`, token, this.source, { code: 'KR-SYS-SOURCE-1102' });
    }
    this.index++;
    return token.value;
  }

  parseProgram() {
    const directives = [];
    const declarations = [];
    while (this.at('#!')) directives.push(this.parseDirective());
    while (this.current().type !== 'eof') declarations.push(this.parseDeclaration());

    const targetDirective = directives.find((directive) => directive.name === 'target');
    const target = targetDirective?.arguments[0] ?? this.defaultTarget;
    resolveSystemTarget(target);

    return {
      kind: 'SystemProgram',
      target,
      noStd: directives.some((directive) => directive.name === 'no_std'),
      noMain: directives.some((directive) => directive.name === 'no_main'),
      directives,
      declarations,
    };
  }

  parseDirective() {
    const token = this.expect('#!');
    this.expect('[');
    const name = this.expectIdentifier('directive name');
    const args = [];
    if (this.match('(')) {
      while (!this.at(')')) {
        const value = this.next();
        if (!['string', 'number', 'identifier', 'keyword'].includes(value.type)) {
          throw sourceError('Directive arguments must be literals or identifiers.', value, this.source, {
            code: 'KR-SYS-SOURCE-1103',
          });
        }
        args.push(value.value);
        if (!this.match(',')) break;
      }
      this.expect(')');
    }
    this.expect(']');
    return { kind: 'Directive', name, arguments: args, line: token.line, column: token.column };
  }

  parseDeclaration() {
    const attributes = [];
    while (this.match('@')) {
      const name = this.expectIdentifier('attribute name');
      attributes.push(name);
    }

    const publicVisibility = this.match('pub');
    const unsafe = this.match('unsafe');
    let abi = 'kura';
    if (this.match('extern')) {
      const abiToken = this.next();
      if (abiToken.type !== 'string') {
        throw sourceError('extern requires a quoted ABI such as extern "C".', abiToken, this.source, {
          code: 'KR-SYS-SOURCE-1104',
        });
      }
      abi = abiToken.value;
    }
    this.expect('fn', 'Expected a function declaration.');
    const nameToken = this.current();
    const name = this.expectIdentifier('function name');
    this.expect('(');
    const parameters = [];
    while (!this.at(')')) {
      const parameterName = this.expectIdentifier('parameter name');
      this.expect(':');
      const type = this.parseTypeUntil(new Set([',', ')']));
      parameters.push({ name: parameterName, type });
      if (!this.match(',')) break;
    }
    this.expect(')');
    let returnType = 'void';
    if (this.match('->')) returnType = this.parseTypeUntil(new Set(['{']));
    const body = this.parseBlock();
    return {
      kind: 'SystemFunction',
      name,
      attributes,
      public: publicVisibility,
      unsafe,
      abi,
      parameters,
      returnType,
      body,
      line: nameToken.line,
      column: nameToken.column,
    };
  }

  parseTypeUntil(stop) {
    let text = '';
    let squareDepth = 0;
    while (this.current().type !== 'eof') {
      const value = this.current().value;
      if (squareDepth === 0 && stop.has(value)) break;
      if (value === '[') squareDepth++;
      if (value === ']') squareDepth--;
      text += this.next().value;
      if (value === 'const' || value === 'mut') text += ' ';
    }
    const trimmed = text.trim();
    parseSystemType(trimmed, { target: this.defaultTarget });
    return trimmed;
  }

  parseBlock() {
    this.expect('{');
    const statements = [];
    while (!this.at('}')) {
      if (this.current().type === 'eof') {
        throw sourceError('Unclosed function or unsafe block.', this.current(), this.source, {
          code: 'KR-SYS-SOURCE-1105',
        });
      }
      statements.push(this.parseStatement());
    }
    this.expect('}');
    return statements;
  }

  parseStatement() {
    const token = this.current();
    if (this.match('unsafe')) {
      return { kind: 'UnsafeBlock', body: this.parseBlock(), line: token.line, column: token.column };
    }
    if (this.match('return')) {
      this.match(';');
      return { kind: 'Return', line: token.line, column: token.column };
    }

    const path = [this.expectIdentifier('intrinsic or module name')];
    while (this.match('.')) path.push(this.expectIdentifier('member name'));
    let typeArgument = null;
    if (this.match('<')) {
      typeArgument = this.parseTypeUntil(new Set(['>']));
      this.expect('>');
    }
    this.expect('(');
    const args = [];
    while (!this.at(')')) {
      args.push(this.parseLiteral());
      if (!this.match(',')) break;
    }
    this.expect(')');
    this.match(';');
    return { kind: 'IntrinsicCall', path, typeArgument, arguments: args, line: token.line, column: token.column };
  }

  parseLiteral() {
    const token = this.next();
    if (token.type === 'number') {
      const normalized = token.value.replaceAll('_', '');
      let value;
      if (/^0[xX]/.test(normalized)) value = BigInt(normalized);
      else if (/^0[bB]/.test(normalized)) value = BigInt(normalized);
      else if (/^0[oO]/.test(normalized)) value = BigInt(normalized);
      else value = BigInt(normalized);
      return { kind: 'IntegerLiteral', value, raw: token.value, line: token.line, column: token.column };
    }
    if (token.value === 'true' || token.value === 'false') {
      return { kind: 'BoolLiteral', value: token.value === 'true', line: token.line, column: token.column };
    }
    if (token.type === 'string') {
      return { kind: 'StringLiteral', value: token.value, line: token.line, column: token.column };
    }
    throw sourceError('Only literal intrinsic arguments are supported in this system frontend stage.', token, this.source, {
      code: 'KR-SYS-SOURCE-1106',
    });
  }
}

export function parseSystemSource(source, options = {}) {
  return new SystemParser(source, options).parseProgram();
}

function requireUnsafe(context, statement, source, operation) {
  if (context.unsafeDepth > 0 || context.functionUnsafe) return;
  throw sourceError(`${operation} requires an unsafe block or unsafe function.`, statement, source, {
    code: 'KR-SYS-SOURCE-1201',
    hint: `Wrap ${operation} in unsafe { ... } after validating its invariants.`,
  });
}

function integerStorageValue(literal) {
  if (literal.kind !== 'IntegerLiteral') {
    throw new KuraSystemError('This intrinsic currently requires an integer literal.', {
      code: 'KR-SYS-SOURCE-1202',
    });
  }
  return literal.value;
}

function lowerStatements(statements, builder, context) {
  for (const statement of statements) {
    if (statement.kind === 'UnsafeBlock') {
      lowerStatements(statement.body, builder, { ...context, unsafeDepth: context.unsafeDepth + 1 });
      continue;
    }
    if (statement.kind === 'Return') {
      if (context.returnType === 'never') {
        throw sourceError('A function returning never cannot return.', statement, context.source, {
          code: 'KR-SYS-SOURCE-1203',
        });
      }
      builder.returnVoid();
      return true;
    }
    if (statement.kind !== 'IntrinsicCall') continue;

    const path = statement.path.join('.');
    if (path === 'memory.volatile_write') {
      requireUnsafe(context, statement, context.source, path);
      if (!statement.typeArgument || statement.arguments.length !== 2) {
        throw sourceError('memory.volatile_write<T> requires address and value arguments.', statement, context.source, {
          code: 'KR-SYS-SOURCE-1204',
        });
      }
      const valueType = parseSystemType(statement.typeArgument, { target: context.target });
      if (valueType.kind !== 'integer' && valueType.kind !== 'bool') {
        throw sourceError('volatile_write currently supports integer and bool values.', statement, context.source, {
          code: 'KR-SYS-SOURCE-1205',
        });
      }
      const id = context.nextValue++;
      const addressName = `address${id}`;
      const pointerName = `pointer${id}`;
      const valueName = `value${id}`;
      builder
        .constant(addressName, 'usize', integerStorageValue(statement.arguments[0]))
        .intToPtr(pointerName, addressName, `*mut ${statement.typeArgument}`)
        .constant(valueName, statement.typeArgument, integerStorageValue(statement.arguments[1]))
        .volatileStore(statement.typeArgument, valueName, pointerName);
      continue;
    }
    if (path === 'cpu.halt') {
      requireUnsafe(context, statement, context.source, path);
      if (statement.arguments.length !== 0 || statement.typeArgument) {
        throw sourceError('cpu.halt takes no arguments.', statement, context.source, {
          code: 'KR-SYS-SOURCE-1206',
        });
      }
      builder.inlineAssembly('hlt');
      continue;
    }
    if (path === 'cpu.disable_interrupts') {
      requireUnsafe(context, statement, context.source, path);
      builder.inlineAssembly('cli', '', { sideEffect: true });
      continue;
    }
    if (path === 'cpu.enable_interrupts') {
      requireUnsafe(context, statement, context.source, path);
      builder.inlineAssembly('sti', '', { sideEffect: true });
      continue;
    }

    throw sourceError(`Unknown system intrinsic '${path}'.`, statement, context.source, {
      code: 'KR-SYS-SOURCE-1207',
    });
  }
  return false;
}

export function lowerSystemProgram(program, options = {}) {
  if (!program || program.kind !== 'SystemProgram') {
    throw new KuraSystemError('lowerSystemProgram expected a parsed SystemProgram.', {
      code: 'KR-SYS-SOURCE-1301',
    });
  }
  if (!program.noStd) {
    throw new KuraSystemError('Freestanding Kura source must declare #![no_std].', {
      code: 'KR-SYS-SOURCE-1302',
    });
  }

  const target = options.target ?? program.target;
  resolveSystemTarget(target);
  const functions = [];
  const entries = program.declarations.filter((declaration) => declaration.attributes.includes('entry'));
  if (entries.length > 1) {
    throw new KuraSystemError('A system module can contain only one @entry function.', {
      code: 'KR-SYS-SOURCE-1303',
    });
  }

  for (const declaration of program.declarations) {
    const returnType = declaration.returnType;
    const builder = new KuraIrFunctionBuilder(declaration.name, {
      target,
      returnType,
      parameters: declaration.parameters,
      linkage: declaration.public || declaration.attributes.includes('entry') ? 'external' : 'internal',
      callingConvention: declaration.abi === 'C' ? 'c' : 'c',
      noreturn: returnType === 'never',
    });
    const terminated = lowerStatements(declaration.body, builder, {
      target,
      source: options.source ?? '',
      unsafeDepth: 0,
      functionUnsafe: declaration.unsafe,
      returnType,
      nextValue: 0,
    });
    if (!terminated) {
      if (returnType === 'never') builder.unreachable();
      else builder.returnVoid();
    }
    functions.push(builder.build());
  }

  return createKuraIrModule({
    name: options.name ?? 'kura.system.source',
    target,
    functions,
  });
}

export function compileSystemSource(source, options = {}) {
  const program = parseSystemSource(source, options);
  const module = lowerSystemProgram(program, { ...options, source });
  return {
    program,
    module,
    llvmIr: emitLlvmIr(module),
  };
}
