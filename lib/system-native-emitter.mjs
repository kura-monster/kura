// SPDX-License-Identifier: MIT OR Apache-2.0
import { formatSystemType, llvmType, parseSystemType } from './system.mjs';
import { fail, integerLiteral, isInteger, isPointer, safeName, typeEquals } from './system-native-common.mjs';
import { compileSystemIntrinsic } from './system-native-intrinsics.mjs';

export class FunctionEmitter {
  constructor(compiler, declaration) {
    this.compiler = compiler;
    this.declaration = declaration;
    this.lines = [];
    this.allocas = [];
    this.counter = 0;
    this.labelCounter = 0;
    this.scopes = [new Map()];
    this.unsafeDepth = declaration.unsafe ? 1 : 0;
    this.terminated = false;
    this.returnType = compiler.resolveType(declaration.returnType, declaration.token);
  }

  temp(prefix = 'v') { return `%${prefix}${this.counter++}`; }
  label(prefix) { return `${prefix}.${this.labelCounter++}`; }
  emit(line) { this.lines.push(`  ${line}`); }
  emitLabel(label) { this.lines.push(`${label}:`); this.terminated = false; }
  pushScope() { this.scopes.push(new Map()); }
  popScope() { this.scopes.pop(); }

  define(name, value, token) {
    if (this.scopes.at(-1).has(name)) fail(`Duplicate local '${name}'.`, token, this.compiler.context, 'KR-NATIVE-TYPE-0001');
    this.scopes.at(-1).set(name, value);
  }

