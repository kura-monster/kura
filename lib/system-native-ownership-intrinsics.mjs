// SPDX-License-Identifier: MIT OR Apache-2.0
import { parseSystemType } from './system.mjs';
import { fail } from './system-native-common.mjs';

function voidValue(emitter) {
  return { type: parseSystemType('void', { target: emitter.compiler.target.triple }), value: null };
}

export function compileOwnershipIntrinsic(emitter, expression, path) {
  if (!path?.startsWith('ownership.')) return null;
  if (path === 'ownership.move' || path === 'ownership.clone_copy') {
    if (expression.args.length !== 1) {
      fail(`${path}(value) requires exactly one argument.`, expression.token, emitter.compiler.context, 'KR-NATIVE-OWNERSHIP-0001');
    }
    return emitter.compileExpression(expression.args[0]);
  }
  if (path === 'ownership.borrow' || path === 'ownership.borrow_mut') {
    if (expression.args.length !== 1) {
      fail(`${path}(value) requires exactly one argument.`, expression.token, emitter.compiler.context, 'KR-NATIVE-OWNERSHIP-0002');
    }
    const target = emitter.compileLValue(expression.args[0]);
    const mutable = path === 'ownership.borrow_mut';
    if (mutable && !target.mutable) {
      fail('Cannot mutably borrow an immutable value.', expression.token, emitter.compiler.context, 'KR-NATIVE-OWNERSHIP-0003');
    }
    return { type: { kind: 'pointer', mutable, pointee: target.type }, value: target.pointer };
  }
  if (path === 'ownership.drop' || path === 'ownership.end_borrow') {
    if (expression.args.length !== 1) {
      fail(`${path}(value) requires exactly one argument.`, expression.token, emitter.compiler.context, 'KR-NATIVE-OWNERSHIP-0004');
    }
    if (path === 'ownership.drop') emitter.compileExpression(expression.args[0]);
    return voidValue(emitter);
  }
  fail(`Unknown ownership intrinsic '${path}'.`, expression.token, emitter.compiler.context, 'KR-NATIVE-OWNERSHIP-0005');
}
