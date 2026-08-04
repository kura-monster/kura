// SPDX-License-Identifier: MIT OR Apache-2.0
import { llvmType, parseSystemType } from './system.mjs';
import { fail, isPointer, safeName } from './system-native-common.mjs';
import { compileSchedulerIntrinsic } from './system-native-atomics.mjs';

function pathName(expression) {
  if (expression.kind === 'Identifier') return expression.name;
  if (expression.kind === 'MemberExpression') return `${pathName(expression.object)}.${expression.property}`;
  return null;
}

function systemType(emitter, name) {
  return parseSystemType(name, { target: emitter.compiler.target.triple });
}

function voidValue(emitter) {
  return { type: systemType(emitter, 'void'), value: null };
}

function fromAddress(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Raw pointer creation');
  if (expression.typeArguments.length !== 1 || expression.args.length !== 1) {
    fail('pointer.from_address<T>(address) expected.', expression.token, emitter.compiler.context);
  }
  const pointee = emitter.compiler.resolveType(expression.typeArguments[0], expression.token);
  const usize = systemType(emitter, 'usize');
  const address = emitter.cast(emitter.compileExpression(expression.args[0]), usize, expression.token);
  const result = emitter.temp('ptr');
  emitter.emit(`${result} = inttoptr ${llvmType(usize, { target: emitter.compiler.target.triple })} ${address.value} to ptr`);
  return { type: { kind: 'pointer', mutable: true, pointee }, value: result };
}

function functionAddress(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Function address access');
  if (expression.typeArguments.length || expression.args.length !== 1 || expression.args[0].kind !== 'Identifier') {
    fail('function.address(handler) requires one function name.', expression.token, emitter.compiler.context, 'KR-NATIVE-INTRINSIC-0101');
  }
  const binding = emitter.lookup(expression.args[0].name, expression.args[0].token);
  if (binding.kind !== 'function') fail('function.address requires a function.', expression.args[0].token, emitter.compiler.context, 'KR-NATIVE-INTRINSIC-0101');
  const result = emitter.temp('fnaddr');
  const symbol = emitter.compiler.symbolName(binding.declaration) ?? safeName(binding.declaration.name);
  emitter.emit(`${result} = ptrtoint ptr @${symbol} to i64`);
  return { type: systemType(emitter, 'usize'), value: result };
}

function memoryRead(emitter, expression, volatileFlag) {
  emitter.requireUnsafe(expression.token, 'Raw memory read');
  if (expression.typeArguments.length !== 1 || expression.args.length !== 1) {
    fail('memory.read<T>(address) expected.', expression.token, emitter.compiler.context);
  }
  const type = emitter.compiler.resolveType(expression.typeArguments[0], expression.token);
  const usize = systemType(emitter, 'usize');
  const address = emitter.cast(emitter.compileExpression(expression.args[0]), usize, expression.token);
  const pointer = emitter.temp('ptr');
  const value = emitter.temp('read');
  emitter.emit(`${pointer} = inttoptr ${llvmType(usize, { target: emitter.compiler.target.triple })} ${address.value} to ptr`);
  emitter.emit(`${value} = load${volatileFlag ? ' volatile' : ''} ${llvmType(type, { target: emitter.compiler.target.triple })}, ptr ${pointer}, align ${emitter.compiler.alignOf(type)}`);
  return { type, value };
}

function memoryWrite(emitter, expression, volatileFlag) {
  emitter.requireUnsafe(expression.token, 'Raw memory write');
  if (expression.typeArguments.length !== 1 || expression.args.length !== 2) {
    fail('memory.write<T>(address, value) expected.', expression.token, emitter.compiler.context);
  }
  const type = emitter.compiler.resolveType(expression.typeArguments[0], expression.token);
  const usize = systemType(emitter, 'usize');
  const address = emitter.cast(emitter.compileExpression(expression.args[0]), usize, expression.token);
  const value = emitter.cast(emitter.compileExpression(expression.args[1]), type, expression.token);
  const pointer = emitter.temp('ptr');
  emitter.emit(`${pointer} = inttoptr ${llvmType(usize, { target: emitter.compiler.target.triple })} ${address.value} to ptr`);
  emitter.emit(`store${volatileFlag ? ' volatile' : ''} ${llvmType(type, { target: emitter.compiler.target.triple })} ${value.value}, ptr ${pointer}, align ${emitter.compiler.alignOf(type)}`);
  return voidValue(emitter);
}

