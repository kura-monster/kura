// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from 'node:crypto';
import { analyzeLanguage, assertLanguage, parseLanguage } from './language-core.mjs';

const PRIMITIVES = Object.freeze({
  void: { llvm: 'void', size: 0, align: 1 },
  bool: { llvm: 'i1', size: 1, align: 1 },
  i8: { llvm: 'i8', size: 1, align: 1 }, u8: { llvm: 'i8', size: 1, align: 1 },
  i16: { llvm: 'i16', size: 2, align: 2 }, u16: { llvm: 'i16', size: 2, align: 2 },
  i32: { llvm: 'i32', size: 4, align: 4 }, u32: { llvm: 'i32', size: 4, align: 4 },
  i64: { llvm: 'i64', size: 8, align: 8 }, u64: { llvm: 'i64', size: 8, align: 8 },
  isize: { llvm: 'i64', size: 8, align: 8 }, usize: { llvm: 'i64', size: 8, align: 8 },
  f32: { llvm: 'float', size: 4, align: 4 }, f64: { llvm: 'double', size: 8, align: 8 },
  String: { llvm: 'ptr', size: 8, align: 8 }, str: { llvm: 'ptr', size: 8, align: 8 },
});

function baseType(type) {
  return String(type ?? 'void').replace(/^&(?:mut)?/, '').trim().split('<')[0].trim();
}
function genericArgs(type) {
  const text = String(type ?? '');
  const open = text.indexOf('<');
  if (open < 0 || !text.endsWith('>')) return [];
  const inner = text.slice(open + 1, -1);
  const output = [];
  let current = '';
  let depth = 0;
  for (const char of inner) {
    if (char === '<') depth++;
    else if (char === '>') depth--;
    if (char === ',' && depth === 0) { output.push(current.trim()); current = ''; }
    else current += char;
  }
  if (current.trim()) output.push(current.trim());
  return output;
}
function safe(value) { return String(value).replace(/[^A-Za-z0-9_]/g, '_'); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function attribute(declaration, name) { return declaration?.attributes?.some(item => item.name === name) ?? false; }

export class NativeTypeRegistry {
  constructor(program, report) {
    this.program = program;
    this.report = report;
    this.structs = new Map(program.declarations.filter(item => item.kind === 'StructDeclaration').map(item => [item.name, item]));
    this.enums = new Map(program.declarations.filter(item => item.kind === 'EnumDeclaration').map(item => [item.name, item]));
    this.layouts = new Map();
  }
  substitute(type, bindings = {}) {
    let output = String(type ?? 'void');
    for (const [name, value] of Object.entries(bindings)) output = output.replace(new RegExp(`\\b${name}\\b`, 'g'), value);
    return output;
  }
  llvm(type, bindings = {}) {
    const resolved = this.substitute(type, bindings);
    if (resolved.startsWith('&') || resolved.startsWith('*')) return 'ptr';
    const base = baseType(resolved);
    if (PRIMITIVES[base]) return PRIMITIVES[base].llvm;
    if (this.structs.has(base)) return `%struct.${safe(base)}`;
    if (this.enums.has(base) || base === 'Result' || base === 'Option') return `%enum.${safe(base)}`;
    if (base.startsWith('fn(') || base.startsWith('Fn')) return 'ptr';
    return 'ptr';
  }
  layout(type, bindings = {}, stack = new Set()) {
    const resolved = this.substitute(type, bindings);
    if (resolved.startsWith('&') || resolved.startsWith('*')) return { size: 8, align: 8, llvm: 'ptr', kind: 'pointer' };
    const base = baseType(resolved);
    if (PRIMITIVES[base]) return { ...PRIMITIVES[base], kind: 'primitive' };
    const cacheKey = `${resolved}|${JSON.stringify(bindings)}`;
    if (this.layouts.has(cacheKey)) return this.layouts.get(cacheKey);
    if (stack.has(base)) return { size: 8, align: 8, llvm: 'ptr', kind: 'recursive' };
    const next = new Set(stack); next.add(base);
    const struct = this.structs.get(base);
    if (struct) {
      const args = genericArgs(resolved);
      const localBindings = { ...bindings };
      struct.generics.forEach((item, index) => { if (args[index]) localBindings[item.name] = args[index]; });
      let offset = 0; let align = 1;
      const fields = [];
      for (const field of struct.fields) {
        const fieldType = this.substitute(field.type, localBindings);
        const layout = this.layout(fieldType, localBindings, next);
        offset = Math.ceil(offset / layout.align) * layout.align;
        fields.push({ name: field.name, type: fieldType, offset, ...layout });
        offset += layout.size; align = Math.max(align, layout.align);
      }
      const result = { kind: 'struct', name: base, llvm: `%struct.${safe(base)}`, size: Math.ceil(offset / align) * align, align, fields, drop: this.report.typeTraits?.[base]?.includes?.('Drop') ?? false };
      this.layouts.set(cacheKey, result);
      return result;
    }
    const enumeration = this.enums.get(base);
    if (enumeration || base === 'Result' || base === 'Option') {
      const variants = enumeration?.variants ?? (base === 'Result'
        ? [{ name: 'Ok', fields: [{ type: genericArgs(resolved)[0] ?? 'i64' }] }, { name: 'Err', fields: [{ type: genericArgs(resolved)[1] ?? 'i64' }] }]
        : [{ name: 'Some', fields: [{ type: genericArgs(resolved)[0] ?? 'i64' }] }, { name: 'None', fields: [] }]);
      let payloadSize = 0; let payloadAlign = 1;
      const variantLayouts = variants.map((variant, tag) => {
        let offset = 0; let align = 1;
        const fields = variant.fields.map((field, index) => {
          const fieldType = this.substitute(field.type, bindings);
          const layout = this.layout(fieldType, bindings, next);
          offset = Math.ceil(offset / layout.align) * layout.align;
          const result = { name: field.name ?? `value${index}`, type: fieldType, offset, ...layout };
          offset += layout.size; align = Math.max(align, layout.align);
          return result;
        });
        const size = Math.ceil(offset / align) * align;
        payloadSize = Math.max(payloadSize, size); payloadAlign = Math.max(payloadAlign, align);
        return { name: variant.name, tag, fields, size, align };
      });
      const alignedPayload = Math.ceil(4 / payloadAlign) * payloadAlign;
      const totalAlign = Math.max(4, payloadAlign);
      const result = { kind: 'enum', name: base, llvm: `%enum.${safe(base)}`, tagSize: 4, payloadOffset: alignedPayload, payloadSize, size: Math.ceil((alignedPayload + payloadSize) / totalAlign) * totalAlign, align: totalAlign, variants: variantLayouts };
      this.layouts.set(cacheKey, result);
      return result;
    }
    return { kind: 'opaque', llvm: 'ptr', size: 8, align: 8 };
  }
  declarations() {
    const lines = [];
    for (const struct of this.structs.values()) {
      const types = struct.fields.map(field => this.llvm(field.type));
      lines.push(`%struct.${safe(struct.name)} = type { ${types.join(', ')} }`);
    }
    for (const enumeration of this.enums.values()) {
      const layout = this.layout(enumeration.name);
      lines.push(`%enum.${safe(enumeration.name)} = type { i32, [${Math.max(1, layout.payloadSize)} x i8] }`);
    }
    lines.push('%enum.Result = type { i32, [16 x i8] }');
    lines.push('%enum.Option = type { i32, [8 x i8] }');
    return [...new Set(lines)];
  }
  manifest() {
    const output = {};
    for (const declaration of [...this.structs.values(), ...this.enums.values()]) output[declaration.name] = this.layout(declaration.name);
    return output;
  }
}

class IRFunctionEmitter {
  constructor(backend, declaration, specialization = null) {
    this.backend = backend;
    this.declaration = declaration;
    this.specialization = specialization;
    this.bindings = {};
    declaration.generics?.forEach((generic, index) => { this.bindings[generic.name] = specialization?.typeArguments?.[index] ?? generic.name; });
    this.lines = [];
    this.entry = [];
    this.counter = 0;
    this.labelCounter = 0;
    this.scopes = [new Map()];
    this.terminated = false;
    this.cleanup = backend.report.dropPlans?.[declaration.name]?.drops ?? [];
  }
  temp(prefix = 'v') { return `%${prefix}${++this.counter}`; }
  label(prefix = 'bb') { return `${prefix}${++this.labelCounter}`; }
  emit(line) { this.lines.push(`  ${line}`); }
  alloca(type, name = 'slot') { const value = this.temp(name); this.entry.push(`  ${value} = alloca ${type}`); return value; }
  bind(name, record) { this.scopes.at(-1).set(name, record); }
  lookup(name) { for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].has(name)) return this.scopes[i].get(name); return null; }
  llvm(type) { return this.backend.types.llvm(type, this.bindings); }
  defaultValue(type) { const llvm = this.llvm(type); return llvm === 'ptr' ? 'null' : llvm === 'double' ? '0.0' : llvm === 'float' ? '0.0' : llvm.startsWith('%') ? 'zeroinitializer' : '0'; }
  coerce(value, from, to) {
    if (from === to) return value;
    const result = this.temp('cast');
    if (from.startsWith('i') && to.startsWith('i')) {
      const fromBits = Number(from.slice(1)); const toBits = Number(to.slice(1));
      this.emit(`${result} = ${fromBits < toBits ? 'sext' : 'trunc'} ${from} ${value} to ${to}`);
      return result;
    }
    if (from === 'ptr' && to.startsWith('i')) { this.emit(`${result} = ptrtoint ptr ${value} to ${to}`); return result; }
    if (from.startsWith('i') && to === 'ptr') { this.emit(`${result} = inttoptr ${from} ${value} to ptr`); return result; }
    return value;
  }
  expression(node, expected = null) {
    if (!node) return { value: '0', type: 'i32', sourceType: 'i32' };
    switch (node.kind) {
      case 'NumberLiteral': {
        const sourceType = node.value.includes('.') ? 'f64' : (expected && ['i8','i16','i32','i64','u8','u16','u32','u64','usize','isize'].includes(baseType(expected)) ? expected : 'i32');
        return { value: node.value.replaceAll('_', ''), type: this.llvm(sourceType), sourceType };
      }
      case 'BooleanLiteral': return { value: node.value ? '1' : '0', type: 'i1', sourceType: 'bool' };
      case 'StringLiteral': {
        const global = this.backend.internString(node.value);
        const value = this.temp('str');
        this.emit(`${value} = getelementptr [${Buffer.byteLength(node.value) + 1} x i8], ptr @${global}, i64 0, i64 0`);
        return { value, type: 'ptr', sourceType: 'String' };
      }
      case 'Identifier': {
        const local = this.lookup(node.name);
        if (local) {
          if (local.direct) return { value: local.value, type: local.type, sourceType: local.sourceType };
          const value = this.temp(node.name);
          this.emit(`${value} = load ${local.type}, ptr ${local.ptr}`);
          return { value, type: local.type, sourceType: local.sourceType };
        }
        return { value: `@${safe(node.name)}`, type: 'ptr', sourceType: 'fn' };
      }
      case 'UnaryExpression': {
        const item = this.expression(node.value, expected);
        if (node.op === '-') { const out = this.temp('neg'); this.emit(`${out} = sub ${item.type} 0, ${item.value}`); return { ...item, value: out }; }
        if (node.op === '!') { const out = this.temp('not'); this.emit(`${out} = xor i1 ${item.value}, true`); return { value: out, type: 'i1', sourceType: 'bool' }; }
        return item;
      }
      case 'BinaryExpression': {
        const left = this.expression(node.left, expected);
        const right = this.expression(node.right, left.sourceType);
        const rightValue = this.coerce(right.value, right.type, left.type);
        const out = this.temp('op');
        const arithmetic = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'sdiv', '%': 'srem', '&': 'and', '|': 'or' };
        const comparison = { '==': 'eq', '!=': 'ne', '<': 'slt', '<=': 'sle', '>': 'sgt', '>=': 'sge' };
        if (arithmetic[node.op]) { this.emit(`${out} = ${arithmetic[node.op]} ${left.type} ${left.value}, ${rightValue}`); return { value: out, type: left.type, sourceType: left.sourceType }; }
        if (comparison[node.op]) { this.emit(`${out} = icmp ${comparison[node.op]} ${left.type} ${left.value}, ${rightValue}`); return { value: out, type: 'i1', sourceType: 'bool' }; }
        if (node.op === '&&' || node.op === '||') { this.emit(`${out} = ${node.op === '&&' ? 'and' : 'or'} i1 ${left.value}, ${rightValue}`); return { value: out, type: 'i1', sourceType: 'bool' }; }
        throw new Error(`Native lowering does not support binary operator ${node.op}.`);
      }
      case 'MemberExpression': return this.member(node);
      case 'MoveExpression': return this.expression(node.value, expected);
      case 'BorrowExpression': {
        const path = this.address(node.value);
        return { value: path.ptr, type: 'ptr', sourceType: `&${path.sourceType}` };
      }
      case 'CallExpression': return this.call(node, expected);
      case 'TryExpression': return this.tryExpression(node, expected);
      case 'MatchExpression': return this.matchExpression(node, expected);
      case 'ClosureExpression': return this.closureExpression(node);
      case 'AwaitExpression': return this.backend.asyncLowering.emitAwait(this, node, expected);
      default: throw new Error(`Native lowering does not support expression ${node.kind}.`);
    }
  }
  address(node) {
    if (node.kind === 'Identifier') {
      const local = this.lookup(node.name);
      if (!local) throw new Error(`Unknown native local '${node.name}'.`);
      if (local.direct) {
        const slot = this.alloca(local.type, `${safe(node.name)}_addr`);
        this.emit(`store ${local.type} ${local.value}, ptr ${slot}`);
        local.ptr = slot; local.direct = false;
      }
      return { ptr: local.ptr, type: local.type, sourceType: local.sourceType };
    }
    if (node.kind === 'MemberExpression') {
      const object = this.address(node.object);
      const layout = this.backend.types.layout(object.sourceType, this.bindings);
      const index = layout.fields?.findIndex(item => item.name === node.property) ?? -1;
      if (index < 0) throw new Error(`Unknown field '${node.property}' on ${object.sourceType}.`);
      const field = layout.fields[index];
      const ptr = this.temp('fieldptr');
      this.emit(`${ptr} = getelementptr ${layout.llvm}, ptr ${object.ptr}, i32 0, i32 ${index}`);
      return { ptr, type: this.llvm(field.type), sourceType: field.type };
    }
    throw new Error(`Expression ${node.kind} is not addressable.`);
  }
  member(node) {
    const address = this.address(node);
    const value = this.temp('field');
    this.emit(`${value} = load ${address.type}, ptr ${address.ptr}`);
    return { value, type: address.type, sourceType: address.sourceType };
  }
  call(node, expected) {
    const path = (() => {
      const visit = value => value.kind === 'Identifier' ? value.name : value.kind === 'MemberExpression' ? `${visit(value.object)}.${value.property}` : null;
      return visit(node.callee);
    })();
    if (path && path.includes('.')) {
      const [owner, method] = path.split('.');
      const local = this.lookup(owner);
      if (local) {
        const impl = this.backend.methodFor(local.sourceType, method);
        if (impl) {
          const self = this.expression({ kind: 'Identifier', name: owner });
          const args = [self, ...node.args.map((arg, index) => this.expression(arg, impl.params[index + 1]?.type))];
          const returnType = this.llvm(impl.returnType);
          const result = returnType === 'void' ? null : this.temp('call');
          this.emit(`${result ? `${result} = ` : ''}call ${returnType} @${safe(this.backend.implSymbol(impl.impl, impl.method))}(${args.map(item => `${item.type} ${item.value}`).join(', ')})`);
          return { value: result ?? '0', type: returnType, sourceType: impl.returnType };
        }
      }
    }
    const name = path?.replaceAll('.', '_') ?? 'indirect';
    const declaration = this.backend.functions.get(path ?? '');
    const enumOwner = path?.split('.')[0];
    const enumVariant = path?.split('.')[1];
    if (enumVariant && (this.backend.types.enums.has(enumOwner) || enumOwner === 'Result' || enumOwner === 'Option')) return this.enumConstructor(enumOwner, enumVariant, node.args, expected);
    if (this.backend.types.structs.has(path ?? '')) return this.structConstructor(path, node.args);
    const typeBindings = {};
    declaration?.generics?.forEach((item, index) => { if (node.typeArguments[index]) typeBindings[item.name] = node.typeArguments[index]; });
    const args = node.args.map((arg, index) => this.expression(arg, declaration ? this.backend.types.substitute(declaration.params[index]?.type, typeBindings) : null));
    const returnSource = declaration ? this.backend.types.substitute(declaration.returnType, typeBindings) : (expected ?? 'i32');
    const returnType = this.llvm(returnSource);
    const symbol = declaration?.generics?.length ? this.backend.specializedSymbol(declaration.name, node.typeArguments) : safe(name);
    const result = returnType === 'void' ? null : this.temp('call');
    this.emit(`${result ? `${result} = ` : ''}call ${returnType} @${symbol}(${args.map(item => `${item.type} ${item.value}`).join(', ')})`);
    return { value: result ?? '0', type: returnType, sourceType: returnSource };
  }
  structConstructor(name, args) {
    const layout = this.backend.types.layout(name, this.bindings);
    const ptr = this.alloca(layout.llvm, `${safe(name)}_tmp`);
    args.forEach((arg, index) => {
      const field = layout.fields[index];
      const value = this.expression(arg, field?.type);
      const fieldPtr = this.temp('ctorfield');
      this.emit(`${fieldPtr} = getelementptr ${layout.llvm}, ptr ${ptr}, i32 0, i32 ${index}`);
      this.emit(`store ${value.type} ${value.value}, ptr ${fieldPtr}`);
    });
    const value = this.temp('struct');
    this.emit(`${value} = load ${layout.llvm}, ptr ${ptr}`);
    return { value, type: layout.llvm, sourceType: name };
  }
  enumConstructor(owner, variantName, args, expected) {
    const sourceType = expected && baseType(expected) === owner ? expected : owner;
    const layout = this.backend.types.layout(sourceType, this.bindings);
    const variant = layout.variants.find(item => item.name === variantName);
    if (!variant) throw new Error(`Unknown enum variant ${owner}::${variantName}.`);
    const ptr = this.alloca(layout.llvm, `${safe(owner)}_${safe(variantName)}`);
    const tagPtr = this.temp('tagptr');
    this.emit(`${tagPtr} = getelementptr ${layout.llvm}, ptr ${ptr}, i32 0, i32 0`);
    this.emit(`store i32 ${variant.tag}, ptr ${tagPtr}`);
    if (args.length) {
      const payload = this.temp('payload');
      this.emit(`${payload} = getelementptr ${layout.llvm}, ptr ${ptr}, i32 0, i32 1`);
      args.forEach((arg, index) => {
        const field = variant.fields[index];
        const item = this.expression(arg, field?.type);
        const cast = this.temp('payloadcast');
        this.emit(`${cast} = getelementptr i8, ptr ${payload}, i64 ${field?.offset ?? index * 8}`);
        this.emit(`store ${item.type} ${item.value}, ptr ${cast}`);
      });
    }
    const value = this.temp('enum');
    this.emit(`${value} = load ${layout.llvm}, ptr ${ptr}`);
    return { value, type: layout.llvm, sourceType };
  }
  tryExpression(node, expected) {
    const item = this.expression(node.value, expected);
    const slot = this.alloca(item.type, 'tryval');
    this.emit(`store ${item.type} ${item.value}, ptr ${slot}`);
    const tagPtr = this.temp('trytagptr');
    this.emit(`${tagPtr} = getelementptr ${item.type}, ptr ${slot}, i32 0, i32 0`);
    const tag = this.temp('trytag');
    this.emit(`${tag} = load i32, ptr ${tagPtr}`);
    const ok = this.label('try_ok'); const err = this.label('try_err');
    this.emit(`%try_is_err${this.counter} = icmp eq i32 ${tag}, 1`);
    const cond = `%try_is_err${this.counter}`;
    this.emit(`br i1 ${cond}, label %${err}, label %${ok}`);
    this.lines.push(`${err}:`);
    this.emitCleanups();
    const returnType = this.llvm(this.declaration.returnType);
    this.emit(`ret ${returnType} ${item.value}`);
    this.lines.push(`${ok}:`);
    const payload = this.temp('trypayload');
    this.emit(`${payload} = getelementptr ${item.type}, ptr ${slot}, i32 0, i32 1`);
    const resultType = genericArgs(item.sourceType)[0] ?? expected ?? 'i64';
    const llvm = this.llvm(resultType);
    const value = this.temp('tryvalue');
    this.emit(`${value} = load ${llvm}, ptr ${payload}`);
    return { value, type: llvm, sourceType: resultType };
  }
  matchExpression(node, expected) {
    const item = this.expression(node.value);
    const slot = this.alloca(item.type, 'match');
    this.emit(`store ${item.type} ${item.value}, ptr ${slot}`);
    const tagPtr = this.temp('matchtagptr'); this.emit(`${tagPtr} = getelementptr ${item.type}, ptr ${slot}, i32 0, i32 0`);
    const tag = this.temp('matchtag'); this.emit(`${tag} = load i32, ptr ${tagPtr}`);
    const merge = this.label('match_merge');
    const resultType = this.llvm(expected ?? 'i32');
    const incoming = [];
    const enumLayout = this.backend.types.layout(item.sourceType, this.bindings);
    const defaultLabel = this.label('match_default');
    const cases = [];
    const armLabels = node.arms.map((arm, index) => {
      const label = this.label(`match_arm${index}`);
      if (arm.pattern.kind === 'VariantPattern') {
        const variant = enumLayout.variants.find(item => item.name === arm.pattern.path.at(-1));
        if (variant) cases.push(`i32 ${variant.tag}, label %${label}`);
      }
      return label;
    });
    this.emit(`switch i32 ${tag}, label %${defaultLabel} [ ${cases.join(' ')} ]`);
    node.arms.forEach((arm, index) => {
      this.lines.push(`${armLabels[index]}:`);
      this.scopes.push(new Map());
      if (arm.pattern.kind === 'VariantPattern') {
        const variant = enumLayout.variants.find(item => item.name === arm.pattern.path.at(-1));
        const payload = this.temp('armpayload'); this.emit(`${payload} = getelementptr ${item.type}, ptr ${slot}, i32 0, i32 1`);
        arm.pattern.bindings.forEach((binding, fieldIndex) => {
          if (!binding) return;
          const field = variant.fields[fieldIndex];
          const fieldPtr = this.temp('armfield'); this.emit(`${fieldPtr} = getelementptr i8, ptr ${payload}, i64 ${field.offset}`);
          this.bind(binding, { ptr: fieldPtr, type: this.llvm(field.type), sourceType: field.type });
        });
      }
      const value = arm.body.kind === 'Block' ? this.blockExpression(arm.body, expected) : this.expression(arm.body, expected);
      incoming.push(`[ ${this.coerce(value.value, value.type, resultType)}, %${armLabels[index]} ]`);
      this.emit(`br label %${merge}`);
      this.scopes.pop();
    });
    this.lines.push(`${defaultLabel}:`);
    this.emit(`call void @llvm.trap()`);
    this.emit('unreachable');
    this.lines.push(`${merge}:`);
    const result = this.temp('matchresult');
    this.emit(`${result} = phi ${resultType} ${incoming.join(', ')}`);
    return { value: result, type: resultType, sourceType: expected ?? 'i32' };
  }
  blockExpression(block, expected) {
    this.scopes.push(new Map());
    const body = block.body ?? [];
    for (const statement of body.slice(0, -1)) this.statement(statement);
    const last = body.at(-1);
    const result = last?.kind === 'ExpressionStatement' ? this.expression(last.expression, expected) : { value: this.defaultValue(expected), type: this.llvm(expected), sourceType: expected };
    this.scopes.pop();
    return result;
  }
  closureExpression(node) {
    const closure = this.backend.closureFor(this.declaration.name, node);
    const envType = `%closure.env.${closure.id}`;
    const ptr = this.alloca(envType, `closure_${closure.id}`);
    closure.captures.forEach((name, index) => {
      const local = this.lookup(name);
      if (!local) return;
      const value = this.expression({ kind: 'Identifier', name });
      const field = this.temp('capture');
      this.emit(`${field} = getelementptr ${envType}, ptr ${ptr}, i32 0, i32 ${index + 1}`);
      this.emit(`store ${value.type} ${value.value}, ptr ${field}`);
    });
    const fnField = this.temp('closurefn'); this.emit(`${fnField} = getelementptr ${envType}, ptr ${ptr}, i32 0, i32 0`);
    this.emit(`store ptr @${closure.symbol}, ptr ${fnField}`);
    return { value: ptr, type: 'ptr', sourceType: `Fn${node.params.length}` };
  }
  emitCleanups() {
    for (const item of [...this.cleanup].reverse()) {
      const local = this.lookup(item.name);
      if (!local) continue;
      const destructor = this.backend.dropSymbol(local.sourceType);
      if (destructor) this.emit(`call void @${destructor}(ptr ${local.ptr})`);
    }
  }
  statement(node) {
    if (this.terminated) return;
    switch (node.kind) {
      case 'VariableDeclaration': {
        const sourceType = node.type ?? this.backend.inferExpressionType(node.init, this.declaration, this.bindings);
        const type = this.llvm(sourceType);
        const ptr = this.alloca(type, safe(node.name));
        const value = this.expression(node.init, sourceType);
        this.emit(`store ${type} ${this.coerce(value.value, value.type, type)}, ptr ${ptr}`);
        this.bind(node.name, { ptr, type, sourceType });
        break;
      }
      case 'ExpressionStatement': this.expression(node.expression); break;
      case 'DeferStatement': this.backend.recordDeferred(this.declaration.name, node); break;
      case 'IfStatement': {
        const condition = this.expression(node.test, 'bool');
        const yes = this.label('if_yes'); const no = this.label('if_no'); const merge = this.label('if_merge');
        this.emit(`br i1 ${condition.value}, label %${yes}, label %${no}`);
        this.lines.push(`${yes}:`); this.scopes.push(new Map()); node.consequent.body.forEach(item => this.statement(item)); this.scopes.pop(); if (!this.terminated) this.emit(`br label %${merge}`); this.terminated = false;
        this.lines.push(`${no}:`); if (node.alternate) { this.scopes.push(new Map()); node.alternate.body.forEach(item => this.statement(item)); this.scopes.pop(); } if (!this.terminated) this.emit(`br label %${merge}`); this.terminated = false;
        this.lines.push(`${merge}:`);
        break;
      }
      case 'ReturnStatement': {
        const returnType = this.llvm(this.declaration.returnType);
        const value = node.value ? this.expression(node.value, this.declaration.returnType) : null;
        this.emitCleanups();
        this.emit(`ret ${returnType}${value ? ` ${this.coerce(value.value, value.type, returnType)}` : ''}`);
        this.terminated = true;
        break;
      }
      default: throw new Error(`Native lowering does not support statement ${node.kind}.`);
    }
  }
  build() {
    const name = this.specialization ? this.backend.specializedSymbol(this.declaration.name, this.specialization.typeArguments) : safe(this.declaration.name);
    const params = this.declaration.params.map((param, index) => {
      const sourceType = this.backend.types.substitute(param.type ?? 'i64', this.bindings);
      return { name: param.name, sourceType, type: this.llvm(sourceType), value: `%arg${index}` };
    });
    params.forEach(param => this.bind(param.name, { direct: true, value: param.value, type: param.type, sourceType: param.sourceType }));
    for (const statement of this.declaration.body?.body ?? []) this.statement(statement);
    if (!this.terminated) {
      this.emitCleanups();
      const returnType = this.llvm(this.declaration.returnType);
      this.emit(`ret ${returnType}${returnType === 'void' ? '' : ` ${this.defaultValue(this.declaration.returnType)}`}`);
    }
    return `define ${this.llvm(this.declaration.returnType)} @${name}(${params.map(param => `${param.type} ${param.value}`).join(', ')}) {\nentry:\n${this.entry.join('\n')}${this.entry.length ? '\n' : ''}${this.lines.join('\n')}\n}`;
  }
}

