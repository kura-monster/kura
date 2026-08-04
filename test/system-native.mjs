// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import {compileNativeSystemSource,describeNativeLayout,parseNativeSystemSource} from '../lib/system-native.mjs';

const source=`#![target("x86_64-unknown-none")]
#![no_std]
#![no_main]

@repr(C)
struct VgaCell {
  character: u8,
  color: u8,
}

fn count(limit: u32) -> u32 {
  let value: u32 = 0
  while value < limit {
    value += 1
  }
  return value
}

unsafe fn write_cell(index: usize, character: u8, color: u8) {
  let cells: *mut VgaCell = pointer.from_address<VgaCell>(0xB8000)
  let cell: *mut VgaCell = cells.offset(index)
  cell.character = character
  cell.color = color
}

@entry
pub extern "C" fn kernel_main() -> never {
  let result: u32 = count(4)
  if result == 4 {
    unsafe {
      write_cell(0, 75, 15)
      cpu.disable_interrupts()
      cpu.halt()
    }
  }
  unsafe { cpu.halt() }
}
`;

const ast=parseNativeSystemSource(source,{file:'native-kernel.kr'});
assert.equal(ast.kind,'NativeProgram');
assert.equal(ast.declarations.length,4);

const llvm=compileNativeSystemSource(source,{file:'native-kernel.kr'});
assert.match(llvm,/target triple = "x86_64-unknown-none"/);
assert.match(llvm,/%VgaCell = type \{ i8, i8 \}/);
assert.match(llvm,/define internal i32 @count/);
assert.match(llvm,/while\.cond/);
assert.match(llvm,/call i32 @count/);
assert.match(llvm,/getelementptr inbounds %VgaCell/);
assert.match(llvm,/getelementptr %VgaCell/);
assert.match(llvm,/call void asm sideeffect "cli"/);
assert.match(llvm,/call void asm sideeffect "hlt"/);
assert.match(llvm,/unreachable/);

const layout=describeNativeLayout(`#![no_std]\n@repr(C) struct Header { tag: u8, length: u32 }`,{file:'layout.kr'});
assert.equal(layout.structs[0].size,8);
assert.equal(layout.structs[0].alignment,4);
assert.equal(layout.structs[0].fields[1].offset,4);

assert.throws(
  ()=>compileNativeSystemSource(`#![no_std]\nfn invalid() { memory.write<u8>(0x1000, 1) }`,{file:'unsafe.kr'}),
  error=>error.code==='KR-NATIVE-SAFE-0001',
);
assert.throws(
  ()=>compileNativeSystemSource(`fn invalid() { return }`,{file:'nostd.kr'}),
  error=>error.code==='KR-NATIVE-SAFE-0002',
);

console.log('system native tests passed');
