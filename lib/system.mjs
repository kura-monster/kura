// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * Target-independent primitives shared by Kura's freestanding compiler path.
 * This file intentionally has no dependency on the JavaScript backend.
 */

export class KuraSystemError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'KuraSystemError';
    this.code = options.code ?? 'KR-SYS-0001';
    this.details = options.details ?? null;
  }
}

export const SYSTEM_INTEGER_TYPES = Object.freeze({
  u8: Object.freeze({ kind: 'integer', name: 'u8', bits: 8, signed: false }),
  u16: Object.freeze({ kind: 'integer', name: 'u16', bits: 16, signed: false }),
  u32: Object.freeze({ kind: 'integer', name: 'u32', bits: 32, signed: false }),
  u64: Object.freeze({ kind: 'integer', name: 'u64', bits: 64, signed: false }),
  u128: Object.freeze({ kind: 'integer', name: 'u128', bits: 128, signed: false }),
  i8: Object.freeze({ kind: 'integer', name: 'i8', bits: 8, signed: true }),
  i16: Object.freeze({ kind: 'integer', name: 'i16', bits: 16, signed: true }),
  i32: Object.freeze({ kind: 'integer', name: 'i32', bits: 32, signed: true }),
  i64: Object.freeze({ kind: 'integer', name: 'i64', bits: 64, signed: true }),
  i128: Object.freeze({ kind: 'integer', name: 'i128', bits: 128, signed: true }),
});

export const SUPPORTED_SYSTEM_TARGETS = Object.freeze({
  'x86_64-unknown-none': Object.freeze({
    triple: 'x86_64-unknown-none',
    architecture: 'x86_64',
    vendor: 'unknown',
    operatingSystem: 'none',
    pointerBits: 64,
    endianness: 'little',
    llvmTriple: 'x86_64-unknown-none',
    llvmDataLayout: 'e-m:e-p:64:64-i64:64-i128:128-n8:16:32:64-S128',
  }),
});

export function resolveSystemTarget(target = 'x86_64-unknown-none') {
  const resolved = SUPPORTED_SYSTEM_TARGETS[target];
  if (!resolved) {
    throw new KuraSystemError(`Unsupported Kura system target '${target}'.`, {
      code: 'KR-SYS-1001',
      details: { supported: Object.keys(SUPPORTED_SYSTEM_TARGETS) },
    });
  }
  return resolved;
}

export function parseSystemType(source, options = {}) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new KuraSystemError('A system type must be a non-empty string.', { code: 'KR-SYS-1101' });
  }
  const target = resolveSystemTarget(options.target);
  const text = source.replace(/\s+/g, ' ').trim();
  if (text === 'bool') return Object.freeze({ kind: 'bool', name: 'bool', bits: 1 });
  if (text === 'never') return Object.freeze({ kind: 'never', name: 'never' });
  if (text === 'void') return Object.freeze({ kind: 'void', name: 'void' });
  if (text === 'usize' || text === 'isize') {
    return Object.freeze({
      kind: 'integer', name: text, bits: target.pointerBits,
      signed: text === 'isize', pointerSized: true,
    });
  }
  if (SYSTEM_INTEGER_TYPES[text]) return SYSTEM_INTEGER_TYPES[text];
  const pointer = /^\*(const|mut)\s+(.+)$/.exec(text);
  if (pointer) {
    return Object.freeze({
      kind: 'pointer', mutable: pointer[1] === 'mut',
      pointee: parseSystemType(pointer[2], options),
    });
  }
  const array = /^\[(.+);\s*([0-9]+)\]$/.exec(text);
  if (array) {
    const length = Number(array[2]);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new KuraSystemError(`Invalid array length '${array[2]}'.`, { code: 'KR-SYS-1102' });
    }
    return Object.freeze({ kind: 'array', element: parseSystemType(array[1], options), length });
  }
  if (/^[A-Za-z_][A-Za-z0-9_:]*$/.test(text)) {
    return Object.freeze({ kind: 'named', name: text });
  }
  throw new KuraSystemError(`Invalid Kura system type '${source}'.`, { code: 'KR-SYS-1103' });
}

export function formatSystemType(type) {
  switch (type.kind) {
    case 'integer':
    case 'bool':
    case 'never':
    case 'void':
    case 'named': return type.name;
    case 'pointer': return `*${type.mutable ? 'mut' : 'const'} ${formatSystemType(type.pointee)}`;
    case 'array': return `[${formatSystemType(type.element)}; ${type.length}]`;
    default: return '<unknown>';
  }
}

export function llvmType(type, options = {}) {
  const resolved = typeof type === 'string' ? parseSystemType(type, options) : type;
  switch (resolved.kind) {
    case 'integer': return `i${resolved.bits}`;
    case 'bool': return 'i1';
    case 'pointer': return 'ptr';
    case 'array': return `[${resolved.length} x ${llvmType(resolved.element, options)}]`;
    case 'void':
    case 'never': return 'void';
    case 'named': return `%${resolved.name.replaceAll('::', '.')}`;
    default: throw new KuraSystemError(`Cannot lower '${formatSystemType(resolved)}' to LLVM.`, { code: 'KR-SYS-1201' });
  }
}