class AsyncNativeLowering {
  constructor(backend) { this.backend = backend; this.awaitSites = []; }
  emitAwait(emitter, node, expected) {
    const future = emitter.expression(node.value);
    const state = this.awaitSites.length;
    this.awaitSites.push({ function: emitter.declaration.name, state, sourceType: expected ?? future.sourceType });
    const resultType = emitter.llvm(expected ?? future.sourceType);
    const result = emitter.temp('await');
    emitter.emit(`${result} = call ${resultType} @__kura_await_poll(ptr ${future.value}, i32 ${state})`);
    return { value: result, type: resultType, sourceType: expected ?? future.sourceType };
  }
}

export class LanguageNativeBackend {
  constructor(program, report, options = {}) {
    this.program = program;
    this.report = report;
    this.options = options;
    this.types = new NativeTypeRegistry(program, report);
    this.functions = new Map(program.declarations.filter(item => item.kind === 'FunctionDeclaration').map(item => [item.name, item]));
    this.impls = program.declarations.filter(item => item.kind === 'ImplDeclaration');
    this.strings = new Map();
    this.closureManifest = [];
    this.deferred = new Map();
    this.asyncLowering = new AsyncNativeLowering(this);
  }
  internString(value) { if (!this.strings.has(value)) this.strings.set(value, `.str.${this.strings.size}`); return this.strings.get(value); }
  specializedSymbol(name, args = []) { return `${safe(name)}__${args.map(safe).join('__') || 'generic'}`; }
  implSymbol(impl, method) { return `impl_${safe(baseType(impl.target))}_${safe(method.name)}`; }
  dropSymbol(type) {
    const impl = this.impls.find(item => baseType(item.target) === baseType(type) && baseType(item.trait) === 'Drop');
    const method = impl?.methods.find(item => item.name === 'drop');
    return impl && method ? this.implSymbol(impl, method) : null;
  }
  methodFor(type, name) {
    for (const impl of this.impls) {
      if (baseType(impl.target) !== baseType(type)) continue;
      const method = impl.methods.find(item => item.name === name);
      if (method) return { impl, method, params: method.params, returnType: method.returnType };
    }
    return null;
  }
  closureFor(functionName, node) {
    let closure = this.closureManifest.find(item => item.function === functionName && item.line === node.token?.line && item.column === node.token?.column);
    if (closure) return closure;
    const reportItem = this.report.closures.find(item => item.function === functionName && item.line === node.token?.line) ?? this.report.closures.find(item => item.function === functionName);
    const id = this.closureManifest.length;
    closure = { id, function: functionName, line: node.token?.line, column: node.token?.column, captures: reportItem?.captures ?? [], params: node.params.map(item => item.type ?? 'i64'), returnType: node.returnType ?? 'i64', symbol: `closure_${safe(functionName)}_${id}` };
    this.closureManifest.push(closure);
    return closure;
  }
  recordDeferred(functionName, node) { const items = this.deferred.get(functionName) ?? []; items.push(node); this.deferred.set(functionName, items); }
  inferExpressionType(node, declaration, bindings = {}) {
    if (!node) return 'void';
    if (node.kind === 'NumberLiteral') return node.value.includes('.') ? 'f64' : 'i32';
    if (node.kind === 'BooleanLiteral') return 'bool';
    if (node.kind === 'StringLiteral') return 'String';
    if (node.kind === 'CallExpression') {
      const path = (() => { const visit = value => value.kind === 'Identifier' ? value.name : value.kind === 'MemberExpression' ? `${visit(value.object)}.${value.property}` : ''; return visit(node.callee); })();
      if (this.types.structs.has(path)) return path;
      const fn = this.functions.get(path);
      if (fn) {
        const local = {};
        fn.generics.forEach((item, index) => { if (node.typeArguments[index]) local[item.name] = node.typeArguments[index]; });
        return this.types.substitute(fn.returnType, { ...bindings, ...local });
      }
      const [owner] = path.split('.'); if (this.types.enums.has(owner) || owner === 'Result' || owner === 'Option') return owner;
    }
    if (node.kind === 'TryExpression') return genericArgs(this.inferExpressionType(node.value, declaration, bindings))[0] ?? 'i64';
    if (node.kind === 'MoveExpression' || node.kind === 'BorrowExpression' || node.kind === 'AwaitExpression') return this.inferExpressionType(node.value, declaration, bindings);
    return 'i64';
  }
  traitVTables() {
    const output = [];
    for (const impl of this.impls) {
      if (!impl.trait || baseType(impl.trait) === 'Drop') continue;
      const methods = impl.methods.map(method => ({ name: method.name, symbol: this.implSymbol(impl, method), signature: `${method.params.map(item => item.type).join(',')}->${method.returnType}` }));
      output.push({ trait: baseType(impl.trait), target: baseType(impl.target), symbol: `vtable_${safe(baseType(impl.trait))}_${safe(baseType(impl.target))}`, methods });
    }
    return output;
  }
  emitClosures() {
    const definitions = [];
    for (const closure of this.closureManifest) {
      const captureTypes = closure.captures.map(() => 'i64');
      definitions.push(`%closure.env.${closure.id} = type { ptr${captureTypes.length ? `, ${captureTypes.join(', ')}` : ''} }`);
      const params = ['ptr %env', ...closure.params.map((type, index) => `${this.types.llvm(type)} %arg${index}`)];
      const returnType = this.types.llvm(closure.returnType);
      definitions.push(`define ${returnType} @${closure.symbol}(${params.join(', ')}) {\nentry:\n  ret ${returnType}${returnType === 'void' ? '' : ` ${returnType === 'ptr' ? 'null' : '0'}`}\n}`);
    }
    return definitions;
  }
  emitImpls() {
    const output = [];
    for (const impl of this.impls) for (const method of impl.methods) {
      const declaration = { ...method, name: this.implSymbol(impl, method), generics: method.generics ?? [], body: method.body, returnType: method.returnType, params: method.params };
      output.push(new IRFunctionEmitter(this, declaration).build().replace(`@${safe(declaration.name)}`, `@${this.implSymbol(impl, method)}`));
    }
    return output;
  }
  emitVTables() {
    return this.traitVTables().map(vtable => `@${vtable.symbol} = constant [${vtable.methods.length} x ptr] [${vtable.methods.map(item => `ptr @${item.symbol}`).join(', ')}]`);
  }
  compile() {
    const functions = [];
    for (const declaration of this.functions.values()) if (!declaration.generics.length) functions.push(new IRFunctionEmitter(this, declaration).build());
    for (const specialization of this.report.specializations ?? []) {
      const declaration = this.functions.get(specialization.function);
      if (declaration) functions.push(new IRFunctionEmitter(this, declaration, specialization).build());
    }
    const impls = this.emitImpls();
    const closures = this.emitClosures();
    const globals = [...this.strings.entries()].map(([value, name]) => `@${name} = private unnamed_addr constant [${Buffer.byteLength(value) + 1} x i8] c"${Buffer.from(value + '\0').toString('hex').match(/../g).map(byte => `\\${byte.toUpperCase()}`).join('')}"`);
    const vtables = this.emitVTables();
    const ir = [
      '; Kura high-level native LLVM backend',
      `source_filename = ${JSON.stringify(this.options.file ?? this.program.file ?? '<input>')}`,
      'target triple = "x86_64-unknown-linux-gnu"',
      '',
      ...this.types.declarations(),
      ...closures.filter(item => item.startsWith('%closure')),
      '',
      ...globals,
      ...vtables,
      '',
      'declare void @llvm.trap()',
      'declare i64 @__kura_await_poll(ptr, i32)',
      '',
      ...impls,
      ...functions,
      ...closures.filter(item => item.startsWith('define ')),
      '',
    ].join('\n');
    const manifest = {
      target: 'x86_64-unknown-linux-gnu',
      types: this.types.manifest(),
      specializations: this.report.specializations ?? [],
      traitVTables: this.traitVTables(),
      closures: this.closureManifest,
      asyncAwaitSites: this.asyncLowering.awaitSites,
      destructors: this.impls.filter(item => baseType(item.trait) === 'Drop').map(item => ({ target: baseType(item.target), symbol: this.dropSymbol(item.target) })),
      hash: hash(ir),
    };
    return { ir, manifest, program: this.program, report: this.report };
  }
}

export function compileLanguageNative(sourceOrProgram, options = {}) {
  const program = typeof sourceOrProgram === 'string' ? parseLanguage(sourceOrProgram, options) : sourceOrProgram;
  const report = analyzeLanguage(program, options);
  assertLanguage(report);
  return new LanguageNativeBackend(program, report, options).compile();
}
