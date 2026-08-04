// SPDX-License-Identifier: MIT OR Apache-2.0
import { decodeString, fail, tokenizeNativeSource } from './system-native-common.mjs';

const PRECEDENCE = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
};

class Parser {
  constructor(source, options = {}) {
    this.file = options.file ?? '<input>';
    this.tokens = tokenizeNativeSource(source, options);
    this.index = 0;
  }

  current(offset = 0) { return this.tokens[this.index + offset] ?? this.tokens.at(-1); }
  at(value) { return this.current().value === value; }
  next() { return this.tokens[this.index++]; }
  match(value) { return this.at(value) ? this.next() : null; }
  expect(value) {
    if (!this.at(value)) fail(`Expected '${value}', found '${this.current().value || 'end of file'}'.`, this.current(), this, 'KR-NATIVE-PARSE-0001');
    return this.next();
  }
  identifier(purpose = 'identifier') {
    const token = this.current();
    if (token.type !== 'identifier') fail(`Expected ${purpose}.`, token, this, 'KR-NATIVE-PARSE-0002');
    return this.next();
  }

  parse() {
    const directives = [];
    const declarations = [];
    while (this.at('#!')) directives.push(this.directive());
    while (this.current().type !== 'eof') declarations.push(this.declaration());
    return { kind: 'NativeProgram', file: this.file, directives, declarations };
  }

  directive() {
    const token = this.expect('#!');
    this.expect('[');
    const name = this.identifier('directive').value;
    const args = [];
    if (this.match('(')) {
      while (!this.at(')')) {
        const item = this.next();
        if (!['string', 'identifier', 'number'].includes(item.type)) fail('Invalid directive argument.', item, this);
        args.push(item.type === 'string' ? decodeString(item, this) : item.value);
        if (!this.match(',')) break;
      }
      this.expect(')');
    }
    this.expect(']');
    return { kind: 'Directive', name, args, token };
  }

  attributes() {
    const attributes = [];
    while (this.match('@')) {
      const token = this.identifier('attribute');
      const args = [];
      if (this.match('(')) {
        while (!this.at(')')) {
          const item = this.next();
          if (!['string', 'identifier', 'number'].includes(item.type)) fail('Invalid attribute argument.', item, this);
          args.push(item.type === 'string' ? decodeString(item, this) : item.value);
          if (!this.match(',')) break;
        }
        this.expect(')');
      }
      attributes.push({ name: token.value, args, token });
    }
    return attributes;
  }

  declaration() {
    const attributes = this.attributes();
    const publicFlag = Boolean(this.match('pub'));
    const unsafeFlag = Boolean(this.match('unsafe'));
    let abi = null;
    if (this.match('extern')) {
      if (this.current().type === 'string') abi = decodeString(this.next(), this);
      else abi = 'C';
    }

    if (this.match('struct')) return this.structDeclaration(attributes, publicFlag);
    if (this.match('const')) return this.constantDeclaration(attributes, publicFlag);
    if (this.match('static')) return this.staticDeclaration(attributes, publicFlag);
    if (this.match('fn')) return this.functionDeclaration(attributes, publicFlag, unsafeFlag, abi);
    fail('Expected function, struct, const, or static declaration.', this.current(), this, 'KR-NATIVE-PARSE-0005');
  }

  structDeclaration(attributes, publicFlag) {
    const token = this.identifier('struct name');
    this.expect('{');
    const fields = [];
    while (!this.at('}')) {
      const field = this.identifier('field name');
      this.expect(':');
      fields.push({ name: field.value, type: this.typeUntil(new Set([',', ';', '}'])), token: field });
      this.match(',');
      this.match(';');
    }
    this.expect('}');
    return { kind: 'StructDeclaration', name: token.value, fields, attributes, public: publicFlag, token };
  }

  constantDeclaration(attributes, publicFlag) {
    const token = this.identifier('constant name');
    this.expect(':');
    const type = this.typeUntil(new Set(['=']));
    this.expect('=');
    const init = this.expression();
    this.match(';');
    return { kind: 'ConstantDeclaration', name: token.value, type, init, attributes, public: publicFlag, token };
  }

  staticDeclaration(attributes, publicFlag) {
    const mutable = Boolean(this.match('mut'));
    const token = this.identifier('static name');
    this.expect(':');
    const type = this.typeUntil(new Set(['=']));
    this.expect('=');
    const init = this.expression();
    this.match(';');
    return { kind: 'StaticDeclaration', name: token.value, type, init, attributes, public: publicFlag, mutable, token };
  }

