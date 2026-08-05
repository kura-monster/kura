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
assert.match(source, /const MULTIBOOT_TAG_MEMORY_MAP: u32 = 6/);
assert.match(source, /fn parse_multiboot_memory_map\(boot_info: usize\) -> bool/);
assert.match(source, /memory\.read<u32>\(tag \+ 8\)/);
assert.match(source, /memory\.read<usize>\(entry \+ 8\)/);
assert.match(source, /fn select_next_memory_map_region\(\) -> bool/);
assert.match(source, /region_end > IDENTITY_MAPPED_BYTES/);
assert.match(source, /ranges_overlap\(address, frame_end, BOOT_INFO_START, BOOT_INFO_END\)/);
assert.match(source, /frame_allocator_init_from_multiboot\(boot_info\)/);
assert.match(source, /pub unsafe fn frame_allocator_uses_memory_map\(\) -> bool/);
assert.match(source, /const FRAME_STATE_ALLOCATED: u8 = 1/);
assert.match(source, /const FRAME_STATE_PAGE_TABLE: u8 = 2/);
assert.match(source, /const FRAME_STATE_RELEASED: u8 = 3/);
assert.match(source, /const SAFE_HEAP_BASE: usize = 0x[0-9A-F]+/);
assert.match(source, /const PAGE_NO_EXECUTE: usize = 0x8000000000000000/);
assert.match(source, /fn virtual_address_is_canonical\(address: usize\) -> bool/);
assert.match(source, /fn page_flags_are_valid\(flags: usize\) -> bool/);
assert.match(source, /unsafe fn frame_ownership_reset\(\)/);
assert.match(source, /unsafe fn release_owned_frame\(address: usize, expected_state: u8\) -> bool/);
assert.match(source, /unsafe fn alloc_page_table_frame\(\) -> usize/);
assert.match(source, /unsafe fn free_page_table_frame\(address: usize\) -> bool/);
assert.match(source, /unsafe fn page_table_root_is_valid\(root: usize\) -> bool/);
assert.match(source, /static mut FREE_FRAME_HEAD: usize = 0/);
assert.match(source, /fn frame_in_available_memory\(address: usize\) -> bool/);
assert.match(source, /pub unsafe fn free_frame_count\(\) -> usize/);
assert.match(source, /pub unsafe fn free_frame\(address: usize\) -> bool/);
assert.match(source, /return release_owned_frame\(address, FRAME_STATE_ALLOCATED\)/);
assert.match(source, /frame_state_set\(current, FRAME_STATE_ALLOCATED\)/);
assert.match(source, /pub unsafe fn alloc_frame\(\) -> usize/);
assert.match(source, /pub unsafe fn page_table_create\(\) -> usize/);
assert.match(source, /pub unsafe fn page_table_current\(\) -> usize/);
assert.match(source, /pub unsafe fn page_table_activate\(root: usize\) -> bool/);
assert.match(source, /pub unsafe fn page_table_map\(root: usize, virtual_address: usize, physical_address: usize, flags: usize\) -> bool/);
assert.match(source, /pml4_entry \|= PAGE_USER/);
assert.match(source, /pdpt_entry \|= PAGE_USER/);
assert.match(source, /directory_entry \|= PAGE_USER/);
assert.match(source, /pub unsafe fn page_table_map_new\(root: usize, virtual_address: usize, flags: usize\) -> usize/);
assert.match(source, /pub unsafe fn page_table_translate\(root: usize, virtual_address: usize\) -> usize/);
assert.match(source, /pub unsafe fn page_table_unmap\(root: usize, virtual_address: usize, release_physical: bool\) -> usize/);
assert.match(source, /if page_table_current\(\) == root/);
assert.match(source, /pub unsafe fn page_table_destroy\(root: usize\) -> bool/);
assert.match(source, /pub unsafe fn memory_runtime_self_test\(\) -> bool/);
assert.match(source, /memory\.write<u64>\(VM_SELF_TEST_ADDRESS, VM_SELF_TEST_PATTERN\)/);
assert.match(source, /let memory_runtime_ready: bool = memory_runtime_self_test\(\)/);
assert.match(source, /serial_write_byte\(0x56\)/);
assert.match(source, /io\.out32\(0xF4, 17\)/);
assert.match(source, /page_table_release_empty_child\(directory, directory_index, table\)/);
assert.match(source, /cpu\.invalidate_page\(virtual_address\)/);
assert.match(source, /heap_init\(SAFE_HEAP_BASE, SAFE_HEAP_SIZE\)/);
assert.match(source, /pub unsafe fn heap_alloc/);
assert.match(source, /io\.out32\(0xF4, 16\)/);

const llvm = compileNativeSystemSource(source, { file: 'generated-kernel.kr' });
assert.match(llvm, /ptrtoint ptr @divide_by_zero to i64/);
assert.match(llvm, /x86_intrcc void @page_fault/);
assert.match(llvm, /define .*@frame_state_get\(/);
assert.match(llvm, /define .*@release_owned_frame\(/);
assert.match(llvm, /define .*@free_frame\(/);
assert.match(llvm, /define .*@page_table_create\(/);
assert.match(llvm, /define .*@page_table_map\(/);
assert.match(llvm, /define .*@page_table_translate\(/);
assert.match(llvm, /define .*@page_table_unmap\(/);
assert.match(llvm, /define .*@memory_runtime_self_test\(/);
assert.match(llvm, /load i8, ptr/);
assert.match(llvm, /store i8/);
assert.match(llvm, /load i32, ptr/);
assert.match(llvm, /load i64, ptr/);
assert.match(llvm, /asm sideeffect "lgdt \(\$0\)"/);
assert.match(llvm, /asm sideeffect "lidt \(\$0\)"/);
assert.match(llvm, /asm sideeffect "mov %cr4, \$0"/);
assert.match(llvm, /asm sideeffect "mov \$0, %cr3"/);
assert.match(llvm, /asm sideeffect "invlpg \(\$0\)"/);
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