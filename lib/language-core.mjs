// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * Kura typed language core.
 *
 * This frontend owns the application-language features that are intentionally
 * richer than the freestanding kernel grammar: generics, traits, algebraic
 * enums, exhaustive pattern matching, closures, Result propagation, and RAII.
 */

const KEYWORDS = new Set([
  'struct', 'enum', 'trait', 'impl', 'for', 'fn', 'where', 'let', 'const',
  'return', 'if', 'else', 'match', 'true', 'false', 'defer', 'move', 'mut',
  'pub', 'export', 'self', 'Self', 'async', 'await',
]);

export class KuraLanguageError extends Error {
  constructor(message, token = {}, options = {}) {
    super(message);
    this.name = 'KuraLanguageError';
    this.code = options.code ?? 'KR-LANG-0001';
    this.file = options.file ?? '<input>';
    this.line = token.line ?? 1;
    this.column = token.column ?? 1;
    this.hint = options.hint ?? null;
    this.details = options.details ?? null;
  }
}

function fail(message, token, context, code = 'KR-LANG-0001', hint = null, details = null) {
  throw new KuraLanguageError(message, token, {
    file: context.file ?? '<input>', code, hint, details,
  });
}

export function tokenizeLanguage(source, options = {}) {
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
      if (depth) throw new KuraLanguageError('Unclosed block comment.', { line: startLine, column: startColumn }, { file, code: 'KR-LANG-LEX-0001' });
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let raw = quote;
      index++; column++;
      let closed = false;
      while (index < source.length) {
        const current = source[index++];
        raw += current;
        column++;
        if (current === '\\' && index < source.length) { raw += source[index++]; column++; continue; }
        if (current === quote) { closed = true; break; }
        if (current === '\n') break;
      }
      if (!closed) throw new KuraLanguageError('Unclosed string literal.', { line: startLine, column: startColumn }, { file, code: 'KR-LANG-LEX-0002' });
      push('string', raw, startLine, startColumn);
      continue;
    }
    if (/[0-9]/.test(char)) {
      const match = /^(?:0[xX][\dA-Fa-f](?:_?[\dA-Fa-f])*|0[bB][01](?:_?[01])*|\d(?:_?\d)*(?:\.\d(?:_?\d)*)?)/.exec(source.slice(index));
      index += match[0].length; column += match[0].length;
      push('number', match[0], startLine, startColumn);
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) { value += source[index++]; column++; }
      push(KEYWORDS.has(value) ? 'keyword' : 'identifier', value, startLine, startColumn);
      continue;
    }
    const three = source.slice(index, index + 3);
    const two = source.slice(index, index + 2);
    if (three === '...') { index += 3; column += 3; push('symbol', three, startLine, startColumn); continue; }
    if (['->', '=>', '::', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '??'].includes(two)) {
      index += 2; column += 2; push('symbol', two, startLine, startColumn); continue;
    }
    if ('@{}()[];,:.+-*/%<>=!&|?_'.includes(char)) {
      index++; column++; push('symbol', char, startLine, startColumn); continue;
    }
    throw new KuraLanguageError(`Unsupported character ${JSON.stringify(char)}.`, { line: startLine, column: startColumn }, { file, code: 'KR-LANG-LEX-0003' });
  }
  tokens.push({ type: 'eof', value: '', line, column });
  return tokens;
}

