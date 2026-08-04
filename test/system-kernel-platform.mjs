// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import {
  buildBootableKernel,
  compileNativeSystemSource,
  createApTrampolineBytes,
  createKernelPlatformManifest,
  createKernelPlatformSource,
  createNativeBuildPlan,
  createPhysicalFrameBitmap,
  decodeMultiboot2,
  parseAcpiMadt,
} from '../lib/system-native.mjs';

function multibootFixture() {
  const bytes = new Uint8Array(80);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length, true);
  view.setUint32(8, 6, true);
  view.setUint32(12, 64, true);
  view.setUint32(16, 24, true);
  view.setUint32(20, 0, true);
  view.setBigUint64(24, 0n, true);
  view.setBigUint64(32, 0x9F000n, true);
  view.setUint32(40, 1, true);
  view.setBigUint64(48, 0x2000000n, true);
  view.setBigUint64(56, 0x4000000n, true);
  view.setUint32(64, 1, true);
  view.setUint32(72, 0, true);
  view.setUint32(76, 8, true);
  return bytes;
}

function madtFixture() {
  const length = 44 + 8 + 12 + 10 + 12;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x43495041, true);
  view.setUint32(4, length, true);
  view.setUint8(8, 1);
  view.setUint32(36, 0xFEE00000, true);
  view.setUint32(40, 1, true);
  let cursor = 44;
  view.setUint8(cursor, 0);
  view.setUint8(cursor + 1, 8);
  view.setUint8(cursor + 2, 0);
  view.setUint8(cursor + 3, 2);
  view.setUint32(cursor + 4, 1, true);
  cursor += 8;
  view.setUint8(cursor, 1);
  view.setUint8(cursor + 1, 12);
  view.setUint8(cursor + 2, 3);
  view.setUint32(cursor + 4, 0xFEC00000, true);
  view.setUint32(cursor + 8, 0, true);
  cursor += 12;
  view.setUint8(cursor, 2);
  view.setUint8(cursor + 1, 10);
  view.setUint8(cursor + 2, 0);
  view.setUint8(cursor + 3, 0);
  view.setUint32(cursor + 4, 2, true);
  view.setUint16(cursor + 8, 0x000D, true);
  cursor += 10;
  view.setUint8(cursor, 5);
  view.setUint8(cursor + 1, 12);
  view.setBigUint64(cursor + 4, 0xFEE01000n, true);
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xFF;
  view.setUint8(9, (-sum) & 0xFF);
  return bytes;
}

const manifest = createKernelPlatformManifest();
assert.equal(manifest.identityMappedBytes, 0x100000000);
assert.equal(manifest.maxTrackedFrames, 0x100000);
assert.equal(manifest.layout.apTrampoline, 0xA000);
assert.equal(manifest.regions.some(region => region.name === 'frameBitmap'), true);
assert.equal(manifest.features.symmetricMultiprocessing, true);
assert.throws(
  () => createKernelPlatformManifest({ layout: { heap: 0x800000 } }),
  /overlap/i,
);

const decoded = decodeMultiboot2(multibootFixture());
assert.equal(decoded.memoryMap.length, 2);
assert.equal(decoded.memoryMap[1].address, 0x2000000n);
assert.equal(decoded.memoryMap[1].length, 0x4000000n);

const physical = createPhysicalFrameBitmap(decoded.memoryMap);
assert.equal(physical.freeFrames, 0x4000000 / 0x1000);
assert.equal(physical.highestPhysical, 0x6000000n);
assert.equal(physical.bitmap[0], 0xFF);
const firstUsableFrame = 0x2000000 / 0x1000;
assert.equal((physical.bitmap[firstUsableFrame >>> 3] >> (firstUsableFrame & 7)) & 1, 0);

const madt = parseAcpiMadt(madtFixture());
assert.equal(madt.localApicAddress, 0xFEE01000n);
assert.equal(madt.processors.length, 1);
assert.equal(madt.processors[0].apicId, 2);
assert.equal(madt.ioApics[0].address, 0xFEC00000n);
assert.equal(madt.overrides[0].gsi, 2);

const trampoline = createApTrampolineBytes();
assert.equal(trampoline.length, 182);
assert.equal(trampoline[0], 0xFA);
assert.equal(trampoline[1], 0xFC);
assert.equal(trampoline.at(-1), 0);

const source = createKernelPlatformSource({ smoke: true, enableSmp: true, preferIoApic: true });
assert.match(source, /unsafe fn memory_init_from_multiboot/);
assert.match(source, /pub unsafe fn free_frame/);
assert.match(source, /pub unsafe fn map_page/);
assert.match(source, /pub unsafe fn heap_free/);
assert.match(source, /unsafe fn parse_madt/);
assert.match(source, /unsafe fn ioapic_route_isa_irq/);
assert.match(source, /unsafe fn smp_start_all/);
assert.match(source, /@link_name\("kura_ap_main"\)/);
assert.match(source, /memory\.write<u8>\(AP_TRAMPOLINE_BASE \+ 181, 0\)/);

const llvm = compileNativeSystemSource(source, { file: 'kernel-platform.kr' });
assert.match(llvm, /define .*@map_page/);
assert.match(llvm, /define .*@free_frame/);
assert.match(llvm, /define .*@heap_free/);
assert.match(llvm, /define .*@kura_ap_main/);
assert.match(llvm, /define x86_intrcc void @page_fault/);
assert.match(llvm, /asm sideeffect "invlpg/);
assert.match(llvm, /asm sideeffect "wrmsr/);

const plan = createNativeBuildPlan({
  input: 'kernel-platform.kr',
  outDir: '/tmp/kura-kernel-platform-test',
  entry: 'kura_boot_entry',
});
const fakeTools = {
  clang: { command: 'clang', version: 'test' },
  llc: null,
  assembler: null,
  linker: { command: 'ld.lld', version: 'test' },
  qemu: null,
  grub: null,
  objcopy: null,
};
const build = await buildBootableKernel(source, { plan, tools: fakeTools, dryRun: true });
assert.equal(build.objectResult.step.dryRun, true);
assert.equal(build.bootstrapResult.step.dryRun, true);
assert.equal(build.linkResult.step.dryRun, true);

console.log('system kernel platform tests passed');
