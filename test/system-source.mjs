// SPDX-License-Identifier: MIT OR Apache-2.0

import assert from 'node:assert/strict';
import {
  KuraSystemSourceError,
  compileSystemSource,
  parseSystemSource,
} from '../lib/system-source.mjs';

const helloSource = `
#![target("x86_64-unknown-none")]
#![no_std]
#![no_main]

@entry
pub extern "C" fn kernel_main() -> never {
  unsafe {
    memory.volatile_write<u8>(0xB8000, 75)
    cpu.halt()
  }
}
`;

const parsed = parseSystemSource(helloSource);
assert.equal(parsed.target, 'x86_64-unknown-none');
assert.equal(parsed.noStd, true);
assert.equal(parsed.noMain, true);
assert.equal(parsed.declarations.length, 1);
assert.equal(parsed.declarations[0].name, 'kernel_main');
assert.equal(parsed.declarations[0].returnType, 'never');
assert.deepEqual(parsed.declarations[0].attributes, ['entry']);

const compiled = compileSystemSource(helloSource, { name: 'hello-kura-kernel' });
assert.match(compiled.llvmIr, /target triple = "x86_64-unknown-none"/);
assert.match(compiled.llvmIr, /define void @kernel_main\(\) noreturn/);
assert.match(compiled.llvmIr, /inttoptr i64 753664 to ptr/);
assert.match(compiled.llvmIr, /store volatile i8 75, ptr %pointer0/);
assert.match(compiled.llvmIr, /asm sideeffect "hlt"/);
assert.match(compiled.llvmIr, /unreachable/);

const interruptSource = `
#![no_std]
@entry
pub unsafe extern "C" fn kernel_main() -> never {
  cpu.disable_interrupts()
  cpu.enable_interrupts()
  cpu.halt()
}
`;
const interruptIr = compileSystemSource(interruptSource).llvmIr;
assert.match(interruptIr, /asm sideeffect "cli"/);
assert.match(interruptIr, /asm sideeffect "sti"/);

assert.throws(
  () => compileSystemSource(`
#![no_std]
@entry
pub extern "C" fn kernel_main() -> never {
  memory.volatile_write<u8>(0xB8000, 75)
}
`),
  (error) => error instanceof KuraSystemSourceError && error.code === 'KR-SYS-SOURCE-1201',
);

assert.throws(
  () => compileSystemSource(`
@entry
pub extern "C" fn kernel_main() -> never {
  unsafe { cpu.halt() }
}
`),
  (error) => error.code === 'KR-SYS-SOURCE-1302',
);

assert.throws(
  () => compileSystemSource(`
#![no_std]
@entry
pub extern "C" fn first() -> never { unsafe { cpu.halt() } }
@entry
pub extern "C" fn second() -> never { unsafe { cpu.halt() } }
`),
  (error) => error.code === 'KR-SYS-SOURCE-1303',
);

console.log('system source tests passed');