  lookup(name, token) {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      if (this.scopes[index].has(name)) return this.scopes[index].get(name);
    }
    if (this.compiler.constants.has(name)) {
      const declaration = this.compiler.constants.get(name);
      const result = this.compiler.constantEvaluator.evaluateDeclaration(declaration);
      return { kind: 'constant', ...result };
    }
    if (this.compiler.globals.has(name)) {
      const declaration = this.compiler.globals.get(name);
      return {
        kind: 'global', declaration,
        type: this.compiler.resolveType(declaration.type, declaration.token),
        pointer: `@${this.compiler.symbolName(declaration)}`,
        mutable: declaration.mutable,
      };
    }
    if (this.compiler.functions.has(name)) return { kind: 'function', declaration: this.compiler.functions.get(name) };
    fail(`Unknown name '${name}'.`, token, this.compiler.context, 'KR-NATIVE-TYPE-0002');
  }

  requireUnsafe(token, operation) {
    if (!this.unsafeDepth) fail(`${operation} requires an unsafe context.`, token, this.compiler.context, 'KR-NATIVE-SAFE-0001');
  }

  compile() {
    const parameters = [];
    for (const parameter of this.declaration.params) {
      const type = this.compiler.resolveType(parameter.type, parameter.token);
      const llvm = llvmType(type, { target: this.compiler.target.triple });
      const argument = `%arg.${safeName(parameter.name)}`;
      const slot = `%${safeName(parameter.name)}.addr`;
      parameters.push(`${llvm} ${argument}`);
      this.allocas.push(
        `  ${slot} = alloca ${llvm}, align ${this.compiler.alignOf(type)}`,
        `  store ${llvm} ${argument}, ptr ${slot}, align ${this.compiler.alignOf(type)}`,
      );
      this.define(parameter.name, { kind: 'local', type, pointer: slot, mutable: true }, parameter.token);
    }
    this.compileBlock(this.declaration.body, false);
    if (!this.terminated) {
      if (this.returnType.kind === 'void') this.emit('ret void');
      else if (this.returnType.kind === 'never') this.emit('unreachable');
      else fail(`Function '${this.declaration.name}' may not return.`, this.declaration.token, this.compiler.context, 'KR-NATIVE-TYPE-0003');
    }

    const linkage = this.compiler.functionLinkage(this.declaration);
    const callingConvention = this.compiler.functionCallingConvention(this.declaration);
    const symbol = this.compiler.symbolName(this.declaration);
    const suffix = this.compiler.functionDefinitionAttributes(this.declaration);
    return [
      `define ${linkage}${callingConvention}${llvmType(this.returnType, { target: this.compiler.target.triple })} @${symbol}(${parameters.join(', ')})${this.returnType.kind === 'never' ? ' noreturn' : ''}${suffix} {`,
      'entry:',
      ...this.allocas,
      ...this.lines,
      '}',
      '',
    ].join('\n');
  }

  compileBlock(block, scoped = true) {
    if (scoped) this.pushScope();
    for (const statement of block.body) {
      if (this.terminated) break;
      this.compileStatement(statement);
    }
    if (scoped) this.popScope();
  }

  compileStatement(statement) {
    switch (statement.kind) {
      case 'UnsafeBlock':
        this.unsafeDepth++;
        try { this.compileBlock(statement.body); } finally { this.unsafeDepth--; }
        return;
      case 'VariableDeclaration': {
        const initial = this.compileExpression(statement.init);
        const type = statement.type ? this.compiler.resolveType(statement.type, statement.token) : initial.type;
        const value = this.cast(initial, type, statement.token);
        const slot = `%${safeName(statement.name)}.${this.counter++}.addr`;
        const llvm = llvmType(type, { target: this.compiler.target.triple });
        this.allocas.push(`  ${slot} = alloca ${llvm}, align ${this.compiler.alignOf(type)}`);
        this.emit(`store ${llvm} ${value.value}, ptr ${slot}, align ${this.compiler.alignOf(type)}`);
        this.define(statement.name, { kind: 'local', type, pointer: slot, mutable: statement.mutable }, statement.token);
        return;
      }
      case 'AssignmentStatement': this.assign(statement.target, statement.value, statement.token); return;
      case 'CompoundAssignmentStatement': {
        const target = this.compileLValue(statement.target);
        const value = this.compileBinary(statement.op[0], this.load(target), this.compileExpression(statement.value), statement.token);
        this.store(target, this.cast(value, target.type, statement.token), statement.token);
        return;
      }
      case 'ReturnStatement':
        if (!statement.value) {
          if (this.returnType.kind !== 'void') fail('Return value required.', statement.token, this.compiler.context);
          this.emit('ret void');
        } else {
          if (this.returnType.kind === 'void' || this.returnType.kind === 'never') fail('This function cannot return a value.', statement.token, this.compiler.context);
          const value = this.cast(this.compileExpression(statement.value), this.returnType, statement.token);
          this.emit(`ret ${llvmType(this.returnType, { target: this.compiler.target.triple })} ${value.value}`);
        }
        this.terminated = true;
        return;
      case 'ExpressionStatement': this.compileExpression(statement.expression); return;
      case 'IfStatement': this.compileIf(statement); return;
      case 'WhileStatement': this.compileWhile(statement); return;
      default: fail(`Unsupported statement '${statement.kind}'.`, statement.token, this.compiler.context);
    }
  }

  assign(targetExpression, valueExpression, token) {
    const target = this.compileLValue(targetExpression);
    this.store(target, this.cast(this.compileExpression(valueExpression), target.type, token), token);
  }

  store(target, value, token) {
    if (!target.mutable) fail('Cannot assign to an immutable value.', token, this.compiler.context);
    this.emit(`store ${llvmType(target.type, { target: this.compiler.target.triple })} ${value.value}, ptr ${target.pointer}, align ${this.compiler.alignOf(target.type)}`);
  }

  compileIf(statement) {
    const condition = this.toBool(this.compileExpression(statement.test), statement.token);
    const thenLabel = this.label('if.then');
    const elseLabel = statement.alternate ? this.label('if.else') : null;
    const endLabel = this.label('if.end');
    this.emit(`br i1 ${condition.value}, label %${thenLabel}, label %${elseLabel ?? endLabel}`);
    this.terminated = true;
    this.emitLabel(thenLabel);
    this.compileBlock(statement.consequent);
    const thenTerminated = this.terminated;
    if (!thenTerminated) { this.emit(`br label %${endLabel}`); this.terminated = true; }
    let elseTerminated = false;
    if (statement.alternate) {
      this.emitLabel(elseLabel);
      this.compileBlock(statement.alternate);
      elseTerminated = this.terminated;
      if (!elseTerminated) { this.emit(`br label %${endLabel}`); this.terminated = true; }
    }
    if (!(thenTerminated && statement.alternate && elseTerminated)) this.emitLabel(endLabel);
  }

  compileWhile(statement) {
    const conditionLabel = this.label('while.cond');
    const bodyLabel = this.label('while.body');
    const endLabel = this.label('while.end');
    this.emit(`br label %${conditionLabel}`);
    this.terminated = true;
    this.emitLabel(conditionLabel);
    const condition = this.toBool(this.compileExpression(statement.test), statement.token);
    this.emit(`br i1 ${condition.value}, label %${bodyLabel}, label %${endLabel}`);
    this.terminated = true;
    this.emitLabel(bodyLabel);
    this.compileBlock(statement.body);
    if (!this.terminated) { this.emit(`br label %${conditionLabel}`); this.terminated = true; }
    this.emitLabel(endLabel);
  }

  compileExpression(expression) {
    switch (expression.kind) {
      case 'IntegerLiteral': return { type: parseSystemType('usize', { target: this.compiler.target.triple }), value: integerLiteral(expression.value), constant: true };
      case 'BooleanLiteral': return { type: parseSystemType('bool', { target: this.compiler.target.triple }), value: expression.value ? '1' : '0', constant: true };
      case 'Identifier': {
        const binding = this.lookup(expression.name, expression.token);
        if (binding.kind === 'function') return binding;
        if (binding.kind === 'constant') return { type: binding.type, value: binding.value.toString(), constant: true };
        return this.load(binding);
      }
      case 'UnaryExpression': return this.compileUnary(expression);
      case 'BinaryExpression': return this.compileBinary(expression.op, this.compileExpression(expression.left), this.compileExpression(expression.right), expression.token);
      case 'CallExpression': return this.compileCall(expression);
      case 'MemberExpression':
        if (this.hasAssignableRoot(expression)) return this.load(this.compileLValue(expression));
        return { kind: 'path', path: this.pathName(expression), token: expression.token };
      default: fail(`Unsupported expression '${expression.kind}'.`, expression.token, this.compiler.context);
    }
  }

  hasAssignableRoot(expression) {
    while (expression?.kind === 'MemberExpression') expression = expression.object;
    if (expression?.kind !== 'Identifier') return false;
    return this.scopes.some(scope => scope.has(expression.name)) || this.compiler.globals.has(expression.name);
  }

  compileUnary(expression) {
    if (expression.op === '&') {
      const target = this.compileLValue(expression.value);
      if (expression.mutable && !target.mutable) fail('Cannot take a mutable pointer to an immutable value.', expression.token, this.compiler.context);
      return { type: { kind: 'pointer', mutable: expression.mutable, pointee: target.type }, value: target.pointer };
    }
    if (expression.op === '*') {
      this.requireUnsafe(expression.token, 'Pointer dereference');
      const pointer = this.compileExpression(expression.value);
      if (!isPointer(pointer.type)) fail('Dereference requires a pointer.', expression.token, this.compiler.context);
      return this.load({ type: pointer.type.pointee, pointer: pointer.value, mutable: pointer.type.mutable });
    }
    const value = this.compileExpression(expression.value);
    if (expression.op === '!') {
      const boolean = this.toBool(value, expression.token);
      const result = this.temp('not');
      this.emit(`${result} = xor i1 ${boolean.value}, true`);
      return { type: boolean.type, value: result };
    }
    if (!isInteger(value.type)) fail('Unary arithmetic requires an integer.', expression.token, this.compiler.context);
    if (expression.op === '+') return value;
    const result = this.temp(expression.op === '~' ? 'bitnot' : 'neg');
    const llvm = llvmType(value.type, { target: this.compiler.target.triple });
    if (expression.op === '~') this.emit(`${result} = xor ${llvm} ${value.value}, -1`);
    else this.emit(`${result} = sub ${llvm} 0, ${value.value}`);
    return { type: value.type, value: result };
  }

  compileLValue(expression) {
    if (expression.kind === 'Identifier') {
      const binding = this.lookup(expression.name, expression.token);
      if (!['local', 'global'].includes(binding.kind)) fail('Value is not assignable.', expression.token, this.compiler.context);
      return binding;
    }
    if (expression.kind === 'UnaryExpression' && expression.op === '*') {
      this.requireUnsafe(expression.token, 'Pointer assignment');
      const pointer = this.compileExpression(expression.value);
      if (!isPointer(pointer.type)) fail('Pointer required.', expression.token, this.compiler.context);
      return { type: pointer.type.pointee, pointer: pointer.value, mutable: pointer.type.mutable };
    }
    if (expression.kind === 'MemberExpression') return this.compileMemberLValue(expression);
    fail('Value is not assignable.', expression.token, this.compiler.context);
  }

  compileMemberLValue(expression) {
    let basePointer;
    let structType;
    let mutable;
    if (expression.object.kind === 'Identifier') {
      const binding = this.lookup(expression.object.name, expression.object.token);
      if (binding.type?.kind === 'named') {
        basePointer = binding.pointer; structType = binding.type; mutable = binding.mutable;
      } else if (isPointer(binding.type) && binding.type.pointee.kind === 'named') {
        this.requireUnsafe(expression.token, 'Struct pointer member access');
        basePointer = this.load(binding).value; structType = binding.type.pointee; mutable = binding.type.mutable;
      } else fail('Member access requires a struct.', expression.token, this.compiler.context);
    } else {
      const pointer = this.compileExpression(expression.object);
      if (!isPointer(pointer.type) || pointer.type.pointee.kind !== 'named') fail('Member access requires a struct pointer.', expression.token, this.compiler.context);
      this.requireUnsafe(expression.token, 'Struct pointer member access');
      basePointer = pointer.value; structType = pointer.type.pointee; mutable = pointer.type.mutable;
    }
    const declaration = this.compiler.structs.get(structType.name);
    const index = declaration.fields.findIndex(field => field.name === expression.property);
    if (index < 0) fail(`Unknown field '${expression.property}'.`, expression.token, this.compiler.context);
    const field = declaration.fields[index];
    const fieldType = this.compiler.resolveType(field.type, field.token);
    const pointer = this.temp('field');
    this.emit(`${pointer} = getelementptr inbounds %${safeName(structType.name)}, ptr ${basePointer}, i32 0, i32 ${index}`);
    return { type: fieldType, pointer, mutable };
  }

  load(binding) {
    const result = this.temp('load');
    const llvm = llvmType(binding.type, { target: this.compiler.target.triple });
    this.emit(`${result} = load ${llvm}, ptr ${binding.pointer}, align ${this.compiler.alignOf(binding.type)}`);
    return { type: binding.type, value: result };
  }

  compileBinary(operator, left, right, token) {
    if (operator === '&&' || operator === '||') {
      left = this.toBool(left, token); right = this.toBool(right, token);
      const result = this.temp('logic');
      this.emit(`${result} = ${operator === '&&' ? 'and' : 'or'} i1 ${left.value}, ${right.value}`);
      return { type: left.type, value: result };
    }
    if (['==', '!=', '<', '>', '<=', '>='].includes(operator)) return this.compileComparison(operator, left, right, token);
    const type = this.commonIntegerType(left.type, right.type, token);
    left = this.cast(left, type, token); right = this.cast(right, type, token);
    const instruction = {
      '+': 'add', '-': 'sub', '*': 'mul',
      '/': type.signed ? 'sdiv' : 'udiv', '%': type.signed ? 'srem' : 'urem',
      '&': 'and', '|': 'or', '^': 'xor', '<<': 'shl', '>>': type.signed ? 'ashr' : 'lshr',
    }[operator];
    if (!instruction) fail(`Unsupported binary operator '${operator}'.`, token, this.compiler.context);
    const result = this.temp('bin');
    this.emit(`${result} = ${instruction} ${llvmType(type, { target: this.compiler.target.triple })} ${left.value}, ${right.value}`);
    return { type, value: result };
  }

  compileComparison(operator, left, right, token) {
    const result = this.temp('cmp');
    if (isPointer(left.type) && isPointer(right.type)) {
      const predicate = { '==': 'eq', '!=': 'ne', '<': 'ult', '>': 'ugt', '<=': 'ule', '>=': 'uge' }[operator];
      this.emit(`${result} = icmp ${predicate} ptr ${left.value}, ${right.value}`);
    } else {
      const type = this.commonIntegerType(left.type, right.type, token);
      left = this.cast(left, type, token); right = this.cast(right, type, token);
      const predicate = {
        '==': 'eq', '!=': 'ne',
        '<': type.signed ? 'slt' : 'ult', '>': type.signed ? 'sgt' : 'ugt',
        '<=': type.signed ? 'sle' : 'ule', '>=': type.signed ? 'sge' : 'uge',
      }[operator];
      this.emit(`${result} = icmp ${predicate} ${llvmType(type, { target: this.compiler.target.triple })} ${left.value}, ${right.value}`);
    }
    return { type: parseSystemType('bool', { target: this.compiler.target.triple }), value: result };
  }

  commonIntegerType(left, right, token) {
    if (!isInteger(left) || !isInteger(right)) fail('Integer operands required.', token, this.compiler.context);
    if (typeEquals(left, right)) return left;
    if (left.bits !== right.bits) return left.bits > right.bits ? left : right;
    return left.signed ? right : left;
  }

  cast(value, target, token) {
    if (typeEquals(value.type, target)) return value;
    if (isInteger(value.type) && isInteger(target)) {
      if (value.constant) return { type: target, value: value.value, constant: true };
      if (value.type.bits === target.bits) return { type: target, value: value.value };
      const result = this.temp('cast');
      const operation = value.type.bits < target.bits ? (value.type.signed ? 'sext' : 'zext') : 'trunc';
      this.emit(`${result} = ${operation} ${llvmType(value.type, { target: this.compiler.target.triple })} ${value.value} to ${llvmType(target, { target: this.compiler.target.triple })}`);
      return { type: target, value: result };
    }
    if (isInteger(value.type) && isPointer(target)) {
      this.requireUnsafe(token, 'Integer-to-pointer cast');
      const usize = parseSystemType('usize', { target: this.compiler.target.triple });
      const integer = this.cast(value, usize, token);
      const result = this.temp('ptr');
      this.emit(`${result} = inttoptr ${llvmType(usize, { target: this.compiler.target.triple })} ${integer.value} to ptr`);
      return { type: target, value: result };
    }
    fail(`Cannot convert ${formatSystemType(value.type)} to ${formatSystemType(target)}.`, token, this.compiler.context);
  }

  toBool(value, token) {
    if (value.type.kind === 'bool') return value;
    const result = this.temp('bool');
    if (isInteger(value.type)) this.emit(`${result} = icmp ne ${llvmType(value.type, { target: this.compiler.target.triple })} ${value.value}, 0`);
    else if (isPointer(value.type)) this.emit(`${result} = icmp ne ptr ${value.value}, null`);
    else fail('Invalid condition type.', token, this.compiler.context);
    return { type: parseSystemType('bool', { target: this.compiler.target.triple }), value: result };
  }

  pathName(expression) {
    if (expression.kind === 'Identifier') return expression.name;
    if (expression.kind === 'MemberExpression') return `${this.pathName(expression.object)}.${expression.property}`;
    return null;
  }

  compileCall(expression) {
    const intrinsic = compileSystemIntrinsic(this, expression);
    if (intrinsic) return intrinsic;
    if (expression.callee.kind !== 'Identifier') fail('Unsupported call target.', expression.token, this.compiler.context);
    const declaration = this.compiler.functions.get(expression.callee.name);
    if (!declaration) fail(`Unknown function '${expression.callee.name}'.`, expression.token, this.compiler.context);
    if (this.compiler.isInterrupt(declaration)) fail('Interrupt handlers cannot be called as normal functions.', expression.token, this.compiler.context, 'KR-NATIVE-ABI-0004');
    if (declaration.unsafe) this.requireUnsafe(expression.token, `Unsafe call '${declaration.name}'`);
    if (declaration.params.length !== expression.args.length) fail(`Wrong argument count for '${declaration.name}'.`, expression.token, this.compiler.context);
    const args = expression.args.map((argument, index) => {
      const type = this.compiler.resolveType(declaration.params[index].type, declaration.params[index].token);
      const value = this.cast(this.compileExpression(argument), type, argument.token);
      return `${llvmType(type, { target: this.compiler.target.triple })} ${value.value}`;
    });
    const returnType = this.compiler.resolveType(declaration.returnType, declaration.token);
    const llvm = llvmType(returnType, { target: this.compiler.target.triple });
    const target = `@${this.compiler.symbolName(declaration)}`;
    if (returnType.kind === 'void' || returnType.kind === 'never') {
      this.emit(`call ${llvm} ${target}(${args.join(', ')})`);
      if (returnType.kind === 'never') { this.emit('unreachable'); this.terminated = true; }
      return { type: returnType, value: null };
    }
    const result = this.temp('call');
    this.emit(`${result} = call ${llvm} ${target}(${args.join(', ')})`);
    return { type: returnType, value: result };
  }
}