class Parser {
  constructor(source, options = {}) {
    this.file = options.file ?? '<input>';
    this.tokens = tokenizeLanguage(source, options);
    this.index = 0;
  }
  current(offset = 0) { return this.tokens[this.index + offset] ?? this.tokens.at(-1); }
  at(value) { return this.current().value === value; }
  next() { return this.tokens[this.index++]; }
  match(value) { return this.at(value) ? this.next() : null; }
  expect(value, message = null) {
    if (!this.at(value)) fail(message ?? `Expected '${value}', found '${this.current().value || 'end of file'}'.`, this.current(), this, 'KR-LANG-PARSE-0001');
    return this.next();
  }
  identifier(purpose = 'identifier') {
    const token = this.current();
    if (!['identifier', 'keyword'].includes(token.type) || ['struct', 'enum', 'trait', 'impl', 'fn', 'where'].includes(token.value)) {
      fail(`Expected ${purpose}.`, token, this, 'KR-LANG-PARSE-0002');
    }
    return this.next();
  }
  parse() {
    const declarations = [];
    while (this.current().type !== 'eof') declarations.push(this.declaration());
    return { kind: 'LanguageProgram', file: this.file, declarations };
  }
  attributes() {
    const output = [];
    while (this.match('@')) {
      const token = this.identifier('attribute');
      const args = [];
      if (this.match('(')) {
        while (!this.at(')')) {
          const item = this.next();
          if (!['identifier', 'keyword', 'string', 'number'].includes(item.type)) fail('Invalid attribute argument.', item, this);
          args.push(item.type === 'string' ? JSON.parse(item.value) : item.value);
          if (!this.match(',')) break;
        }
        this.expect(')');
      }
      output.push({ name: token.value, args, token });
    }
    return output;
  }
  declaration() {
    const attributes = this.attributes();
    const exported = Boolean(this.match('pub') || this.match('export'));
    const async = Boolean(this.match('async'));
    if (this.match('struct')) return this.structDeclaration(attributes, exported);
    if (this.match('enum')) return this.enumDeclaration(attributes, exported);
    if (this.match('trait')) return this.traitDeclaration(attributes, exported);
    if (this.match('impl')) return this.implDeclaration(attributes);
    if (this.match('fn')) return this.functionDeclaration(attributes, exported, async, true);
    fail('Expected struct, enum, trait, impl, or function declaration.', this.current(), this, 'KR-LANG-PARSE-0003');
  }
  genericParameters() {
    if (!this.match('<')) return [];
    const output = [];
    while (!this.at('>')) {
      const token = this.identifier('generic parameter');
      const bounds = [];
      if (this.match(':')) {
        do { bounds.push(this.typeReference(new Set(['+', ',', '>']))); } while (this.match('+'));
      }
      output.push({ name: token.value, bounds, token });
      if (!this.match(',')) break;
    }
    this.expect('>');
    return output;
  }
  whereClause() {
    if (!this.match('where')) return [];
    const output = [];
    while (!['{', ';'].includes(this.current().value)) {
      const token = this.identifier('where-clause type parameter');
      this.expect(':');
      const bounds = [];
      do { bounds.push(this.typeReference(new Set(['+', ',', '{', ';']))); } while (this.match('+'));
      output.push({ name: token.value, bounds, token });
      if (!this.match(',')) break;
    }
    return output;
  }
  typeReference(stops = new Set([',', ')', '{', ';', '=', '}'])) {
    let text = '';
    let angle = 0;
    let square = 0;
    let paren = 0;
    while (this.current().type !== 'eof') {
      const value = this.current().value;
      if (!angle && !square && !paren && stops.has(value)) break;
      if (value === '<') angle++;
      else if (value === '>') angle--;
      else if (value === '[') square++;
      else if (value === ']') square--;
      else if (value === '(') paren++;
      else if (value === ')') paren--;
      text += this.next().value;
    }
    if (!text) fail('Expected a type.', this.current(), this, 'KR-LANG-PARSE-0004');
    return text;
  }
  structDeclaration(attributes, exported) {
    const token = this.identifier('struct name');
    const generics = this.genericParameters();
    const where = this.whereClause();
    this.expect('{');
    const fields = [];
    while (!this.at('}')) {
      const field = this.identifier('field name');
      this.expect(':');
      fields.push({ name: field.value, type: this.typeReference(new Set([',', ';', '}'])), token: field });
      this.match(','); this.match(';');
    }
    this.expect('}');
    return { kind: 'StructDeclaration', name: token.value, generics, where, fields, attributes, exported, token };
  }
  enumDeclaration(attributes, exported) {
    const token = this.identifier('enum name');
    const generics = this.genericParameters();
    const where = this.whereClause();
    this.expect('{');
    const variants = [];
    while (!this.at('}')) {
      const variant = this.identifier('enum variant');
      const fields = [];
      if (this.match('(')) {
        while (!this.at(')')) {
          fields.push({ name: null, type: this.typeReference(new Set([',', ')'])), token: this.current() });
          if (!this.match(',')) break;
        }
        this.expect(')');
      } else if (this.match('{')) {
        while (!this.at('}')) {
          const field = this.identifier('variant field');
          this.expect(':');
          fields.push({ name: field.value, type: this.typeReference(new Set([',', '}'])), token: field });
          if (!this.match(',')) break;
        }
        this.expect('}');
      }
      variants.push({ name: variant.value, fields, token: variant });
      this.match(',');
    }
    this.expect('}');
    return { kind: 'EnumDeclaration', name: token.value, generics, where, variants, attributes, exported, token };
  }
  traitDeclaration(attributes, exported) {
    const token = this.identifier('trait name');
    const generics = this.genericParameters();
    const where = this.whereClause();
    this.expect('{');
    const methods = [];
    while (!this.at('}')) {
      const methodAttributes = this.attributes();
      const async = Boolean(this.match('async'));
      this.expect('fn');
      methods.push(this.functionDeclaration(methodAttributes, false, async, false));
    }
    this.expect('}');
    return { kind: 'TraitDeclaration', name: token.value, generics, where, methods, attributes, exported, token };
  }
  implDeclaration(attributes) {
    const token = this.tokens[this.index - 1] ?? this.current();
    const generics = this.genericParameters();
    const first = this.typeReference(new Set(['for', 'where', '{']));
    let trait = null;
    let target = first;
    if (this.match('for')) { trait = first; target = this.typeReference(new Set(['where', '{'])); }
    const where = this.whereClause();
    this.expect('{');
    const methods = [];
    while (!this.at('}')) {
      const methodAttributes = this.attributes();
      const exported = Boolean(this.match('pub'));
      const async = Boolean(this.match('async'));
      this.expect('fn');
      methods.push(this.functionDeclaration(methodAttributes, exported, async, true));
    }
    this.expect('}');
    return { kind: 'ImplDeclaration', generics, trait, target, where, methods, attributes, token };
  }
  functionDeclaration(attributes, exported, async, bodyAllowed) {
    const token = this.identifier('function name');
    const generics = this.genericParameters();
    this.expect('(');
    const params = [];
    while (!this.at(')')) {
      const param = this.identifier('parameter');
      let type = 'unknown';
      if (this.match(':')) type = this.typeReference(new Set([',', ')']));
      params.push({ name: param.value, type, token: param });
      if (!this.match(',')) break;
    }
    this.expect(')');
    let returnType = 'void';
    if (this.match('->')) returnType = this.typeReference(new Set(['where', '{', ';']));
    const where = this.whereClause();
    let body = null;
    if (this.match(';')) {
      if (bodyAllowed) fail('Only trait method declarations may omit a body.', token, this, 'KR-LANG-PARSE-0005');
    } else body = this.block();
    return { kind: 'FunctionDeclaration', name: token.value, generics, params, returnType, where, body, attributes, exported, async, token };
  }
  block() {
    const token = this.expect('{');
    const body = [];
    while (!this.at('}')) {
      if (this.current().type === 'eof') fail('Unclosed block.', token, this, 'KR-LANG-PARSE-0006');
      body.push(this.statement());
    }
    this.expect('}');
    return { kind: 'Block', body, token };
  }
  statement() {
    if (this.match('let') || this.match('const')) {
      const keyword = this.tokens[this.index - 1];
      const mutable = keyword.value === 'let' && Boolean(this.match('mut'));
      const name = this.identifier('variable');
      let type = null;
      if (this.match(':')) type = this.typeReference(new Set(['=', ';']));
      this.expect('=');
      const init = this.expression();
      this.match(';');
      return { kind: 'VariableDeclaration', name: name.value, type, init, mutable, token: keyword };
    }
    if (this.match('return')) {
      const token = this.tokens[this.index - 1];
      const value = this.at(';') || this.at('}') ? null : this.expression();
      this.match(';');
      return { kind: 'ReturnStatement', value, token };
    }
    if (this.match('defer')) {
      const token = this.tokens[this.index - 1];
      const value = this.at('{') ? this.block() : this.expression();
      this.match(';');
      return { kind: 'DeferStatement', value, token };
    }
    if (this.match('if')) {
      const token = this.tokens[this.index - 1];
      const test = this.expression();
      const consequent = this.block();
      let alternate = null;
      if (this.match('else')) alternate = this.at('if') ? { kind: 'Block', body: [this.statement()], token } : this.block();
      return { kind: 'IfStatement', test, consequent, alternate, token };
    }
    const expression = this.expression();
    this.match(';');
    return { kind: 'ExpressionStatement', expression, token: expression.token };
  }
  expression(minimum = 0) {
    let left = this.prefix();
    const precedence = { '??': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '<': 5, '>': 5, '<=': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7 };
    while ((precedence[this.current().value] ?? -1) >= minimum) {
      const token = this.next();
      const rank = precedence[token.value];
      left = { kind: 'BinaryExpression', op: token.value, left, right: this.expression(rank + 1), token };
    }
    return left;
  }
  prefix() {
    const token = this.current();
    if (this.match('match')) return this.matchExpression(token);
    if (this.match('move')) return { kind: 'MoveExpression', value: this.expression(8), token };
    if (this.match('await')) return { kind: 'AwaitExpression', value: this.expression(8), token };
    if (this.match('&')) {
      const mutable = Boolean(this.match('mut'));
      return { kind: 'BorrowExpression', mutable, value: this.expression(8), token };
    }
    if (this.at('|')) return this.closureExpression();
    if (this.match('!') || this.match('-') || this.match('+')) {
      return { kind: 'UnaryExpression', op: this.tokens[this.index - 1].value, value: this.expression(8), token };
    }
    let node;
    const current = this.next();
    if (current.type === 'number') node = { kind: 'NumberLiteral', value: current.value, token: current };
    else if (current.type === 'string') node = { kind: 'StringLiteral', value: JSON.parse(current.value), token: current };
    else if (current.value === 'true' || current.value === 'false') node = { kind: 'BooleanLiteral', value: current.value === 'true', token: current };
    else if (current.type === 'identifier' || current.type === 'keyword') node = { kind: 'Identifier', name: current.value, token: current };
    else if (current.value === '(') { node = this.expression(); this.expect(')'); }
    else fail(`Invalid expression start '${current.value}'.`, current, this, 'KR-LANG-PARSE-0007');
    return this.postfix(node);
  }
  postfix(node) {
    while (true) {
      if (this.match('::') || this.match('.')) {
        const property = this.identifier('member');
        node = { kind: 'MemberExpression', object: node, property: property.value, token: property };
        continue;
      }
      let typeArguments = [];
      if (this.at('<') && this.genericCallAhead()) typeArguments = this.typeArguments();
      if (this.match('(')) {
        const args = [];
        while (!this.at(')')) {
          args.push(this.expression());
          if (!this.match(',')) break;
        }
        this.expect(')');
        node = { kind: 'CallExpression', callee: node, args, typeArguments, token: node.token };
        continue;
      }
      if (this.match('?')) { node = { kind: 'TryExpression', value: node, token: node.token }; continue; }
      break;
    }
    return node;
  }
  genericCallAhead() {
    let depth = 0;
    for (let offset = 0; offset < 64; offset++) {
      const token = this.current(offset);
      if (token.type === 'eof') return false;
      if (token.value === '<') depth++;
      if (token.value === '>' && !--depth) return this.current(offset + 1).value === '(';
    }
    return false;
  }
  typeArguments() {
    this.expect('<');
    const output = [];
    while (!this.at('>')) {
      output.push(this.typeReference(new Set([',', '>'])));
      if (!this.match(',')) break;
    }
    this.expect('>');
    return output;
  }
  closureExpression() {
    const token = this.expect('|');
    const params = [];
    while (!this.at('|')) {
      const param = this.identifier('closure parameter');
      let type = null;
      if (this.match(':')) type = this.typeReference(new Set([',', '|']));
      params.push({ name: param.value, type, token: param });
      if (!this.match(',')) break;
    }
    this.expect('|');
    let returnType = null;
    if (this.match('->')) returnType = this.typeReference(new Set(['{']));
    const body = this.at('{') ? this.block() : this.expression();
    return this.postfix({ kind: 'ClosureExpression', params, returnType, body, token });
  }
  matchExpression(token) {
    const value = this.expression();
    this.expect('{');
    const arms = [];
    while (!this.at('}')) {
      const pattern = this.pattern();
      let guard = null;
      if (this.match('if')) guard = this.expression();
      this.expect('=>');
      const body = this.at('{') ? this.block() : this.expression();
      arms.push({ pattern, guard, body, token: pattern.token });
      this.match(',');
    }
    this.expect('}');
    return this.postfix({ kind: 'MatchExpression', value, arms, token });
  }
  pattern() {
    const token = this.current();
    if (this.match('_')) return { kind: 'WildcardPattern', token };
    const first = this.identifier('pattern');
    const path = [first.value];
    while (this.match('::')) path.push(this.identifier('variant').value);
    const bindings = [];
    if (this.match('(')) {
      while (!this.at(')')) {
        if (this.match('_')) bindings.push(null);
        else bindings.push(this.identifier('pattern binding').value);
        if (!this.match(',')) break;
      }
      this.expect(')');
    }
    return { kind: path.length > 1 ? 'VariantPattern' : 'BindingPattern', path, bindings, token };
  }
}

