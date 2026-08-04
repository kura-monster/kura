// SPDX-License-Identifier: MIT OR Apache-2.0

import assert from 'node:assert/strict';
import {
  KuraIrFunctionBuilder,
  alignOfSystemType,
  buildHelloVgaModule,
  createKuraIrModule,
  emitLlvmIr,
  formatSystemType,
  llvmType,
  parseSystemType,
  resolveSystemTarget,
  sizeOfSystemType,
} from '../lib/system.mjs';

const target = resolveSystemTarget('x86_64-unknown-none');
assert.equal(target.pointerBits, 64);
assert.equal(target.operatingSystem, 'none');

assert.deepEqual(parseSystemType('u8'), {
  kind: 'integer', name: 'u8', bits: 8, signed: false,
});
assert.equal(formatSystemType(parseSystemType('*mut u32')), '*mut u32');
assert.equal(sizeOfSystemType('usize'), 8);
assert.equal(sizeOfSystemType('[u16; 4]'), 8);
assert.equal(alignOfSystemType('*const u8'), 8);
assert.equal(llvmType('u128'), 'i128');
assert.equal(llvmType('*mut u8'), 'ptr');

const fn = new KuraIrFunctionBuilder('write_byte', {
  target: target.triple,
  returnType: 'void',
  parameters: [{ name: 'address', type: '*mut u8' }],
});
fn.constant('value', 'u8', 65)
  .volatileStore('u8', 'value', 'address', { alignment: 1 })
  .returnVoid();

const module = createKuraIrModule({
  name: 'kura.system.test',
  target: target.triple,
  functions: [fn.build()],
});
const llvm = emitLlvmIr(module);
assert.match(llvm, /target triple = "x86_64-unknown-none"/);
assert.match(llvm, /define void @write_byte\(ptr %address\)/);
assert.match(llvm, /store volatile i8 65, ptr %address, align 1/);
assert.match(llvm, /ret void/);

const hello = emitLlvmIr(buildHelloVgaModule());
assert.match(hello, /inttoptr i64 753664 to ptr/);
assert.match(hello, /store volatile i8 75/);
assert.match(hello, /asm sideeffect "hlt"/);
assert.match(hello, /unreachable/);

console.log('system tests passed');
