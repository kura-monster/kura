// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildNativeKernel,
  compileNativeSystemSource,
  createGrubConfig,
  createNativeBuildPlan,
  createNativeLinkerScript,
  describeNativeLayout,
  detectNativeToolchain,
  parseNativeSystemSource,
} from '../lib/system-native.mjs';

const source = `#![target("x86_64-unknown-none")]
#![no_std]
#![no_main]
#![multiboot2]

const BASE: usize = 0xB8000
const MASK: u8 = (1 << 4) | 15

@repr(C)
struct Pair { first: u8, second: u32 }

@section(".data.boot")
@align(8)
static mut TICKS: u64 = 0

@link_name("firmware_probe")
extern "C" fn probe(value: u32) -> u32;

@interrupt
pub extern "x86-interrupt" fn irq(frame: *mut Pair) {
  TICKS += 1
  unsafe { io.out8(0x20, 0x20) }
}

@entry
@section(".text.boot")
pub extern "C" fn kernel_main() -> never {
  let mask: u8 = MASK
  unsafe {
    memory.volatile_write<u8>(BASE, 75)
    io.out8(0x3F8, mask)
    cpu.halt()
  }
}
`;

const ast = parseNativeSystemSource(source, { file: 'next.kr' });
assert.equal(ast.declarations.filter(item => item.kind === 'ConstantDeclaration').length, 2);
assert.equal(ast.declarations.filter(item => item.kind === 'StaticDeclaration').length, 1);
assert.equal(ast.declarations.find(item => item.name === 'probe').external, true);

const llvm = compileNativeSystemSource(source, { file: 'next.kr' });
assert.match(llvm, /@__kura_multiboot2_header/);
assert.match(llvm, /section "\.multiboot2"/);
assert.match(llvm, /@BASE = internal constant i64 753664/);
assert.match(llvm, /@MASK = internal constant i8 31/);
assert.match(llvm, /@TICKS = internal global i64 0, section "\.data\.boot", align 8/);
assert.match(llvm, /declare i32 @firmware_probe\(i32\)/);
assert.match(llvm, /define x86_intrcc void @irq\(ptr %arg\.frame\)/);
assert.match(llvm, /section "\.text\.boot"/);
assert.match(llvm, /asm sideeffect "outb \$0, \$1"/);
assert.match(llvm, /store volatile i8 75/);

const layout = describeNativeLayout(source, { file: 'next.kr' });
assert.equal(layout.structs[0].size, 8);
assert.equal(layout.structs[0].fields[1].offset, 4);
assert.equal(layout.constants.find(item => item.name === 'MASK').value, '31');
assert.equal(layout.globals[0].mutable, true);

assert.throws(
  () => compileNativeSystemSource('#![no_std]\nconst A: u32 = B\nconst B: u32 = A\nfn main() {}', { file: 'cycle.kr' }),
  error => error.code === 'KR-NATIVE-CONST-0001',
);
assert.throws(
  () => compileNativeSystemSource('#![no_std]\nfn main() { io.out8(1, 2) }', { file: 'unsafe.kr' }),
  error => error.code === 'KR-NATIVE-SAFE-0001',
);

const script = createNativeLinkerScript({ entry: 'kernel_main' });
assert.match(script, /ENTRY\(kernel_main\)/);
assert.match(script, /KEEP\(\*\(\.multiboot2\)\)/);
assert.match(script, /\.text ALIGN\(4K\)/);
assert.match(createGrubConfig(), /multiboot2 \/boot\/kernel\.elf/);

const plan = createNativeBuildPlan({ input: 'kernel.kr', outDir: 'build/native' });
assert.ok(plan.llvm.endsWith('kernel.ll'));
assert.ok(plan.elf.endsWith('kernel.elf'));

const tools = detectNativeToolchain();
if (tools.canEmitObject && tools.canLinkElf) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kura-native-next-'));
  try {
    const minimal = await readFile(new URL('../examples/system/minimal-kernel.kr', import.meta.url), 'utf8');
    const buildPlan = createNativeBuildPlan({ input: path.join(directory, 'minimal-kernel.kr'), outDir: directory });
    const result = await buildNativeKernel(minimal, { plan: buildPlan, file: 'minimal-kernel.kr' });
    assert.ok((await stat(result.plan.object)).size > 0);
    assert.ok((await stat(result.plan.elf)).size > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

console.log('system next-stage tests passed');