  functionDeclaration(attributes, publicFlag, unsafeFlag, abi) {
    const token = this.identifier('function name');
    this.expect('(');
    const params = [];
    while (!this.at(')')) {
      const param = this.identifier('parameter');
      this.expect(':');
      params.push({ name: param.value, type: this.typeUntil(new Set([',', ')'])), token: param });
      if (!this.match(',')) break;
    }
    this.expect(')');
    let returnType = 'void';
    if (this.match('->')) returnType = this.typeUntil(new Set(['{', ';']));
    let body = null;
    if (this.match(';')) {
      if (!abi) fail('Only extern functions may omit a body.', token, this, 'KR-NATIVE-PARSE-0010');
    } else {
      body = this.block();
    }
    return {
      kind: 'FunctionDeclaration', name: token.value, params, returnType, body,
      attributes, public: publicFlag, unsafe: unsafeFlag, abi,
      external: body === null, token,
    };
  }

  typeUntil(stops) {
    let text = '';
    let square = 0;
    let angle = 0;
    while (this.current().type !== 'eof') {
      const value = this.current().value;
      if (!square && !angle && stops.has(value)) break;
      if (value === '[') square++;
      if (value === ']') square--;
      if (value === '<') angle++;
      if (value === '>') angle--;
      text += this.next().value;
      if (value === 'const' || value === 'mut') text += ' ';
    }
    if (!text.trim()) fail('Expected type.', this.current(), this);
    return text.trim();
  }

  block() {
    const token = this.expect('{');
    const body = [];
    while (!this.at('}')) {
      if (this.current().type === 'eof') fail('Unclosed block.', token, this);
      body.push(this.statement());
    }
    this.expect('}');
    return { kind: 'Block', body, token };
  }

  statement() {
    if (this.match('unsafe')) return { kind: 'UnsafeBlock', body: this.block(), token: this.tokens[this.index - 1] };
    if (this.match('let') || this.match('const')) {
      const keyword = this.tokens[this.index - 1];
      const name = this.identifier('variable');
      let type = null;
      if (this.match(':')) type = this.typeUntil(new Set(['=', ';']));
      this.expect('=');
      const init = this.expression();
      this.match(';');
      return { kind: 'VariableDeclaration', mutable: keyword.value === 'let', name: name.value, type, init, token: keyword };
    }
    if (this.match('return')) {
      const token = this.tokens[this.index - 1];
      const value = this.at(';') || this.at('}') ? null : this.expression();
      this.match(';');
      return { kind: 'ReturnStatement', value, token };
    }
    if (this.match('if')) {
      const token = this.tokens[this.index - 1];
      const test = this.expression();
      const consequent = this.block();
      let alternate = null;
      if (this.match('else')) alternate = this.at('if') ? { kind: 'Block', body: [this.statement()], token } : this.block();
      return { kind: 'IfStatement', test, consequent, alternate, token };
    }
    if (this.match('while')) {
      const token = this.tokens[this.index - 1];
      return { kind: 'WhileStatement', test: this.expression(), body: this.block(), token };
    }
    const target = this.expression();
    if (this.match('=')) {
      const value = this.expression();
      this.match(';');
      return { kind: 'AssignmentStatement', target, value, token: target.token };
    }
    for (const op of ['+=', '-=', '*=', '/=', '%=']) {
      if (this.match(op)) {
        const value = this.expression();
        this.match(';');
        return { kind: 'CompoundAssignmentStatement', target, op, value, token: target.token };
      }
    }
    this.match(';');
    return { kind: 'ExpressionStatement', expression: target, token: target.token };
  }

  expression(minimum = 0) {
    let left = this.prefix();
    while ((PRECEDENCE[this.current().value] ?? -1) >= minimum) {
      const token = this.next();
      const rank = PRECEDENCE[token.value];
      left = { kind: 'BinaryExpression', op: token.value, left, right: this.expression(rank + 1), token };
    }
    return left;
  }

  prefix() {
    const token = this.next();
    let node;
    if (['!', '~', '-', '+', '*', '&'].includes(token.value)) {
      let mutable = false;
      if (token.value === '&' && this.match('mut')) mutable = true;
      node = { kind: 'UnaryExpression', op: token.value, mutable, value: this.expression(11), token };
    } else if (token.type === 'number') node = { kind: 'IntegerLiteral', value: token.value, token };
    else if (token.value === 'true' || token.value === 'false') node = { kind: 'BooleanLiteral', value: token.value === 'true', token };
    else if (token.type === 'identifier' || token.type === 'keyword') node = { kind: 'Identifier', name: token.value, token };
    else if (token.value === '(') { node = this.expression(); this.expect(')'); }
    else fail(`Invalid expression start '${token.value}'.`, token, this, 'KR-NATIVE-PARSE-0008');

    while (true) {
      if (this.match('::') || this.match('.')) {
        const property = this.identifier('member');
        node = { kind: 'MemberExpression', object: node, property: property.value, token: property };
        continue;
      }
      let typeArguments = [];
      if (this.at('<') && this.genericAhead()) typeArguments = this.typeArguments();
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
      break;
    }
    return node;
  }

  genericAhead() {
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
      output.push(this.typeUntil(new Set([',', '>'])));
      if (!this.match(',')) break;
    }
    this.expect('>');
    return output;
  }
}

export function parseNativeSystemSource(source, options = {}) {
  return new Parser(source, options).parse();
}