function pointerMethod(emitter, expression, method) {
  const pointer = emitter.compileExpression(expression.callee.object);
  if (!isPointer(pointer.type)) fail('Pointer method requires a pointer.', expression.token, emitter.compiler.context);
  emitter.requireUnsafe(expression.token, `Pointer ${method}`);
  if (method === 'offset') {
    if (expression.args.length !== 1) fail('.offset(index) requires one argument.', expression.token, emitter.compiler.context);
    const isize = systemType(emitter, 'isize');
    const index = emitter.cast(emitter.compileExpression(expression.args[0]), isize, expression.token);
    const result = emitter.temp('offset');
    emitter.emit(`${result} = getelementptr ${llvmType(pointer.type.pointee, { target: emitter.compiler.target.triple })}, ptr ${pointer.value}, i64 ${index.value}`);
    return { type: pointer.type, value: result };
  }
  if (method === 'read' || method === 'volatile_read') {
    if (expression.args.length) fail(`.${method}() takes no arguments.`, expression.token, emitter.compiler.context);
    const result = emitter.temp('read');
    emitter.emit(`${result} = load${method === 'volatile_read' ? ' volatile' : ''} ${llvmType(pointer.type.pointee, { target: emitter.compiler.target.triple })}, ptr ${pointer.value}, align ${emitter.compiler.alignOf(pointer.type.pointee)}`);
    return { type: pointer.type.pointee, value: result };
  }
  if (!pointer.type.mutable) fail('Cannot write through a const pointer.', expression.token, emitter.compiler.context);
  if (expression.args.length !== 1) fail(`.${method}(value) requires one argument.`, expression.token, emitter.compiler.context);
  const value = emitter.cast(emitter.compileExpression(expression.args[0]), pointer.type.pointee, expression.token);
  emitter.emit(`store${method === 'volatile_write' ? ' volatile' : ''} ${llvmType(pointer.type.pointee, { target: emitter.compiler.target.triple })} ${value.value}, ptr ${pointer.value}, align ${emitter.compiler.alignOf(pointer.type.pointee)}`);
  return voidValue(emitter);
}

function cpuInstruction(emitter, expression, assembly, noreturn = false) {
  emitter.requireUnsafe(expression.token, `CPU instruction '${assembly}'`);
  if (expression.args.length) fail(`CPU instruction '${assembly}' takes no arguments.`, expression.token, emitter.compiler.context);
  emitter.emit(`call void asm sideeffect "${assembly}", "~{dirflag},~{fpsr},~{flags}"()`);
  if (noreturn) {
    emitter.emit('unreachable');
    emitter.terminated = true;
    return { type: systemType(emitter, 'never'), value: null };
  }
  return voidValue(emitter);
}

function portInput(emitter, expression, bits) {
  emitter.requireUnsafe(expression.token, `Port input i${bits}`);
  if (expression.args.length !== 1) fail(`io.in${bits}(port) requires one argument.`, expression.token, emitter.compiler.context);
  const portType = systemType(emitter, 'u16');
  const resultType = systemType(emitter, `u${bits}`);
  const port = emitter.cast(emitter.compileExpression(expression.args[0]), portType, expression.token);
  const result = emitter.temp('in');
  const suffix = bits === 8 ? 'b' : bits === 16 ? 'w' : 'l';
  const register = bits === 8 ? '={al}' : bits === 16 ? '={ax}' : '={eax}';
  emitter.emit(`${result} = call ${llvmType(resultType, { target: emitter.compiler.target.triple })} asm sideeffect "in${suffix} $1, $0", "${register},{dx},~{dirflag},~{fpsr},~{flags}"(i16 ${port.value})`);
  return { type: resultType, value: result };
}

function portOutput(emitter, expression, bits) {
  emitter.requireUnsafe(expression.token, `Port output i${bits}`);
  if (expression.args.length !== 2) fail(`io.out${bits}(port, value) requires two arguments.`, expression.token, emitter.compiler.context);
  const portType = systemType(emitter, 'u16');
  const valueType = systemType(emitter, `u${bits}`);
  const port = emitter.cast(emitter.compileExpression(expression.args[0]), portType, expression.token);
  const value = emitter.cast(emitter.compileExpression(expression.args[1]), valueType, expression.token);
  const suffix = bits === 8 ? 'b' : bits === 16 ? 'w' : 'l';
  const register = bits === 8 ? '{al}' : bits === 16 ? '{ax}' : '{eax}';
  emitter.emit(`call void asm sideeffect "out${suffix} $0, $1", "${register},{dx},~{dirflag},~{fpsr},~{flags}"(${llvmType(valueType, { target: emitter.compiler.target.triple })} ${value.value}, i16 ${port.value})`);
  return voidValue(emitter);
}

function ioWait(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'I/O wait');
  if (expression.args.length) fail('io.wait() takes no arguments.', expression.token, emitter.compiler.context);
  emitter.emit('call void asm sideeffect "outb %al, $$0x80", "{al},~{dirflag},~{fpsr},~{flags}"(i8 0)');
  return voidValue(emitter);
}

