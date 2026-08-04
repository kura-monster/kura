// SPDX-License-Identifier: MIT OR Apache-2.0

/**
 * Kura System foundation.
 *
 * This module deliberately stays independent from the JavaScript backend. It
 * defines the target model, system types, a minimal Kura IR, and LLVM text
 * emission needed by the freestanding compiler path.
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
  u8: { kind: 'integer', name: 'u8', bits: 8, signed: false },
  u16: { kind: 'integer', name: 'u16', bits: 16, signed: false },
  u32: { kind: 'integer', name: 'u32', bits: 32, signed: false },
  u64: { kind: 'integer', name: 'u64', bits: 64, signed: false },
  u128: { kind: 'integer', name: 'u128', bits: 128, signed: false },
  i8: { kind: 'integer', name: 'i8', bits: 8, signed: true },
  i16: { kind: 'integer', name: 'i16', bits: 16, signed: true },
  i32: { kind: 'integer', name: 'i32', bits: 32, signed: true },
  i64: { kind: 'integer', name: 'i64', bits: 64, signed: true },
  i128: { kind: 'integer', name: 'i128', bits: 128, signed: true },
});

export const SUPPORTED_SYSTEM_TARGETS = Object.freeze({
  'x86_64-unknown-none': {
    triple: 'x86_64-unknown-none',
    architecture: 'x86_64',
    vendor: 'unknown',
    operatingSystem: 'none',
    pointerBits: 64,
    endianness: 'little',
    llvmTriple: 'x86_64-unknown-none',
    llvmDataLayout: 'e-m:e-p:64:64-i64:64-i128:128-n8:16:32:64-S128',
  },
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
    throw new KuraSystemError('A system type must be a non-empty string.', {
      code: 'KR-SYS-1101',
    });
  }

  const target = resolveSystemTarget(options.target);
  const text = source.replace(/\s+/g, ' ').trim();

  if (text === 'bool') return Object.freeze({ kind: 'bool', name: 'bool', bits: 1 });
  if (text === 'never') return Object.freeze({ kind: 'never', name: 'never' });
  if (text === 'void') return Object.freeze({ kind: 'void', name: 'void' });
  if (text === 'usize' || text === 'isize') {
    return Object.freeze({
      kind: 'integer',
      name: text,
      bits: target.pointerBits,
      signed: text === 'isize',
      pointerSized: true,
    });
  }

  if (SYSTEM_INTEGER_TYPES[text]) return SYSTEM_INTEGER_TYPES[text];

  const pointer = /^\*(const|mut)\s+(.+)$/.exec(text);
  if (pointer) {
    return Object.freeze({
      kind: 'pointer',
      mutable: pointer[1] === 'mut',
      pointee: parseSystemType(pointer[2], options),
    });
  }

  const array = /^\[(.+);\s*([0-9]+)\]$/.exec(text);
  if (array) {
    const length = Number(array[2]);
    if (!Number.isSafeInteger(length)) {
      throw new KuraSystemError(`Array length '${array[2]}' is outside the supported range.`, {
        code: 'KR-SYS-1102',
      });
    }
    return Object.freeze({
      kind: 'array',
      element: parseSystemType(array[1], options),
      length,
    });
  }

  const named = /^[A-Za-z_][A-Za-z0-9_:]*$/.test(text);
  if (named) return Object.freeze({ kind: 'named', name: text });

  throw new KuraSystemError(`Invalid Kura system type '${source}'.`, {
    code: 'KR-SYS-1103',
  });
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
    default:
      throw new KuraSystemError(`Size is unknown for type '${formatSystemType(resolved)}'.`, {
        code: 'KR-SYS-1104',
      });
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
    default:
      throw new KuraSystemError(`Alignment is unknown for type '${formatSystemType(resolved)}'.`, {
        code: 'KR-SYS-1105',
      });
  }
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
  const target = resolveSystemTarget(options.target);
  const resolved = typeof type === 'string' ? parseSystemType(type, options) : type;

  switch (resolved.kind) {
    case 'integer': return `i${resolved.bits}`;
    case 'bool': return 'i1';
    case 'pointer': return 'ptr';
    case 'array': return `[${resolved.length} x ${llvmType(resolved.element, options)}]`;
    case 'void': return 'void';
    case 'never': return 'void';
    case 'named': return `%${resolved.name.replaceAll('::', '.')}`;
    default:
      throw new KuraSystemError(`Cannot lower '${formatSystemType(resolved)}' to LLVM.`, {
        code: 'KR-SYS-1201',
        details: { target: target.triple },
      });
  }
}

function assertValueName(name) {
  if (typeof name !== 'string' || !/^%?[A-Za-z_.$][A-Za-z0-9_.$-]*$/.test(name)) {
    throw new KuraSystemError(`Invalid IR value name '${name}'.`, { code: 'KR-SYS-1301' });
  }
  return name.startsWith('%') ? name : `%${name}`;
}

function assertGlobalName(name) {
  if (typeof name !== 'string' || !/^@?[A-Za-z_.$][A-Za-z0-9_.$-]*$/.test(name)) {
    throw new KuraSystemError(`Invalid IR global name '${name}'.`, { code: 'KR-SYS-1302' });
  }
  return name.startsWith('@') ? name : `@${name}`;
}

export class KuraIrFunctionBuilder {
  constructor(name, options = {}) {
    this.name = assertGlobalName(name);
    this.returnType = parseSystemType(options.returnType ?? 'void', options);
    this.parameters = (options.parameters ?? []).map((parameter) => ({
      name: assertValueName(parameter.name),
      type: parseSystemType(parameter.type, options),
    }));
    this.linkage = options.linkage ?? 'external';
    this.callingConvention = options.callingConvention ?? 'c';
    this.noreturn = options.noreturn ?? this.returnType.kind === 'never';
    this.instructions = [];
    this.terminated = false;
    this.target = options.target ?? 'x86_64-unknown-none';
  }

  constant(name, type, value) {
    this.#ensureOpen();
    const parsedType = parseSystemType(type, { target: this.target });
    if (parsedType.kind !== 'integer' && parsedType.kind !== 'bool') {
      throw new KuraSystemError('IR constants currently support integer and bool types only.', {
        code: 'KR-SYS-1303',
      });
    }
    this.instructions.push({ op: 'constant', result: assertValueName(name), type: parsedType, value });
    return this;
  }

  intToPtr(name, value, pointerType = '*mut u8') {
    this.#ensureOpen();
    const parsedPointer = parseSystemType(pointerType, { target: this.target });
    if (parsedPointer.kind !== 'pointer') {
      throw new KuraSystemError('intToPtr requires a pointer result type.', { code: 'KR-SYS-1304' });
    }
    this.instructions.push({ op: 'inttoptr', result: assertValueName(name), value: assertValueName(value), type: parsedPointer });
    return this;
  }

  volatileStore(type, value, address, options = {}) {
    this.#ensureOpen();
    this.instructions.push({
      op: 'volatile_store',
      type: parseSystemType(type, { target: this.target }),
      value: typeof value === 'string' ? assertValueName(value) : value,
      address: assertValueName(address),
      alignment: options.alignment ?? null,
    });
    return this;
  }

  inlineAssembly(assembly, constraints = '', options = {}) {
    this.#ensureOpen();
    if (typeof assembly !== 'string' || assembly.length === 0) {
      throw new KuraSystemError('Inline assembly cannot be empty.', { code: 'KR-SYS-1305' });
    }
    this.instructions.push({
      op: 'inline_asm',
      assembly,
      constraints,
      sideEffect: options.sideEffect ?? true,
    });
    return this;
  }

  unreachable() {
    this.#ensureOpen();
    this.instructions.push({ op: 'unreachable' });
    this.terminated = true;
    return this;
  }

  returnVoid() {
    this.#ensureOpen();
    this.instructions.push({ op: 'return_void' });
    this.terminated = true;
    return this;
  }

  build() {
    if (!this.terminated) {
      throw new KuraSystemError(`IR function ${this.name} has no terminator.`, {
        code: 'KR-SYS-1306',
      });
    }
    return Object.freeze({
      kind: 'function',
      name: this.name,
      returnType: this.returnType,
      parameters: Object.freeze(this.parameters.slice()),
      linkage: this.linkage,
      callingConvention: this.callingConvention,
      noreturn: this.noreturn,
      instructions: Object.freeze(this.instructions.slice()),
    });
  }

  #ensureOpen() {
    if (this.terminated) {
      throw new KuraSystemError(`IR function ${this.name} already has a terminator.`, {
        code: 'KR-SYS-1307',
      });
    }
  }
}

export function createKuraIrModule(options = {}) {
  const target = resolveSystemTarget(options.target);
  const functions = Object.freeze((options.functions ?? []).slice());
  return Object.freeze({
    kind: 'module',
    name: options.name ?? 'kura.system.module',
    target,
    functions,
  });
}

function llvmIntegerLiteral(value, type) {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'bigint') return value.toString(10);
  if (!Number.isSafeInteger(value)) {
    throw new KuraSystemError(`Integer constant '${value}' must be a safe integer or bigint.`, {
      code: 'KR-SYS-1401',
      details: { type: formatSystemType(type) },
    });
  }
  return String(value);
}

function llvmCallingConvention(convention) {
  if (convention === 'c') return '';
  if (convention === 'interrupt') return 'x86_intrcc ';
  throw new KuraSystemError(`Unsupported calling convention '${convention}'.`, {
    code: 'KR-SYS-1402',
  });
}

function escapeLlvmString(value) {
  return value
    .replaceAll('\\', '\\5C')
    .replaceAll('"', '\\22')
    .replaceAll('\n', '\\0A')
    .replaceAll('\r', '\\0D');
}

export function emitLlvmIr(module) {
  if (!module || module.kind !== 'module') {
    throw new KuraSystemError('emitLlvmIr expected a Kura IR module.', { code: 'KR-SYS-1403' });
  }

  const lines = [
    `; ModuleID = '${module.name}'`,
    `source_filename = "${escapeLlvmString(module.name)}"`,
    `target datalayout = "${module.target.llvmDataLayout}"`,
    `target triple = "${module.target.llvmTriple}"`,
    '',
  ];

  for (const fn of module.functions) {
    const returnType = llvmType(fn.returnType, { target: module.target.triple });
    const parameters = fn.parameters
      .map((parameter) => `${llvmType(parameter.type, { target: module.target.triple })} ${parameter.name}`)
      .join(', ');
    const attributes = fn.noreturn ? ' noreturn' : '';
    lines.push(`define ${llvmCallingConvention(fn.callingConvention)}${returnType} ${fn.name}(${parameters})${attributes} {`);
    lines.push('entry:');

    const values = new Map();
    for (const instruction of fn.instructions) {
      switch (instruction.op) {
        case 'constant': {
          values.set(instruction.result, { type: instruction.type, literal: llvmIntegerLiteral(instruction.value, instruction.type) });
          break;
        }
        case 'inttoptr': {
          const input = values.get(instruction.value);
          if (!input) throw new KuraSystemError(`Unknown IR value '${instruction.value}'.`, { code: 'KR-SYS-1404' });
          lines.push(`  ${instruction.result} = inttoptr ${llvmType(input.type, { target: module.target.triple })} ${input.literal} to ptr`);
          values.set(instruction.result, { type: instruction.type, reference: instruction.result });
          break;
        }
        case 'volatile_store': {
          const value = typeof instruction.value === 'string' ? values.get(instruction.value) : null;
          const address = values.get(instruction.address);
          if (!address) throw new KuraSystemError(`Unknown address value '${instruction.address}'.`, { code: 'KR-SYS-1405' });
          const stored = value?.reference ?? value?.literal ?? llvmIntegerLiteral(instruction.value, instruction.type);
          const alignment = instruction.alignment ?? alignOfSystemType(instruction.type, { target: module.target.triple });
          lines.push(`  store volatile ${llvmType(instruction.type, { target: module.target.triple })} ${stored}, ptr ${address.reference ?? instruction.address}, align ${alignment}`);
          break;
        }
        case 'inline_asm': {
          const sideEffect = instruction.sideEffect ? ' sideeffect' : '';
          lines.push(`  call void asm${sideEffect} "${escapeLlvmString(instruction.assembly)}", "${escapeLlvmString(instruction.constraints)}"()`);
          break;
        }
        case 'return_void':
          lines.push('  ret void');
          break;
        case 'unreachable':
          lines.push('  unreachable');
          break;
        default:
          throw new KuraSystemError(`Unknown Kura IR instruction '${instruction.op}'.`, { code: 'KR-SYS-1406' });
      }
    }
    lines.push('}');
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function buildHelloVgaModule(options = {}) {
  const target = options.target ?? 'x86_64-unknown-none';
  const fn = new KuraIrFunctionBuilder('kernel_main', {
    target,
    returnType: 'never',
    callingConvention: 'c',
    noreturn: true,
  });

  fn.constant('vga_address', 'usize', 0xB8000)
    .intToPtr('vga', 'vga_address', '*mut u8')
    .constant('character', 'u8', options.character ?? 75)
    .volatileStore('u8', 'character', 'vga', { alignment: 1 })
    .constant('attribute_address', 'usize', 0xB8001)
    .intToPtr('attribute', 'attribute_address', '*mut u8')
    .constant('attribute_value', 'u8', options.attribute ?? 0x0F)
    .volatileStore('u8', 'attribute_value', 'attribute', { alignment: 1 })
    .inlineAssembly('hlt')
    .unreachable();

  return createKuraIrModule({
    name: 'kura.hello.vga',
    target,
    functions: [fn.build()],
  });
}