export function parseLanguage(source, options = {}) {
  return new Parser(source, options).parse();
}

function baseType(type) {
  return String(type ?? 'unknown').replace(/^[&*](?:mut|const)?/, '').split('<')[0].trim();
}
function pathName(expression) {
  if (!expression) return null;
  if (expression.kind === 'Identifier') return expression.name;
  if (expression.kind === 'MemberExpression') {
    const parent = pathName(expression.object);
    return parent ? `${parent}.${expression.property}` : expression.property;
  }
  return null;
}
function expressionRoot(expression) {
  if (!expression) return null;
  if (expression.kind === 'Identifier') return expression.name;
  if (expression.kind === 'MemberExpression') return expressionRoot(expression.object);
  if (['MoveExpression', 'BorrowExpression', 'TryExpression', 'AwaitExpression', 'UnaryExpression'].includes(expression.kind)) return expressionRoot(expression.value);
  return null;
}
function expressionPath(expression) {
  if (!expression) return null;
  if (expression.kind === 'Identifier') return expression.name;
  if (expression.kind === 'MemberExpression') {
    const parent = expressionPath(expression.object);
    return parent ? `${parent}.${expression.property}` : expression.property;
  }
  return expressionPath(expression.value);
}

const BUILTIN_TRAITS = Object.freeze({
  i8: ['Copy', 'Clone', 'Eq', 'Ord', 'Send', 'Sync', 'Display'], i16: ['Copy', 'Clone', 'Eq', 'Ord', 'Send', 'Sync', 'Display'],
  i32: ['Copy', 'Clone', 'Eq', 'Ord', 'Send', 'Sync', 'Display'], i64: ['Copy', 'Clone', 'Eq', 'Ord', 'Send', 'Sync', 'Display'],
  u8: ['Copy', 'Clone', 'Eq', 'Ord', 'Send', 'Sync', 'Display'], u16: ['Copy', 'Clone', 'Eq', 'Ord', 'Send', 'Sync', 'Display'],
  u32: ['Copy', 'Clone', 'Eq', 'Ord', 'Send', 'Sync', 'Display'], u64: ['Copy', 'Clone', 'Eq', 'Ord', 'Send', 'Sync', 'Display'],
  usize: ['Copy', 'Clone', 'Eq', 'Ord', 'Send', 'Sync', 'Display'], isize: ['Copy', 'Clone', 'Eq', 'Ord', 'Send', 'Sync', 'Display'],
  bool: ['Copy', 'Clone', 'Eq', 'Send', 'Sync', 'Display'], String: ['Clone', 'Eq', 'Send', 'Sync', 'Display'],
});

