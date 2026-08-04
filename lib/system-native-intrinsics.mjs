// SPDX-License-Identifier: MIT OR Apache-2.0
import { llvmType, parseSystemType } from './system.mjs';
import { fail, isPointer } from './system-native-common.mjs';

function pathName(expression) {
  if (expression.kind === 'Identifier') return expression.name;
  if (expression.kind === 'MemberExpression') return `${pathName(expression.object)}.${expression.property}`;
  return null;
}

function voidValue(emitter) {
  return { type: parseSystemType('void', { target: emitter.compiler.target.triple }), value: null };
}

function fromAddress(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Raw pointer creation');
  if (expression.typeArguments.length !== 1 || expression.args.length !== 1) {
    fail('pointer.from_address<T>(address) expected.', expression.token, emitter.compiler.context);
  }
  const pointee = emitter.compiler.resolveType(expression.typeArguments[0], expression.token);
  const usize = parseSystemType('usize', { target: emitter.compiler.target.triple });
  const address = emitter.cast(emitter.compileExpression(expression.args[0]), usize, expression.token);
  const result = emitter.temp('ptr');
  emitter.emit(`${result} = inttoptr ${llvmType(usize, { target: emitter.compiler.target.triple })} ${address.value} to ptr`);
  return { type: { kind: 'pointer', mutable: true, pointee }, value: result };
}

function memoryRead(emitter, expression, volatileFlag) {
  emitter.requireUnsafe(expression.token, 'Raw memory read');
  if (expression.typeArguments.length !== 1 || expression.args.length !== 1) {
    fail('memory.read<T>(address) expected.', expression.token, emitter.compiler.context);
  }
  const type = emitter.compiler.resolveType(expression.typeArguments[0], expression.token);
  const usize = parseSystemType('usize', { target: emitter.compiler.target.triple });
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
  const usize = parseSystemType('usize', { target: emitter.compiler.target.triple });
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
    const isize = parseSystemType('isize', { target: emitter.compiler.target.triple });
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
  emitter.emit(`call void asm sideeffect "${assembly}", ""()`);
  if (noreturn) {
    emitter.emit('unreachable');
    emitter.terminated = true;
    return { type: parseSystemType('never', { target: emitter.compiler.target.triple }), value: null };
  }
  return voidValue(emitter);
}

function portInput(emitter, expression, bits) {
  emitter.requireUnsafe(expression.token, `Port input i${bits}`);
  if (expression.args.length !== 1) fail(`io.in${bits}(port) requires one argument.`, expression.token, emitter.compiler.context);
  const portType = parseSystemType('u16', { target: emitter.compiler.target.triple });
  const resultType = parseSystemType(`u${bits}`, { target: emitter.compiler.target.triple });
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
  const portType = parseSystemType('u16', { target: emitter.compiler.target.triple });
  const valueType = parseSystemType(`u${bits}`, { target: emitter.compiler.target.triple });
  const port = emitter.cast(emitter.compileExpression(expression.args[0]), portType, expression.token);
  const value = emitter.cast(emitter.compileExpression(expression.args[1]), valueType, expression.token);
  const suffix = bits === 8 ? 'b' : bits === 16 ? 'w' : 'l';
  const register = bits === 8 ? '{al}' : bits === 16 ? '{ax}' : '{eax}';
  emitter.emit(`call void asm sideeffect "out${suffix} $0, $1", "${register},{dx},~{dirflag},~{fpsr},~{flags}"(${llvmType(valueType, { target: emitter.compiler.target.triple })} ${value.value}, i16 ${port.value})`);
  return voidValue(emitter);
}

export function compileSystemIntrinsic(emitter, expression) {
  const path = pathName(expression.callee);
  if (path === 'pointer.from_address') return fromAddress(emitter, expression);
  if (path === 'memory.read') return memoryRead(emitter, expression, false);
  if (path === 'memory.volatile_read') return memoryRead(emitter, expression, true);
  if (path === 'memory.write') return memoryWrite(emitter, expression, false);
  if (path === 'memory.volatile_write') return memoryWrite(emitter, expression, true);

  const cpu = {
    'cpu.halt': ['hlt', true],
    'cpu.pause': ['pause', false],
    'cpu.disable_interrupts': ['cli', false],
    'cpu.enable_interrupts': ['sti', false],
    'cpu.breakpoint': ['int3', false],
    'cpu.nop': ['nop', false],
  }[path];
  if (cpu) return cpuInstruction(emitter, expression, ...cpu);

  const input = /^io\.in(8|16|32)$/.exec(path ?? '');
  if (input) return portInput(emitter, expression, Number(input[1]));
  const output = /^io\.out(8|16|32)$/.exec(path ?? '');
  if (output) return portOutput(emitter, expression, Number(output[1]));

  if (expression.callee.kind === 'MemberExpression' && ['read', 'volatile_read', 'write', 'volatile_write', 'offset'].includes(expression.callee.property)) {
    return pointerMethod(emitter, expression, expression.callee.property);
  }
  return null;
}
