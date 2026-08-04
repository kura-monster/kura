// SPDX-License-Identifier: MIT OR Apache-2.0
import { fail, parseInteger } from './system-native-common.mjs';

function bool(value) { return value === 0n ? 0n : 1n; }

export class NativeConstantEvaluator {
  constructor(compiler) {
    this.compiler = compiler;
    this.cache = new Map();
    this.active = new Set();
  }

  evaluateDeclaration(declaration) {
    if (this.cache.has(declaration.name)) return this.cache.get(declaration.name);
    if (this.active.has(declaration.name)) {
      fail(`Cyclic constant '${declaration.name}'.`, declaration.token, this.compiler.context, 'KR-NATIVE-CONST-0001');
    }
    this.active.add(declaration.name);
    try {
      const value = this.evaluate(declaration.init);
      const type = this.compiler.resolveType(declaration.type, declaration.token);
      const normalized = this.normalize(value, type, declaration.token);
      const result = { value: normalized, type };
      this.cache.set(declaration.name, result);
      return result;
    } finally {
      this.active.delete(declaration.name);
    }
  }

  evaluate(expression) {
    switch (expression.kind) {
      case 'IntegerLiteral': return parseInteger(expression.value);
      case 'BooleanLiteral': return expression.value ? 1n : 0n;
      case 'Identifier': {
        const declaration = this.compiler.constants.get(expression.name);
        if (!declaration) fail(`Unknown compile-time name '${expression.name}'.`, expression.token, this.compiler.context, 'KR-NATIVE-CONST-0002');
        return this.evaluateDeclaration(declaration).value;
      }
      case 'UnaryExpression': {
        const value = this.evaluate(expression.value);
        if (expression.op === '+') return value;
        if (expression.op === '-') return -value;
        if (expression.op === '~') return ~value;
        if (expression.op === '!') return bool(value) ? 0n : 1n;
        fail(`Operator '${expression.op}' is not allowed in a constant.`, expression.token, this.compiler.context, 'KR-NATIVE-CONST-0003');
        break;
      }
      case 'BinaryExpression': {
        const left = this.evaluate(expression.left);
        const right = this.evaluate(expression.right);
        switch (expression.op) {
          case '+': return left + right;
          case '-': return left - right;
          case '*': return left * right;
          case '/':
            if (right === 0n) fail('Division by zero in constant expression.', expression.token, this.compiler.context, 'KR-NATIVE-CONST-0004');
            return left / right;
          case '%':
            if (right === 0n) fail('Modulo by zero in constant expression.', expression.token, this.compiler.context, 'KR-NATIVE-CONST-0004');
            return left % right;
          case '<<': return left << right;
          case '>>': return left >> right;
          case '&': return left & right;
          case '|': return left | right;
          case '^': return left ^ right;
          case '==': return left === right ? 1n : 0n;
          case '!=': return left !== right ? 1n : 0n;
          case '<': return left < right ? 1n : 0n;
          case '>': return left > right ? 1n : 0n;
          case '<=': return left <= right ? 1n : 0n;
          case '>=': return left >= right ? 1n : 0n;
          case '&&': return bool(left) && bool(right) ? 1n : 0n;
          case '||': return bool(left) || bool(right) ? 1n : 0n;
          default: fail(`Operator '${expression.op}' is not allowed in a constant.`, expression.token, this.compiler.context, 'KR-NATIVE-CONST-0003');
        }
        break;
      }
      default:
        fail(`Expression '${expression.kind}' is not compile-time evaluable.`, expression.token, this.compiler.context, 'KR-NATIVE-CONST-0005');
    }
  }

  normalize(value, type, token) {
    if (type.kind === 'bool') return value === 0n ? 0n : 1n;
    if (type.kind !== 'integer') {
      fail('Compile-time constants currently require an integer or bool type.', token, this.compiler.context, 'KR-NATIVE-CONST-0006');
    }
    const bits = BigInt(type.bits);
    const modulus = 1n << bits;
    let normalized = ((value % modulus) + modulus) % modulus;
    if (type.signed && normalized >= (1n << (bits - 1n))) normalized -= modulus;
    return normalized;
  }
}