function collectIdentifiers(node, output = new Set()) {
  if (!node || typeof node !== 'object') return output;
  if (node.kind === 'Identifier') output.add(node.name);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) collectIdentifiers(item, output);
    else if (value && typeof value === 'object' && value.kind) collectIdentifiers(value, output);
  }
  return output;
}

export class LanguageAnalyzer {
  constructor(program, options = {}) {
    this.program = program;
    this.file = program.file;
    this.options = options;
    this.structs = new Map();
    this.enums = new Map();
    this.traits = new Map();
    this.impls = [];
    this.functions = new Map();
    this.diagnostics = [];
    this.specializations = [];
    this.closures = [];
    this.dropPlans = {};
    this.borrowFacts = {};
  }
  diagnostic(code, message, token, severity = 'error', hint = null, details = null) {
    this.diagnostics.push({ code, message, severity, file: this.file, line: token?.line ?? 1, column: token?.column ?? 1, hint, details });
  }
  register() {
    for (const declaration of this.program.declarations) {
      const table = {
        StructDeclaration: this.structs,
        EnumDeclaration: this.enums,
        TraitDeclaration: this.traits,
        FunctionDeclaration: this.functions,
      }[declaration.kind];
      if (declaration.kind === 'ImplDeclaration') { this.impls.push(declaration); continue; }
      if (!table) continue;
      if (table.has(declaration.name)) this.diagnostic('KR-LANG-DECL-0001', `Duplicate declaration '${declaration.name}'.`, declaration.token);
      else table.set(declaration.name, declaration);
    }
  }
  traitsFor(type, stack = new Set()) {
    const name = baseType(type);
    const output = new Set(BUILTIN_TRAITS[name] ?? []);
    for (const impl of this.impls) if (baseType(impl.target) === name && impl.trait) output.add(baseType(impl.trait));
    const declaration = this.structs.get(name) ?? this.enums.get(name);
    for (const attr of declaration?.attributes ?? []) {
      if (attr.name === 'derive') for (const trait of attr.args) output.add(trait);
    }
    if (declaration && !stack.has(name)) {
      const next = new Set(stack);
      next.add(name);
      const fieldTypes = declaration.kind === 'StructDeclaration'
        ? declaration.fields.map(item => item.type)
        : declaration.variants.flatMap(variant => variant.fields.map(item => item.type));
      if (fieldTypes.length) {
        const inferred = fieldTypes.map(field => this.traitsFor(field, next));
        for (const trait of ['Copy', 'Clone', 'Send', 'Sync']) {
          if (inferred.every(set => set.has(trait))) output.add(trait);
        }
      } else for (const trait of ['Copy', 'Clone', 'Send', 'Sync']) output.add(trait);
      if (output.has('Drop')) output.delete('Copy');
    }
    return output;
  }
  hasDrop(type) { return this.traitsFor(type).has('Drop'); }
  constraints(declaration) {
    const output = new Map();
    for (const item of [...(declaration.generics ?? []), ...(declaration.where ?? [])]) {
      const current = output.get(item.name) ?? new Set();
      for (const bound of item.bounds ?? []) current.add(baseType(bound));
      output.set(item.name, current);
    }
    return output;
  }
  validateTypes() {
    for (const declaration of [...this.structs.values(), ...this.enums.values(), ...this.functions.values(), ...this.traits.values(), ...this.impls]) {
      const genericNames = new Set((declaration.generics ?? []).map(item => item.name));
      const inspect = type => {
        const name = baseType(type);
        if (['void', 'unknown', 'never'].includes(name) || BUILTIN_TRAITS[name] || genericNames.has(name)) return;
        if (!this.structs.has(name) && !this.enums.has(name) && !this.traits.has(name) && !['Result', 'Option', 'Fn', 'FnMut', 'FnOnce'].includes(name)) {
          this.diagnostic('KR-LANG-TYPE-0001', `Unknown type '${name}'.`, declaration.token, 'error', 'Declare the type or add it as a generic parameter.');
        }
      };
      for (const field of declaration.fields ?? []) inspect(field.type);
      for (const variant of declaration.variants ?? []) for (const field of variant.fields) inspect(field.type);
      for (const param of declaration.params ?? []) inspect(param.type);
      if (declaration.returnType) inspect(declaration.returnType);
    }
  }
  validateImpls() {
    const seen = new Set();
    for (const impl of this.impls) {
      const key = `${impl.trait ?? '<inherent>'}:${impl.target}`;
      if (seen.has(key)) this.diagnostic('KR-LANG-TRAIT-0001', `Conflicting implementation '${key}'.`, impl.token);
      seen.add(key);
      if (!impl.trait) continue;
      const traitName = baseType(impl.trait);
      const trait = this.traits.get(traitName);
      if (!trait && traitName !== 'Drop') {
        this.diagnostic('KR-LANG-TRAIT-0002', `Unknown trait '${traitName}'.`, impl.token);
        continue;
      }
      const required = new Map((trait?.methods ?? [{ name: 'drop', params: [], returnType: 'void' }]).map(method => [method.name, method]));
      const provided = new Map(impl.methods.map(method => [method.name, method]));
      for (const [name, requiredMethod] of required) {
        if (!provided.has(name)) {
          this.diagnostic('KR-LANG-TRAIT-0003', `Implementation of '${traitName}' is missing method '${name}'.`, impl.token);
          continue;
        }
        const implementation = provided.get(name);
        if (trait && implementation.params.length !== requiredMethod.params.length) {
          this.diagnostic('KR-LANG-TRAIT-0005', `Method '${name}' has ${implementation.params.length} parameter(s), but trait '${traitName}' requires ${requiredMethod.params.length}.`, implementation.token);
        }
        if (trait && baseType(implementation.returnType) !== baseType(requiredMethod.returnType)) {
          this.diagnostic('KR-LANG-TRAIT-0006', `Method '${name}' returns '${implementation.returnType}', but trait '${traitName}' requires '${requiredMethod.returnType}'.`, implementation.token);
        }
      }
      for (const [name] of provided) if (!required.has(name) && trait) this.diagnostic('KR-LANG-TRAIT-0004', `Method '${name}' is not declared by trait '${traitName}'.`, provided.get(name).token, 'warning');
    }
  }
  walkExpression(expression, context) {
    if (!expression) return;
    if (expression.kind === 'MatchExpression') this.validateMatch(expression, context);
    if (expression.kind === 'TryExpression' && !String(context.returnType).startsWith('Result<')) {
      this.diagnostic('KR-LANG-RESULT-0001', "The '?' operator requires a function returning Result<...>.", expression.token, 'error', 'Change the return type to Result<T, E> or handle the error with match.');
    }
    if (expression.kind === 'ClosureExpression') {
      const used = collectIdentifiers(expression.body);
      for (const param of expression.params) used.delete(param.name);
      const captures = [...used].filter(name => context.locals.has(name) || context.params.has(name)).sort();
      this.closures.push({ function: context.name, line: expression.token.line, captures, mode: expression.mutable ? 'FnMut' : 'Fn' });
    }
    if (expression.kind === 'CallExpression' && expression.typeArguments?.length) {
      const callee = pathName(expression.callee);
      const fn = this.functions.get(callee?.split('.').at(-1));
      if (fn && fn.generics.length !== expression.typeArguments.length) {
        this.diagnostic('KR-LANG-GENERIC-0001', `Generic call '${callee}' expects ${fn.generics.length} type argument(s), received ${expression.typeArguments.length}.`, expression.token);
      } else if (fn) {
        const constraints = this.constraints(fn);
        fn.generics.forEach((generic, index) => {
          const concrete = expression.typeArguments[index];
          for (const required of constraints.get(generic.name) ?? []) {
            if (!this.traitsFor(concrete).has(required)) {
              this.diagnostic('KR-LANG-GENERIC-0002', `Type '${concrete}' does not satisfy '${generic.name}: ${required}'.`, expression.token, 'error', `Implement ${required} for ${baseType(concrete)}.`);
            }
          }
        });
        this.specializations.push({ function: fn.name, typeArguments: expression.typeArguments, symbol: `${fn.name}$${expression.typeArguments.map(baseType).join('$')}` });
      }
    }
    for (const value of Object.values(expression)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item?.kind) this.walkExpression(item, context);
      } else if (value?.kind) this.walkExpression(value, context);
    }
  }
  validateMatch(expression, context) {
    const variants = new Map();
    let wildcard = false;
    let enumName = null;
    for (const arm of expression.arms) {
      if (arm.pattern.kind === 'WildcardPattern' || arm.pattern.kind === 'BindingPattern') wildcard = true;
      if (arm.pattern.kind === 'VariantPattern') {
        const [owner, variant] = arm.pattern.path;
        enumName ??= owner;
        if (enumName !== owner) this.diagnostic('KR-LANG-MATCH-0001', 'A match expression cannot mix variants from different enums.', arm.pattern.token);
        if (variants.has(variant) && !arm.guard) this.diagnostic('KR-LANG-MATCH-0002', `Duplicate match arm '${owner}::${variant}'.`, arm.pattern.token);
        const enumDeclaration = this.enums.get(owner);
        const variantDeclaration = enumDeclaration?.variants.find(item => item.name === variant);
        if (enumDeclaration && !variantDeclaration) this.diagnostic('KR-LANG-MATCH-0005', `Enum '${owner}' has no variant '${variant}'.`, arm.pattern.token);
        if (variantDeclaration && variantDeclaration.fields.length !== arm.pattern.bindings.length) {
          this.diagnostic('KR-LANG-MATCH-0006', `Pattern '${owner}::${variant}' expects ${variantDeclaration.fields.length} binding(s), received ${arm.pattern.bindings.length}.`, arm.pattern.token);
        }
        variants.set(variant, arm);
      }
      this.walkNode(arm.body, context);
      if (arm.guard) this.walkExpression(arm.guard, context);
    }
    if (!wildcard && enumName) {
      const declaration = this.enums.get(enumName);
      if (!declaration) this.diagnostic('KR-LANG-MATCH-0003', `Unknown enum '${enumName}' in pattern.`, expression.token);
      else {
        const missing = declaration.variants.map(item => item.name).filter(name => !variants.has(name));
        if (missing.length) this.diagnostic('KR-LANG-MATCH-0004', `Non-exhaustive match for '${enumName}'; missing ${missing.join(', ')}.`, expression.token, 'error', 'Add the missing variants or a wildcard arm.');
      }
    }
  }
  linearFacts(fn) {
    const statements = fn.body?.body ?? [];
    const lastUse = new Map();
    const inspectUses = (node, index) => {
      const ids = collectIdentifiers(node);
      for (const id of ids) lastUse.set(id, index);
    };
    statements.forEach((statement, index) => inspectUses(statement, index));
    const locals = new Map(fn.params.map(param => [param.name, { type: param.type, token: param.token, parameter: true }]));
    const moved = new Map();
    const borrows = new Map();
    const facts = { moves: [], borrows: [], nllEnds: [], partialMoves: [] };
    const visit = (expression, index, targetName = null) => {
      if (!expression) return;
      if (expression.kind === 'MoveExpression') {
        const path = expressionPath(expression.value);
        const root = expressionRoot(expression.value);
        if (path) {
          moved.set(path, index);
          facts.moves.push({ path, statement: index, line: expression.token.line });
          if (path.includes('.')) {
            facts.partialMoves.push({ path, root, statement: index });
            const localType = locals.get(root)?.type;
            const declaration = this.structs.get(baseType(localType));
            const permitsPartialDrop = declaration?.attributes?.some(item => item.name === 'partial_drop');
            if (localType && this.hasDrop(localType) && !permitsPartialDrop) {
              this.diagnostic('KR-LANG-MOVE-0002', `Cannot partially move '${path}' because '${baseType(localType)}' implements Drop.`, expression.token, 'error', `Add @partial_drop only when the Drop implementation safely handles moved fields.`);
            }
          }
        }
      }
      if (expression.kind === 'BorrowExpression') {
        const path = expressionPath(expression.value);
        const root = expressionRoot(expression.value);
        const active = [...borrows.values()].filter(item => item.root === root && item.end >= index);
        if (expression.mutable && active.length) this.diagnostic('KR-LANG-BORROW-0001', `Mutable borrow of '${path}' conflicts with an active borrow.`, expression.token);
        if (!expression.mutable && active.some(item => item.mutable)) this.diagnostic('KR-LANG-BORROW-0002', `Shared borrow of '${path}' conflicts with an active mutable borrow.`, expression.token);
        if (targetName) {
          const end = lastUse.get(targetName) ?? index;
          borrows.set(targetName, { root, path, mutable: expression.mutable, start: index, end });
          facts.borrows.push({ binding: targetName, path, mutable: expression.mutable, start: index, end });
          facts.nllEnds.push({ binding: targetName, statement: end });
        }
      }
      if (expression.kind === 'Identifier' || expression.kind === 'MemberExpression') {
        const path = expressionPath(expression);
        for (const [movedPath, at] of moved) {
          const overlaps = path === movedPath || path.startsWith(`${movedPath}.`) || movedPath.startsWith(`${path}.`);
          const siblingAllowed = movedPath.includes('.') && path && path.includes('.') && movedPath.split('.')[0] === path.split('.')[0] && movedPath.split('.')[1] !== path.split('.')[1];
          if (overlaps && !siblingAllowed && index > at) this.diagnostic('KR-LANG-MOVE-0001', `Use of moved value '${path}'.`, expression.token, 'error', 'Reinitialize the moved field or borrow it instead.');
        }
        if (expression.kind === 'MemberExpression') return;
      }
      for (const value of Object.values(expression)) {
        if (Array.isArray(value)) {
          for (const item of value) if (item?.kind) visit(item, index);
        } else if (value?.kind) visit(value, index);
      }
    };
    statements.forEach((statement, index) => {
      if (statement.kind === 'VariableDeclaration') {
        locals.set(statement.name, { type: statement.type ?? 'unknown', token: statement.token });
        visit(statement.init, index, statement.name);
      } else {
        for (const value of Object.values(statement)) {
          if (Array.isArray(value)) {
            for (const item of value) if (item?.kind) visit(item, index);
          } else if (value?.kind) visit(value, index);
        }
      }
      for (const [name, borrow] of borrows) if (borrow.end === index) borrows.delete(name);
    });
    this.borrowFacts[fn.name] = facts;
    return locals;
  }
  dropPlan(fn, locals) {
    const drops = [];
    for (const [name, local] of [...locals.entries()].reverse()) if (!local.parameter && this.hasDrop(local.type)) drops.push({ name, type: local.type });
    const defers = (fn.body?.body ?? []).filter(item => item.kind === 'DeferStatement').map((item, index) => ({ index, line: item.token.line }));
    this.dropPlans[fn.name] = { drops, defers, order: [...defers].reverse().map(item => `defer:${item.index}`).concat(drops.map(item => `drop:${item.name}`)) };
  }
  walkNode(node, context) {
    if (!node) return;
    if (node.kind === 'Block') {
      for (const statement of node.body) this.walkNode(statement, context);
      return;
    }
    if (node.kind === 'VariableDeclaration') {
      context.locals.add(node.name);
      this.walkExpression(node.init, context);
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item?.kind) this.walkNode(item, context);
      } else if (value?.kind) {
        if (value.kind.endsWith('Expression') || ['Identifier', 'NumberLiteral', 'StringLiteral', 'BooleanLiteral'].includes(value.kind)) this.walkExpression(value, context);
        else this.walkNode(value, context);
      }
    }
  }
  validateFunctions() {
    const all = [...this.functions.values(), ...this.impls.flatMap(impl => impl.methods)];
    for (const fn of all) {
      if (!fn.body) continue;
      const locals = this.linearFacts(fn);
      this.dropPlan(fn, locals);
      const context = { name: fn.name, returnType: fn.returnType, params: new Set(fn.params.map(item => item.name)), locals: new Set() };
      this.walkNode(fn.body, context);
    }
  }
  analyze() {
    this.register();
    this.validateTypes();
    this.validateImpls();
    this.validateFunctions();
    const errors = this.diagnostics.filter(item => item.severity === 'error');
    return {
      ok: errors.length === 0,
      diagnostics: this.diagnostics,
      errors,
      warnings: this.diagnostics.filter(item => item.severity === 'warning'),
      traits: Object.fromEntries([...this.structs.keys(), ...this.enums.keys()].map(name => [name, [...this.traitsFor(name)].sort()])),
      specializations: this.specializations,
      closures: this.closures,
      dropPlans: this.dropPlans,
      borrowFacts: this.borrowFacts,
      manifest: {
        structs: this.structs.size, enums: this.enums.size, traits: this.traits.size,
        impls: this.impls.length, functions: this.functions.size,
      },
    };
  }
}

