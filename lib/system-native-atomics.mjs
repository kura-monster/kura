// SPDX-License-Identifier: MIT OR Apache-2.0
import { llvmType, parseSystemType } from './system.mjs';
import { fail, isInteger } from './system-native-common.mjs';

function systemType(emitter, name) {
  return parseSystemType(name, { target: emitter.compiler.target.triple });
}

function voidValue(emitter) {
  return { type: systemType(emitter, 'void'), value: null };
}

function atomicType(emitter, expression) {
  if (expression.typeArguments.length !== 1) {
    fail('Atomic operation requires exactly one type argument.', expression.token, emitter.compiler.context, 'KR-NATIVE-ATOMIC-0001');
  }
  const type = emitter.compiler.resolveType(expression.typeArguments[0], expression.token);
  if (!isInteger(type) && type.kind !== 'bool') {
    fail('Atomic operations currently support integer and bool types.', expression.token, emitter.compiler.context, 'KR-NATIVE-ATOMIC-0002');
  }
  return type;
}

function atomicPointer(emitter, expression, argument) {
  const address = emitter.cast(emitter.compileExpression(argument), systemType(emitter, 'usize'), expression.token);
  const pointer = emitter.temp('atomicptr');
  emitter.emit(`${pointer} = inttoptr i64 ${address.value} to ptr`);
  return pointer;
}

function atomicLoad(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Atomic load');
  if (expression.args.length !== 1) fail('atomic.load<T>(address) requires one argument.', expression.token, emitter.compiler.context);
  const type = atomicType(emitter, expression);
  const pointer = atomicPointer(emitter, expression, expression.args[0]);
  const result = emitter.temp('atomicload');
  const llvm = llvmType(type, { target: emitter.compiler.target.triple });
  emitter.emit(`${result} = load atomic ${llvm}, ptr ${pointer} seq_cst, align ${emitter.compiler.alignOf(type)}`);
  return { type, value: result };
}

function atomicStore(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Atomic store');
  if (expression.args.length !== 2) fail('atomic.store<T>(address, value) requires two arguments.', expression.token, emitter.compiler.context);
  const type = atomicType(emitter, expression);
  const pointer = atomicPointer(emitter, expression, expression.args[0]);
  const value = emitter.cast(emitter.compileExpression(expression.args[1]), type, expression.token);
  const llvm = llvmType(type, { target: emitter.compiler.target.triple });
  emitter.emit(`store atomic ${llvm} ${value.value}, ptr ${pointer} seq_cst, align ${emitter.compiler.alignOf(type)}`);
  return voidValue(emitter);
}

function atomicExchange(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Atomic exchange');
  if (expression.args.length !== 2) fail('atomic.exchange<T>(address, value) requires two arguments.', expression.token, emitter.compiler.context);
  const type = atomicType(emitter, expression);
  const pointer = atomicPointer(emitter, expression, expression.args[0]);
  const value = emitter.cast(emitter.compileExpression(expression.args[1]), type, expression.token);
  const result = emitter.temp('atomicxchg');
  const llvm = llvmType(type, { target: emitter.compiler.target.triple });
  emitter.emit(`${result} = atomicrmw xchg ptr ${pointer}, ${llvm} ${value.value} seq_cst`);
  return { type, value: result };
}

function atomicFetchAdd(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Atomic fetch-add');
  if (expression.args.length !== 2) fail('atomic.fetch_add<T>(address, value) requires two arguments.', expression.token, emitter.compiler.context);
  const type = atomicType(emitter, expression);
  if (!isInteger(type)) fail('atomic.fetch_add requires an integer type.', expression.token, emitter.compiler.context, 'KR-NATIVE-ATOMIC-0003');
  const pointer = atomicPointer(emitter, expression, expression.args[0]);
  const value = emitter.cast(emitter.compileExpression(expression.args[1]), type, expression.token);
  const result = emitter.temp('atomicadd');
  const llvm = llvmType(type, { target: emitter.compiler.target.triple });
  emitter.emit(`${result} = atomicrmw add ptr ${pointer}, ${llvm} ${value.value} seq_cst`);
  return { type, value: result };
}

function atomicCompareExchange(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Atomic compare-exchange');
  if (expression.args.length !== 3) fail('atomic.compare_exchange<T>(address, expected, desired) requires three arguments.', expression.token, emitter.compiler.context);
  const type = atomicType(emitter, expression);
  const pointer = atomicPointer(emitter, expression, expression.args[0]);
  const expected = emitter.cast(emitter.compileExpression(expression.args[1]), type, expression.token);
  const desired = emitter.cast(emitter.compileExpression(expression.args[2]), type, expression.token);
  const pair = emitter.temp('cmpxchgpair');
  const result = emitter.temp('cmpxchgold');
  const llvm = llvmType(type, { target: emitter.compiler.target.triple });
  emitter.emit(`${pair} = cmpxchg ptr ${pointer}, ${llvm} ${expected.value}, ${llvm} ${desired.value} seq_cst seq_cst`);
  emitter.emit(`${result} = extractvalue { ${llvm}, i1 } ${pair}, 0`);
  return { type, value: result };
}

function atomicFence(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Atomic fence');
  if (expression.typeArguments.length || expression.args.length) fail('atomic.fence() takes no arguments.', expression.token, emitter.compiler.context);
  emitter.emit('fence seq_cst');
  return voidValue(emitter);
}

function functionCall0(emitter, expression) {
  emitter.requireUnsafe(expression.token, 'Indirect function call');
  if (expression.typeArguments.length || expression.args.length !== 1) fail('function.call0(address) requires one function address.', expression.token, emitter.compiler.context, 'KR-NATIVE-INTRINSIC-0102');
  const address = emitter.cast(emitter.compileExpression(expression.args[0]), systemType(emitter, 'usize'), expression.token);
  const pointer = emitter.temp('fnptr');
  emitter.emit(`${pointer} = inttoptr i64 ${address.value} to ptr`);
  emitter.emit(`call void ${pointer}()`);
  return voidValue(emitter);
}

export function compileSchedulerIntrinsic(emitter, expression, path) {
  if (path === 'atomic.load') return atomicLoad(emitter, expression);
  if (path === 'atomic.store') return atomicStore(emitter, expression);
  if (path === 'atomic.exchange') return atomicExchange(emitter, expression);
  if (path === 'atomic.fetch_add') return atomicFetchAdd(emitter, expression);
  if (path === 'atomic.compare_exchange') return atomicCompareExchange(emitter, expression);
  if (path === 'atomic.fence') return atomicFence(emitter, expression);
  if (path === 'function.call0') return functionCall0(emitter, expression);
  return null;
}
