// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  alignOfSystemType,
  formatSystemType,
  llvmType,
  parseSystemType,
  resolveSystemTarget,
  sizeOfSystemType,
} from './system.mjs';
import { attribute, fail, hasAttribute, safeName } from './system-native-common.mjs';
import { NativeConstantEvaluator } from './system-native-const.mjs';
import { FunctionEmitter } from './system-native-emitter.mjs';
import { parseNativeSystemSource } from './system-native-parser.mjs';

function escapeLlvm(value) {
  return String(value).replaceAll('\\', '\\5C').replaceAll('"', '\\22');
}

function powerOfTwo(value) {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export class NativeCompiler {
  constructor(program, options = {}) {
    this.program = program;
    this.context = { file: program.file };
    const targetDirective = program.directives.find(item => item.name === 'target');
    this.target = resolveSystemTarget(options.target ?? targetDirective?.args[0] ?? 'x86_64-unknown-none');
    this.structs = new Map();
    this.constants = new Map();
    this.globals = new Map();
    this.functions = new Map();
    this.constantEvaluator = new NativeConstantEvaluator(this);
  }

  directive(name) { return this.program.directives.find(item => item.name === name) ?? null; }

  resolveType(source, token) {
    const type = parseSystemType(source, { target: this.target.triple });
    if (type.kind === 'named' && !this.structs.has(type.name)) {
      fail(`Unknown type '${type.name}'.`, token, this.context, 'KR-NATIVE-TYPE-0026');
    }
    return type;
  }

  layoutOf(type, seen = new Set()) {
    if (type.kind !== 'named') {
      return {
        size: sizeOfSystemType(type, { target: this.target.triple }),
        alignment: alignOfSystemType(type, { target: this.target.triple }),
      };
    }
    if (seen.has(type.name)) fail(`Recursive by-value struct '${type.name}'.`, this.structs.get(type.name)?.token, this.context);
    const declaration = this.structs.get(type.name);
    const packed = attribute(declaration, 'repr')?.args[0] === 'packed';
    const nextSeen = new Set(seen);
    nextSeen.add(type.name);
    const fields = [];
    let offset = 0;
    let alignment = 1;
    for (const field of declaration.fields) {
      const fieldType = this.resolveType(field.type, field.token);
      const layout = this.layoutOf(fieldType, nextSeen);
      const fieldAlignment = packed ? 1 : layout.alignment;
      if (offset % fieldAlignment) offset += fieldAlignment - (offset % fieldAlignment);
      fields.push({ name: field.name, type: fieldType, offset, size: layout.size, alignment: fieldAlignment });
      offset += layout.size;
      alignment = Math.max(alignment, fieldAlignment);
    }
    if (!packed && offset % alignment) offset += alignment - (offset % alignment);
    return { size: offset, alignment, packed, fields };
  }

  alignOf(type) { return this.layoutOf(type).alignment; }

  symbolName(declaration) {
    return safeName(attribute(declaration, 'link_name')?.args[0] ?? declaration.name);
  }

  isInterrupt(declaration) { return hasAttribute(declaration, 'interrupt'); }

  functionCallingConvention(declaration) {
    return this.isInterrupt(declaration) ? 'x86_intrcc ' : '';
  }

  functionLinkage(declaration) {
    return declaration.public || hasAttribute(declaration, 'entry') || this.isInterrupt(declaration) ? '' : 'internal ';
  }

  functionDefinitionAttributes(declaration) {
    const output = [];
    const section = attribute(declaration, 'section')?.args[0];
    if (section) output.push(` section "${escapeLlvm(section)}"`);
    const alignment = Number(attribute(declaration, 'align')?.args[0] ?? 0);
    if (alignment) output.push(` align ${alignment}`);
    return output.join('');
  }

  validateAttributeNumber(declaration, name) {
    const item = attribute(declaration, name);
    if (!item) return null;
    const value = Number(item.args[0]);
    if (!powerOfTwo(value) || value > 1 << 20) {
      fail(`@${name} requires a power-of-two value up to 1048576.`, item.token, this.context, 'KR-NATIVE-ATTR-0001');
    }
    return value;
  }

  registerDeclarations() {
    for (const declaration of this.program.declarations) {
      const maps = {
        StructDeclaration: this.structs,
        ConstantDeclaration: this.constants,
        StaticDeclaration: this.globals,
        FunctionDeclaration: this.functions,
      };
      const selected = maps[declaration.kind];
      if (!selected) fail(`Unsupported declaration '${declaration.kind}'.`, declaration.token, this.context);
      if ([this.structs, this.constants, this.globals, this.functions].some(map => map.has(declaration.name))) {
        fail(`Duplicate declaration '${declaration.name}'.`, declaration.token, this.context);
      }
      selected.set(declaration.name, declaration);
    }
  }

  validate() {
    if (!this.directive('no_std')) {
      fail('Native compilation requires #![no_std].', this.program.declarations[0]?.token ?? {}, this.context, 'KR-NATIVE-SAFE-0002');
    }
    this.registerDeclarations();

    const entries = [...this.functions.values()].filter(fn => hasAttribute(fn, 'entry'));
    if (entries.length > 1) fail('Only one @entry is allowed.', entries[1].token, this.context);
    if (entries[0] && entries[0].params.length) fail('@entry cannot have parameters.', entries[0].token, this.context);

    for (const struct of this.structs.values()) {
      const repr = attribute(struct, 'repr');
      if (repr && !['C', 'packed'].includes(repr.args[0])) fail(`Unsupported repr '${repr.args[0]}'.`, repr.token, this.context);
      for (const field of struct.fields) this.resolveType(field.type, field.token);
      this.layoutOf({ kind: 'named', name: struct.name });
    }

    for (const declaration of this.constants.values()) {
      this.resolveType(declaration.type, declaration.token);
      this.constantEvaluator.evaluateDeclaration(declaration);
      this.validateAttributeNumber(declaration, 'align');
    }

    for (const declaration of this.globals.values()) {
      const type = this.resolveType(declaration.type, declaration.token);
      if (!['integer', 'bool', 'pointer'].includes(type.kind)) {
        fail('Static initializers currently support integer, bool, and pointer types.', declaration.token, this.context, 'KR-NATIVE-GLOBAL-0001');
      }
      this.constantEvaluator.evaluate({
        ...declaration.init,
      });
      this.validateAttributeNumber(declaration, 'align');
    }

    for (const fn of this.functions.values()) {
      if (fn.abi && !['C', 'x86-interrupt'].includes(fn.abi)) fail(`Unsupported ABI '${fn.abi}'.`, fn.token, this.context, 'KR-NATIVE-ABI-0001');
      for (const parameter of fn.params) this.resolveType(parameter.type, parameter.token);
      const returnType = this.resolveType(fn.returnType, fn.token);
      this.validateAttributeNumber(fn, 'align');
      if (fn.external && !fn.abi) fail('A declaration without a body must be extern.', fn.token, this.context, 'KR-NATIVE-ABI-0002');
      if (fn.abi === 'x86-interrupt' && !hasAttribute(fn, 'interrupt')) fn.attributes.push({ name: 'interrupt', args: [], token: fn.token });
      if (this.isInterrupt(fn)) {
        if (returnType.kind !== 'void') fail('@interrupt functions must return void.', fn.token, this.context, 'KR-NATIVE-ABI-0003');
        if (fn.params.length > 2) fail('@interrupt accepts at most frame and error-code parameters.', fn.token, this.context, 'KR-NATIVE-ABI-0003');
      }
    }
  }

  emitStruct(struct) {
    const fields = struct.fields.map(field => llvmType(this.resolveType(field.type, field.token), { target: this.target.triple }));
    const packed = attribute(struct, 'repr')?.args[0] === 'packed';
    return `%${safeName(struct.name)} = type ${packed ? '<{' : '{'} ${fields.join(', ')} ${packed ? '}>' : '}'}`;
  }

  constantInitializer(declaration) {
    const type = this.resolveType(declaration.type, declaration.token);
    const value = this.constantEvaluator.evaluateDeclaration(declaration).value;
    return { type, value: value.toString() };
  }

  staticInitializer(declaration) {
    const type = this.resolveType(declaration.type, declaration.token);
    let value = this.constantEvaluator.evaluate(declaration.init);
    if (type.kind === 'pointer') {
      if (value !== 0n) fail('Pointer statics currently require a zero/null initializer.', declaration.token, this.context, 'KR-NATIVE-GLOBAL-0002');
      return { type, value: 'null' };
    }
    value = this.constantEvaluator.normalize(value, type, declaration.token);
    return { type, value: value.toString() };
  }

  globalSuffix(declaration, type) {
    const parts = [];
    const section = attribute(declaration, 'section')?.args[0];
    if (section) parts.push(`section "${escapeLlvm(section)}"`);
    const alignment = Number(attribute(declaration, 'align')?.args[0] ?? this.alignOf(type));
    parts.push(`align ${alignment}`);
    return parts.length ? `, ${parts.join(', ')}` : '';
  }

  emitConstant(declaration) {
    const { type, value } = this.constantInitializer(declaration);
    const linkage = declaration.public ? '' : 'internal ';
    return `@${this.symbolName(declaration)} = ${linkage}constant ${llvmType(type, { target: this.target.triple })} ${value}${this.globalSuffix(declaration, type)}`;
  }

  emitStatic(declaration) {
    const { type, value } = this.staticInitializer(declaration);
    const linkage = declaration.public ? '' : 'internal ';
    return `@${this.symbolName(declaration)} = ${linkage}${declaration.mutable ? 'global' : 'constant'} ${llvmType(type, { target: this.target.triple })} ${value}${this.globalSuffix(declaration, type)}`;
  }

  emitExtern(fn) {
    const params = fn.params.map(parameter => llvmType(this.resolveType(parameter.type, parameter.token), { target: this.target.triple })).join(', ');
    const returnType = this.resolveType(fn.returnType, fn.token);
    const convention = this.functionCallingConvention(fn);
    return `declare ${convention}${llvmType(returnType, { target: this.target.triple })} @${this.symbolName(fn)}(${params})`;
  }

  emitMultiboot2Header() {
    if (!this.directive('multiboot2')) return null;
    const magic = 0xe85250d6n;
    const architecture = 0n;
    const length = 24n;
    const checksum = (-(magic + architecture + length)) & 0xffffffffn;
    return `@__kura_multiboot2_header = private constant <{ i32, i32, i32, i32, i16, i16, i32 }> <{ i32 ${magic}, i32 ${architecture}, i32 ${length}, i32 ${checksum}, i16 0, i16 0, i32 8 }>, section ".multiboot2", align 8`;
  }

  compile() {
    this.validate();
    const output = [
      `; ModuleID = '${escapeLlvm(this.program.file)}'`,
      `source_filename = "${escapeLlvm(this.program.file)}"`,
      `target datalayout = "${this.target.llvmDataLayout}"`,
      `target triple = "${this.target.llvmTriple}"`,
      '',
    ];
    for (const struct of this.structs.values()) output.push(this.emitStruct(struct));
    if (this.structs.size) output.push('');
    const multiboot = this.emitMultiboot2Header();
    if (multiboot) output.push(multiboot, '');
    for (const declaration of this.constants.values()) output.push(this.emitConstant(declaration));
    for (const declaration of this.globals.values()) output.push(this.emitStatic(declaration));
    if (this.constants.size || this.globals.size) output.push('');
    for (const fn of this.functions.values()) {
      output.push(fn.external ? this.emitExtern(fn) : new FunctionEmitter(this, fn).compile());
    }
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
}

export function compileNativeSystemSource(source, options = {}) {
  return new NativeCompiler(parseNativeSystemSource(source, options), options).compile();
}

export function describeNativeLayout(source, options = {}) {
  const compiler = new NativeCompiler(parseNativeSystemSource(source, options), options);
  compiler.validate();
  return {
    target: compiler.target.triple,
    structs: [...compiler.structs.values()].map(struct => {
      const layout = compiler.layoutOf({ kind: 'named', name: struct.name });
      return {
        name: struct.name,
        size: layout.size,
        alignment: layout.alignment,
        packed: layout.packed,
        fields: layout.fields.map(field => ({ ...field, type: formatSystemType(field.type) })),
      };
    }),
    constants: [...compiler.constants.values()].map(item => {
      const result = compiler.constantEvaluator.evaluateDeclaration(item);
      return { name: item.name, type: formatSystemType(result.type), value: result.value.toString() };
    }),
    globals: [...compiler.globals.values()].map(item => ({
      name: item.name,
      type: formatSystemType(compiler.resolveType(item.type, item.token)),
      mutable: item.mutable,
      symbol: compiler.symbolName(item),
    })),
  };
}