export function analyzeLanguage(programOrSource, options = {}) {
  const program = typeof programOrSource === 'string' ? parseLanguage(programOrSource, options) : programOrSource;
  return new LanguageAnalyzer(program, options).analyze();
}

export function assertLanguage(report) {
  if (report.errors.length) {
    const first = report.errors[0];
    throw new KuraLanguageError(first.message, { line: first.line, column: first.column }, {
      file: first.file, code: first.code, hint: first.hint, details: first.details,
    });
  }
  return report;
}

function escapeIdentifier(value) { return value.replace(/[^A-Za-z0-9_$]/g, '_'); }
function emitPath(expression) {
  if (expression.kind === 'Identifier') return escapeIdentifier(expression.name);
  if (expression.kind === 'MemberExpression') return `${emitPath(expression.object)}.${escapeIdentifier(expression.property)}`;
  return emitExpression(expression);
}
function emitPatternCondition(pattern, value) {
  if (pattern.kind === 'WildcardPattern' || pattern.kind === 'BindingPattern') return 'true';
  const variant = pattern.path.at(-1);
  return `${value}.tag === ${JSON.stringify(variant)}`;
}
function emitPatternBindings(pattern, value) {
  if (pattern.kind === 'BindingPattern') return pattern.path[0] === '_' ? '' : `const ${escapeIdentifier(pattern.path[0])} = ${value};`;
  if (pattern.kind !== 'VariantPattern') return '';
  return pattern.bindings.map((name, index) => name ? `const ${escapeIdentifier(name)} = ${value}.values[${index}];` : '').filter(Boolean).join(' ');
}
function emitBlockExpression(block, state) {
  const body = block.body ?? [];
  if (!body.length) return 'undefined';
  const prefix = body.slice(0, -1).map(item => emitStatement(item, 1, state)).join('\n');
  const last = body.at(-1);
  const result = last.kind === 'ExpressionStatement' ? emitExpression(last.expression, state) : `(() => { ${emitStatement(last, 0, state)} })()`;
  return `(() => {${prefix ? `\n${prefix}\n` : ''}return ${result};})()`;
}
function emitExpression(expression, state = {}) {
  if (!expression) return 'undefined';
  switch (expression.kind) {
    case 'NumberLiteral': return expression.value.replaceAll('_', '');
    case 'StringLiteral': return JSON.stringify(expression.value);
    case 'BooleanLiteral': return expression.value ? 'true' : 'false';
    case 'Identifier': return escapeIdentifier(expression.name);
    case 'MemberExpression': return emitPath(expression);
    case 'UnaryExpression': return `(${expression.op}${emitExpression(expression.value, state)})`;
    case 'BinaryExpression': return `(${emitExpression(expression.left, state)} ${expression.op} ${emitExpression(expression.right, state)})`;
    case 'MoveExpression': {
      if (expression.value.kind === 'MemberExpression') {
        return `__kr_move_field(${emitExpression(expression.value.object, state)}, ${JSON.stringify(expression.value.property)})`;
      }
      return `__kr_move(${emitExpression(expression.value, state)})`;
    }
    case 'BorrowExpression': return emitExpression(expression.value, state);
    case 'AwaitExpression': return `await ${emitExpression(expression.value, state)}`;
    case 'TryExpression': return `__kr_try(${emitExpression(expression.value, state)})`;
    case 'CallExpression': return `${emitExpression(expression.callee, state)}(${expression.args.map(item => emitExpression(item, state)).join(', ')})`;
    case 'ClosureExpression': {
      const params = expression.params.map(item => escapeIdentifier(item.name)).join(', ');
      if (expression.body.kind === 'Block') return `(${params}) => (${emitBlockExpression(expression.body, state)})`;
      return `(${params}) => (${emitExpression(expression.body, state)})`;
    }
    case 'MatchExpression': {
      const temp = `__match_${state.matchCounter = (state.matchCounter ?? 0) + 1}`;
      const arms = expression.arms.map(arm => {
        const condition = emitPatternCondition(arm.pattern, temp);
        const guard = arm.guard ? ` && (${emitExpression(arm.guard, state)})` : '';
        const bindings = emitPatternBindings(arm.pattern, temp);
        const value = arm.body.kind === 'Block' ? emitBlockExpression(arm.body, state) : emitExpression(arm.body, state);
        return `if (${condition}${guard}) { ${bindings} return ${value}; }`;
      }).join(' else ');
      return `(() => { const ${temp} = ${emitExpression(expression.value, state)}; ${arms} throw new Error("non-exhaustive Kura match"); })()`;
    }
    default: throw new Error(`Cannot emit expression '${expression.kind}'.`);
  }
}
function indent(depth) { return '  '.repeat(depth); }
function emitStatement(statement, depth = 0, state = {}) {
  const prefix = indent(depth);
  switch (statement.kind) {
    case 'VariableDeclaration': {
      const name = escapeIdentifier(statement.name);
      if (state.cleanupNames?.has(statement.name)) return `${prefix}${name} = ${emitExpression(statement.init, state)};`;
      return `${prefix}${statement.mutable ? 'let' : 'const'} ${name} = ${emitExpression(statement.init, state)};`;
    }
    case 'ReturnStatement': return `${prefix}return${statement.value ? ` ${emitExpression(statement.value, state)}` : ''};`;
    case 'ExpressionStatement': return `${prefix}${emitExpression(statement.expression, state)};`;
    case 'DeferStatement': return `${prefix}__kr_defers.push(() => ${statement.value.kind === 'Block' ? emitBlockExpression(statement.value, state) : emitExpression(statement.value, state)});`;
    case 'IfStatement': return `${prefix}if (${emitExpression(statement.test, state)}) {\n${statement.consequent.body.map(item => emitStatement(item, depth + 1, state)).join('\n')}\n${prefix}}${statement.alternate ? ` else {\n${statement.alternate.body.map(item => emitStatement(item, depth + 1, state)).join('\n')}\n${prefix}}` : ''}`;
    default: throw new Error(`Cannot emit statement '${statement.kind}'.`);
  }
}
function functionNeedsTry(fn) {
  let found = false;
  const visit = node => {
    if (!node || found || typeof node !== 'object') return;
    if (node.kind === 'TryExpression') { found = true; return; }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(fn.body);
  return found;
}
function emitFunction(fn, analyzer) {
  const plan = analyzer.dropPlans[fn.name] ?? { drops: [] };
  const body = fn.body?.body ?? [];
  const hasCleanup = plan.drops.length || body.some(item => item.kind === 'DeferStatement');
  const state = { cleanupNames: new Set(plan.drops.map(item => item.name)) };
  const params = fn.params.map(item => escapeIdentifier(item.name)).join(', ');
  const prologue = [];
  if (hasCleanup) {
    prologue.push('const __kr_defers = [];');
    for (const item of plan.drops) prologue.push(`let ${escapeIdentifier(item.name)};`);
  }
  const emitted = body.map(item => emitStatement(item, 0, state));
  let core;
  if (functionNeedsTry(fn)) {
    core = [
      'try {',
      ...emitted.map(line => `  ${line}`),
      '} catch (__error) {',
      '  if (__error instanceof __KrEarlyReturn) return __error.value;',
      '  throw __error;',
      '}',
    ];
  } else core = emitted;
  const lines = [...prologue];
  if (hasCleanup) {
    lines.push('try {');
    lines.push(...core.map(line => `  ${line}`));
    lines.push('} finally {');
    lines.push('  for (let __i = __kr_defers.length - 1; __i >= 0; __i--) __kr_defers[__i]();');
    lines.push(...plan.drops.map(item => `  __kr_drop(${escapeIdentifier(item.name)});`));
    lines.push('}');
  } else lines.push(...core);
  return `${fn.exported ? 'export ' : ''}${fn.async ? 'async ' : ''}function ${escapeIdentifier(fn.name)}(${params}) {\n${lines.map(line => `  ${line}`).join('\n')}\n}`;
}
function emitStruct(declaration) {
  const name = escapeIdentifier(declaration.name);
  const fields = declaration.fields.map(item => escapeIdentifier(item.name));
  return `${declaration.exported ? 'export ' : ''}function ${name}(${fields.join(', ')}) {\n  if (!new.target) return new ${name}(${fields.join(', ')});\n  ${fields.map(field => `this.${field} = ${field};`).join(' ')}\n}`;
}
function emitEnum(declaration) {
  const variants = declaration.variants.map(variant => {
    if (!variant.fields.length) return `${escapeIdentifier(variant.name)}: Object.freeze({ tag: ${JSON.stringify(variant.name)}, values: Object.freeze([]) })`;
    const params = variant.fields.map((field, index) => escapeIdentifier(field.name ?? `value${index}`));
    return `${escapeIdentifier(variant.name)}: (${params.join(', ')}) => Object.freeze({ tag: ${JSON.stringify(variant.name)}, values: Object.freeze([${params.join(', ')}]) })`;
  });
  return `${declaration.exported ? 'export ' : ''}const ${escapeIdentifier(declaration.name)} = Object.freeze({ ${variants.join(', ')} });`;
}
function emitImpl(impl, analyzer) {
  const target = escapeIdentifier(baseType(impl.target));
  return impl.methods.map(method => {
    const params = method.params.filter(item => item.name !== 'self').map(item => escapeIdentifier(item.name));
    const bodyFn = emitFunction({ ...method, name: `__impl_${target}_${method.name}`, exported: false }, analyzer);
    return `${bodyFn}\n${target}.prototype.${escapeIdentifier(method.name)} = function(${params.join(', ')}) { return __impl_${target}_${method.name}(${method.params.some(item => item.name === 'self') ? 'this' + (params.length ? ', ' : '') : ''}${params.join(', ')}); };`;
  }).join('\n');
}

export function compileLanguage(source, options = {}) {
  const program = parseLanguage(source, options);
  const analyzer = new LanguageAnalyzer(program, options);
  const report = analyzer.analyze();
  assertLanguage(report);
  const prelude = `// Generated by Kura typed language core\nclass __KrEarlyReturn { constructor(value) { this.value = value; } }\nconst __kr_try = value => { if (value?.tag === 'Err') throw new __KrEarlyReturn(value); return value?.tag === 'Ok' ? value.values[0] : value; };\nconst __kr_move = value => value;\nconst __kr_move_field = (object, field) => { const value = object[field]; object[field] = undefined; return value; };\nconst __kr_drop = value => { if (value && typeof value.drop === 'function') value.drop(); };\nexport const Result = Object.freeze({ Ok: value => Object.freeze({tag:'Ok', values:Object.freeze([value])}), Err: error => Object.freeze({tag:'Err', values:Object.freeze([error])}) });\nexport const Option = Object.freeze({ Some: value => Object.freeze({tag:'Some', values:Object.freeze([value])}), None: Object.freeze({tag:'None', values:Object.freeze([])}) });`;
  const sections = [prelude];
  for (const declaration of program.declarations) {
    if (declaration.kind === 'StructDeclaration') sections.push(emitStruct(declaration));
    else if (declaration.kind === 'EnumDeclaration') sections.push(emitEnum(declaration));
    else if (declaration.kind === 'FunctionDeclaration') sections.push(emitFunction(declaration, analyzer));
  }
  for (const impl of analyzer.impls) sections.push(emitImpl(impl, analyzer));
  const hasMain = analyzer.functions.has('main');
  if (hasMain && options.autoRun !== false) sections.push('const __kr_main_result = await main();\nif (typeof __kr_main_result === "number") process.exitCode = __kr_main_result;');
  return { program, report, code: sections.filter(Boolean).join('\n\n') + '\n' };
}

export function formatLanguageReport(report, options = {}) {
  if (options.json) return JSON.stringify(report, null, 2) + '\n';
  const lines = [
    'Kura Typed Language Core',
    `Status: ${report.ok ? 'ok' : 'failed'}`,
    `Declarations: ${JSON.stringify(report.manifest)}`,
    `Generic specializations: ${report.specializations.length}`,
    `Closures: ${report.closures.length}`,
    `Errors: ${report.errors.length}`,
    `Warnings: ${report.warnings.length}`,
  ];
  for (const item of report.diagnostics) lines.push(`${item.file}:${item.line}:${item.column}: ${item.severity} ${item.code}: ${item.message}`);
  return lines.join('\n') + '\n';
}