export function sizeOfSystemType(type, options = {}) {
  const target = resolveSystemTarget(options.target);
  const resolved = typeof type === 'string' ? parseSystemType(type, options) : type;
  switch (resolved.kind) {
    case 'integer': return Math.ceil(resolved.bits / 8);
    case 'bool': return 1;
    case 'pointer': return target.pointerBits / 8;
    case 'array': return sizeOfSystemType(resolved.element, options) * resolved.length;
    case 'void':
    case 'never': return 0;
    default: throw new KuraSystemError(`Size is unknown for '${formatSystemType(resolved)}'.`, { code: 'KR-SYS-1104' });
  }
}

export function alignOfSystemType(type, options = {}) {
  const target = resolveSystemTarget(options.target);
  const resolved = typeof type === 'string' ? parseSystemType(type, options) : type;
  switch (resolved.kind) {
    case 'integer': return Math.min(Math.ceil(resolved.bits / 8), 16);
    case 'bool': return 1;
    case 'pointer': return target.pointerBits / 8;
    case 'array': return alignOfSystemType(resolved.element, options);
    case 'void':
    case 'never': return 1;
    default: throw new KuraSystemError(`Alignment is unknown for '${formatSystemType(resolved)}'.`, { code: 'KR-SYS-1105' });
  }
}

function valueName(name) {
  if (typeof name !== 'string' || !/^%?[A-Za-z_.$][A-Za-z0-9_.$-]*$/.test(name)) {
    throw new KuraSystemError(`Invalid IR value name '${name}'.`, { code: 'KR-SYS-1301' });
  }
  return name.startsWith('%') ? name : `%${name}`;
}

function globalName(name) {
  if (typeof name !== 'string' || !/^@?[A-Za-z_.$][A-Za-z0-9_.$-]*$/.test(name)) {
    throw new KuraSystemError(`Invalid IR global name '${name}'.`, { code: 'KR-SYS-1302' });
  }
  return name.startsWith('@') ? name : `@${name}`;
}

export class KuraIrFunctionBuilder {
  constructor(name, options = {}) {
    this.name = globalName(name);
    this.target = options.target ?? 'x86_64-unknown-none';
    this.returnType = parseSystemType(options.returnType ?? 'void', { target: this.target });
    this.parameters = (options.parameters ?? []).map(parameter => ({
      name: valueName(parameter.name),
      type: parseSystemType(parameter.type, { target: this.target }),
    }));
    this.callingConvention = options.callingConvention ?? 'c';
    this.noreturn = options.noreturn ?? this.returnType.kind === 'never';
    this.instructions = [];
    this.terminated = false;
  }

  #open() {
    if (this.terminated) throw new KuraSystemError(`IR function ${this.name} already has a terminator.`, { code: 'KR-SYS-1307' });
  }

  constant(name, type, value) {
    this.#open();
    this.instructions.push({ op: 'constant', result: valueName(name), type: parseSystemType(type, { target: this.target }), value });
    return this;
  }

  intToPtr(name, value, pointerType = '*mut u8') {
    this.#open();
    const type = parseSystemType(pointerType, { target: this.target });
    if (type.kind !== 'pointer') throw new KuraSystemError('intToPtr requires a pointer type.', { code: 'KR-SYS-1304' });
    this.instructions.push({ op: 'inttoptr', result: valueName(name), value: valueName(value), type });
    return this;
  }

  volatileStore(type, value, address, options = {}) {
    this.#open();
    this.instructions.push({
      op: 'volatile_store', type: parseSystemType(type, { target: this.target }),
      value: typeof value === 'string' ? valueName(value) : value,
      address: valueName(address), alignment: options.alignment ?? null,
    });
    return this;
  }

  inlineAssembly(assembly, constraints = '', options = {}) {
    this.#open();
    this.instructions.push({ op: 'inline_asm', assembly, constraints, sideEffect: options.sideEffect ?? true });
    return this;
  }

  returnVoid() { this.#open(); this.instructions.push({ op: 'return_void' }); this.terminated = true; return this; }
  unreachable() { this.#open(); this.instructions.push({ op: 'unreachable' }); this.terminated = true; return this; }

  build() {
    if (!this.terminated) throw new KuraSystemError(`IR function ${this.name} has no terminator.`, { code: 'KR-SYS-1306' });
    return Object.freeze({
      kind: 'function', name: this.name, returnType: this.returnType,
      parameters: Object.freeze(this.parameters.slice()),
      callingConvention: this.callingConvention, noreturn: this.noreturn,
      instructions: Object.freeze(this.instructions.slice()),
    });
  }
}

export function createKuraIrModule(options = {}) {
  return Object.freeze({
    kind: 'module', name: options.name ?? 'kura.system.module',
    target: resolveSystemTarget(options.target),
    functions: Object.freeze((options.functions ?? []).slice()),
  });
}

function integerLiteral(value, type) {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'bigint') return value.toString();
  if (!Number.isSafeInteger(value)) {
    throw new KuraSystemError(`Integer constant '${value}' is not safe.`, {
      code: 'KR-SYS-1401', details: { type: formatSystemType(type) },
    });
  }
  return String(value);
}