function descriptorLoad(emitter, expression, instruction) {
  emitter.requireUnsafe(expression.token, `${instruction.toUpperCase()} load`);
  if (expression.args.length !== 1) fail(`cpu.${instruction === 'lgdt' ? 'load_gdt' : 'load_idt'}(descriptor) requires one address.`, expression.token, emitter.compiler.context);
  const usize = systemType(emitter, 'usize');
  const address = emitter.cast(emitter.compileExpression(expression.args[0]), usize, expression.token);
  const pointer = emitter.temp('descriptor');
  emitter.emit(`${pointer} = inttoptr i64 ${address.value} to ptr`);
  emitter.emit(`call void asm sideeffect "${instruction} ($0)", "r,~{memory},~{dirflag},~{fpsr},~{flags}"(ptr ${pointer})`);
  return voidValue(emitter);
}

function reloadKernelSegments(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Segment register reload');
  if (expression.args.length) fail('cpu.reload_kernel_segments() takes no arguments.', expression.token, emitter.compiler.context);
  emitter.emit('call void asm sideeffect "movw $$16, %ax; movw %ax, %ds; movw %ax, %es; movw %ax, %ss; pushq $$8; leaq 1f(%rip), %rax; pushq %rax; lretq; 1:", "~{rax},~{memory},~{dirflag},~{fpsr},~{flags}"()');
  return voidValue(emitter);
}

function loadTaskRegister(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Task register load');
  if (expression.args.length !== 1) fail('cpu.load_task_register(selector) requires one selector.', expression.token, emitter.compiler.context);
  const selector = emitter.cast(emitter.compileExpression(expression.args[0]), systemType(emitter, 'u16'), expression.token);
  emitter.emit(`call void asm sideeffect "ltr $0", "r,~{memory},~{dirflag},~{fpsr},~{flags}"(i16 ${selector.value})`);
  return voidValue(emitter);
}

function readControlRegister(emitter, expression, register) {
  emitter.requireUnsafe(expression.token, `Read ${register}`);
  if (expression.args.length) fail(`cpu.read_${register}() takes no arguments.`, expression.token, emitter.compiler.context);
  const result = emitter.temp(register);
  emitter.emit(`${result} = call i64 asm sideeffect "mov %${register}, $0", "=r,~{dirflag},~{fpsr},~{flags}"()`);
  return { type: systemType(emitter, 'u64'), value: result };
}

function writeControlRegister(emitter, expression, register) {
  emitter.requireUnsafe(expression.token, `Write ${register}`);
  if (expression.args.length !== 1) fail(`cpu.write_${register}(value) requires one value.`, expression.token, emitter.compiler.context);
  const value = emitter.cast(emitter.compileExpression(expression.args[0]), systemType(emitter, 'u64'), expression.token);
  emitter.emit(`call void asm sideeffect "mov $0, %${register}", "r,~{memory},~{dirflag},~{fpsr},~{flags}"(i64 ${value.value})`);
  return voidValue(emitter);
}

function invalidatePage(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'TLB page invalidation');
  if (expression.args.length !== 1) fail('cpu.invalidate_page(address) requires one address.', expression.token, emitter.compiler.context);
  const address = emitter.cast(emitter.compileExpression(expression.args[0]), systemType(emitter, 'usize'), expression.token);
  const pointer = emitter.temp('page');
  emitter.emit(`${pointer} = inttoptr i64 ${address.value} to ptr`);
  emitter.emit(`call void asm sideeffect "invlpg ($0)", "r,~{memory},~{dirflag},~{fpsr},~{flags}"(ptr ${pointer})`);
  return voidValue(emitter);
}

function readRflags(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Read RFLAGS');
  if (expression.args.length) fail('cpu.read_rflags() takes no arguments.', expression.token, emitter.compiler.context);
  const result = emitter.temp('rflags');
  emitter.emit(`${result} = call i64 asm sideeffect "pushfq; popq $0", "=r,~{memory},~{dirflag},~{fpsr},~{flags}"()`);
  return { type: systemType(emitter, 'u64'), value: result };
}

