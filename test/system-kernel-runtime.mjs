// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import {
  buildBootableKernel,
  compileNativeSystemSource,
  createKernelArchitectureManifest,
  createKernelRuntimeSource,
  createNativeBuildPlan,
  createX86_64BootstrapAssembly,
} from '../lib/system-native.mjs';

const manifest = createKernelArchitectureManifest();
assert.equal(manifest.architecture, 'x86_64');
assert.equal(manifest.layout.idt % 16, 0);
assert.equal(manifest.layout.pml4 % 4096, 0);
assert.equal(manifest.identityMappedBytes, 0x40000000);
assert.equal(manifest.regions.some(region => region.name === 'heap'), true);

assert.throws(
  () => createKernelArchitectureManifest({ layout: { heap: 0x5000 } }),
  /overlap/i,
);

const source = createKernelRuntimeSource({ smoke: true });
assert.match(source, /fn init_gdt\(\)/);
assert.match(source, /fn init_idt\(\)/);
assert.match(source, /fn init_pic\(\)/);
assert.match(source, /fn init_identity_paging\(\)/);
assert.match(source, /pub unsafe fn alloc_frame\(\) -> usize/);
assert.match(source, /pub unsafe fn heap_alloc/);
assert.match(source, /io\.out32\(0xF4, 16\)/);

const llvm = compileNativeSystemSource(source, { file: 'generated-kernel.kr' });
assert.match(llvm, /ptrtoint ptr @divide_by_zero to i64/);
assert.match(llvm, /x86_intrcc void @page_fault/);
assert.match(llvm, /asm sideeffect "lgdt \(\$0\)"/);
assert.match(llvm, /asm sideeffect "lidt \(\$0\)"/);
assert.match(llvm, /asm sideeffect "mov %cr4, \$0"/);
assert.match(llvm, /asm sideeffect "mov \$0, %cr3"/);
assert.match(llvm, /asm sideeffect "rdmsr"/);
assert.match(llvm, /asm sideeffect "wrmsr"/);
assert.match(llvm, /asm sideeffect "hlt"/);

const bootstrap = createX86_64BootstrapAssembly();
assert.match(bootstrap, /0xE85250D6/);
assert.match(bootstrap, /\.code32/);
assert.match(bootstrap, /\.code64/);
assert.match(bootstrap, /movl %eax, %cr3/);
assert.match(bootstrap, /ljmp \$0x08, \$long_mode_entry/);
assert.match(bootstrap, /call kernel_main/);
assert.match(bootstrap, /kura_boot_info/);

const plan = createNativeBuildPlan({
  input: 'generated-kernel.kr',
  outDir: '/tmp/kura-kernel-runtime-test',
  entry: 'kura_boot_entry',
});
assert.match(plan.bootstrapAssembly, /kura-bootstrap\.S$/);
assert.match(plan.bootstrapObject, /kura-bootstrap\.o$/);

const fakeTools = {
  clang: { command: 'clang', version: 'test' },
  llc: null,
  assembler: null,
  linker: { command: 'ld.lld', version: 'test' },
  qemu: null,
  grub: null,
  objcopy: null,
};
const build = await buildBootableKernel(source, {
  plan,
  tools: fakeTools,
  dryRun: true,
});
assert.equal(build.objectResult.step.dryRun, true);
assert.equal(build.bootstrapResult.step.dryRun, true);
assert.equal(build.linkResult.step.dryRun, true);
assert.match(build.bootstrapResult.step.commandText, /kura-bootstrap\.S/);
assert.match(build.linkResult.step.commandText, /kura-bootstrap\.o/);
assert.match(build.linkResult.step.commandText, /generated-kernel\.o/);

console.log('system kernel runtime tests passed');