function callingConvention(value) {
  if (value === 'c') return '';
  if (value === 'interrupt') return 'x86_intrcc ';
  throw new KuraSystemError(`Unsupported calling convention '${value}'.`, { code: 'KR-SYS-1402' });
}

function escapeLlvm(value) {
  return String(value).replaceAll('\\', '\\5C').replaceAll('"', '\\22').replaceAll('\n', '\\0A').replaceAll('\r', '\\0D');
}

export function emitLlvmIr(module) {
  if (!module || module.kind !== 'module') throw new KuraSystemError('Expected a Kura IR module.', { code: 'KR-SYS-1403' });
  const lines = [
    `; ModuleID = '${module.name}'`,
    `source_filename = "${escapeLlvm(module.name)}"`,
    `target datalayout = "${module.target.llvmDataLayout}"`,
    `target triple = "${module.target.llvmTriple}"`,
    '',
  ];
  for (const fn of module.functions) {
    const params = fn.parameters.map(parameter => `${llvmType(parameter.type, { target: module.target.triple })} ${parameter.name}`).join(', ');
    lines.push(`define ${callingConvention(fn.callingConvention)}${llvmType(fn.returnType, { target: module.target.triple })} ${fn.name}(${params})${fn.noreturn ? ' noreturn' : ''} {`, 'entry:');
    const values = new Map(fn.parameters.map(parameter => [parameter.name, { type: parameter.type, reference: parameter.name }]));
    for (const instruction of fn.instructions) {
      if (instruction.op === 'constant') {
        values.set(instruction.result, { type: instruction.type, literal: integerLiteral(instruction.value, instruction.type) });
      } else if (instruction.op === 'inttoptr') {
        const input = values.get(instruction.value);
        if (!input) throw new KuraSystemError(`Unknown IR value '${instruction.value}'.`, { code: 'KR-SYS-1404' });
        lines.push(`  ${instruction.result} = inttoptr ${llvmType(input.type, { target: module.target.triple })} ${input.literal ?? input.reference} to ptr`);
        values.set(instruction.result, { type: instruction.type, reference: instruction.result });
      } else if (instruction.op === 'volatile_store') {
        const value = typeof instruction.value === 'string' ? values.get(instruction.value) : null;
        const address = values.get(instruction.address);
        if (!address) throw new KuraSystemError(`Unknown address value '${instruction.address}'.`, { code: 'KR-SYS-1405' });
        const stored = value?.reference ?? value?.literal ?? integerLiteral(instruction.value, instruction.type);
        const align = instruction.alignment ?? alignOfSystemType(instruction.type, { target: module.target.triple });
        lines.push(`  store volatile ${llvmType(instruction.type, { target: module.target.triple })} ${stored}, ptr ${address.reference}, align ${align}`);
      } else if (instruction.op === 'inline_asm') {
        lines.push(`  call void asm${instruction.sideEffect ? ' sideeffect' : ''} "${escapeLlvm(instruction.assembly)}", "${escapeLlvm(instruction.constraints)}"()`);
      } else if (instruction.op === 'return_void') lines.push('  ret void');
      else if (instruction.op === 'unreachable') lines.push('  unreachable');
      else throw new KuraSystemError(`Unknown Kura IR instruction '${instruction.op}'.`, { code: 'KR-SYS-1406' });
    }
    lines.push('}', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function buildHelloVgaModule(options = {}) {
  const target = options.target ?? 'x86_64-unknown-none';
  const fn = new KuraIrFunctionBuilder('kernel_main', { target, returnType: 'never', noreturn: true });
  fn.constant('vga_address', 'usize', 0xB8000)
    .intToPtr('vga', 'vga_address')
    .constant('character', 'u8', options.character ?? 75)
    .volatileStore('u8', 'character', 'vga', { alignment: 1 })
    .constant('attribute_address', 'usize', 0xB8001)
    .intToPtr('attribute', 'attribute_address')
    .constant('attribute_value', 'u8', options.attribute ?? 0x0f)
    .volatileStore('u8', 'attribute_value', 'attribute', { alignment: 1 })
    .inlineAssembly('hlt')
    .unreachable();
  return createKuraIrModule({ name: 'kura.hello.vga', target, functions: [fn.build()] });
}