function readMsr(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Read model-specific register');
  if (expression.args.length !== 1) fail('cpu.read_msr(index) requires one index.', expression.token, emitter.compiler.context);
  const index = emitter.cast(emitter.compileExpression(expression.args[0]), systemType(emitter, 'u32'), expression.token);
  const pair = emitter.temp('msrpair');
  const low = emitter.temp('msrlo');
  const high = emitter.temp('msrhi');
  const low64 = emitter.temp('msrlo64');
  const high64 = emitter.temp('msrhi64');
  const shifted = emitter.temp('msrshift');
  const result = emitter.temp('msr');
  emitter.emit(`${pair} = call { i32, i32 } asm sideeffect "rdmsr", "={ax},={dx},{cx},~{dirflag},~{fpsr},~{flags}"(i32 ${index.value})`);
  emitter.emit(`${low} = extractvalue { i32, i32 } ${pair}, 0`);
  emitter.emit(`${high} = extractvalue { i32, i32 } ${pair}, 1`);
  emitter.emit(`${low64} = zext i32 ${low} to i64`);
  emitter.emit(`${high64} = zext i32 ${high} to i64`);
  emitter.emit(`${shifted} = shl i64 ${high64}, 32`);
  emitter.emit(`${result} = or i64 ${shifted}, ${low64}`);
  return { type: systemType(emitter, 'u64'), value: result };
}

function writeMsr(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Write model-specific register');
  if (expression.args.length !== 2) fail('cpu.write_msr(index, value) requires two arguments.', expression.token, emitter.compiler.context);
  const index = emitter.cast(emitter.compileExpression(expression.args[0]), systemType(emitter, 'u32'), expression.token);
  const value = emitter.cast(emitter.compileExpression(expression.args[1]), systemType(emitter, 'u64'), expression.token);
  const low = emitter.temp('msrlo');
  const shifted = emitter.temp('msrshift');
  const high = emitter.temp('msrhi');
  emitter.emit(`${low} = trunc i64 ${value.value} to i32`);
  emitter.emit(`${shifted} = lshr i64 ${value.value}, 32`);
  emitter.emit(`${high} = trunc i64 ${shifted} to i32`);
  emitter.emit(`call void asm sideeffect "wrmsr", "{cx},{ax},{dx},~{memory},~{dirflag},~{fpsr},~{flags}"(i32 ${index.value}, i32 ${low}, i32 ${high})`);
  return voidValue(emitter);
}

export function compileSystemIntrinsic(emitter, expression) {
  const path = pathName(expression.callee);
  const schedulerIntrinsic = compileSchedulerIntrinsic(emitter, expression, path);
  if (schedulerIntrinsic) return schedulerIntrinsic;
  if (path === 'pointer.from_address') return fromAddress(emitter, expression);
  if (path === 'function.address') return functionAddress(emitter, expression);
  if (path === 'memory.read') return memoryRead(emitter, expression, false);
  if (path === 'memory.volatile_read') return memoryRead(emitter, expression, true);
  if (path === 'memory.write') return memoryWrite(emitter, expression, false);
  if (path === 'memory.volatile_write') return memoryWrite(emitter, expression, true);

  const cpu = {
    'cpu.halt': ['hlt', true],
    'cpu.wait_for_interrupt': ['hlt', false],
    'cpu.pause': ['pause', false],
    'cpu.disable_interrupts': ['cli', false],
    'cpu.enable_interrupts': ['sti', false],
    'cpu.breakpoint': ['int3', false],
    'cpu.nop': ['nop', false],
    'cpu.swapgs': ['swapgs', false],
  }[path];
  if (cpu) return cpuInstruction(emitter, expression, ...cpu);

  if (path === 'cpu.load_gdt') return descriptorLoad(emitter, expression, 'lgdt');
  if (path === 'cpu.load_idt') return descriptorLoad(emitter, expression, 'lidt');
  if (path === 'cpu.reload_kernel_segments') return reloadKernelSegments(emitter, expression);
  if (path === 'cpu.load_task_register') return loadTaskRegister(emitter, expression);
  if (path === 'cpu.invalidate_page') return invalidatePage(emitter, expression);
  if (path === 'cpu.read_rflags') return readRflags(emitter, expression);
  if (path === 'cpu.read_msr') return readMsr(emitter, expression);
  if (path === 'cpu.write_msr') return writeMsr(emitter, expression);
  for (const register of ['cr0', 'cr2', 'cr3', 'cr4']) {
    if (path === `cpu.read_${register}`) return readControlRegister(emitter, expression, register);
    if (path === `cpu.write_${register}`) return writeControlRegister(emitter, expression, register);
  }

  if (path === 'io.wait') return ioWait(emitter, expression);
  const input = /^io\.in(8|16|32)$/.exec(path ?? '');
  if (input) return portInput(emitter, expression, Number(input[1]));
  const output = /^io\.out(8|16|32)$/.exec(path ?? '');
  if (output) return portOutput(emitter, expression, Number(output[1]));

  if (expression.callee.kind === 'MemberExpression' && ['read', 'volatile_read', 'write', 'volatile_write', 'offset'].includes(expression.callee.property)) {
    return pointerMethod(emitter, expression, expression.callee.property);
  }
  return null;
}
