#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHardwareManifest, createHardwareKernelSource, createCompleteHardwareKernelSource, buildHardwareKernel, hardwareSmokeTest } from '../lib/system-hardware.mjs';
import { createHardwareRuntimeManifest, hardwareRuntimeSmokeTest } from '../lib/system-hardware-runtime.mjs';

const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
const take = (name, fallback = null) => { const index = args.indexOf(name); if (index < 0) return fallback; const value = args[index + 1]; args.splice(index, 2); return value; };
const flag = name => { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; };
const output = take('-o', take('--output'));
const outDir = take('--out-dir', 'build/hardware');
const json = flag('--json');
const dryRun = flag('--dry-run');

function help() {
  console.log(`Kura hardware-driver foundation\n\nkr-hardware manifest [--json]\nkr-hardware emit -o hardware.kr\nkr-hardware kernel -o kernel-hardware.kr\nkr-hardware build [--out-dir build/hardware] [--dry-run]\nkr-hardware smoke\nkr-hardware runtime-manifest [--json]\nkr-hardware runtime-smoke\n`);
}

try {
  if (command === 'help' || command === '--help' || command === '-h') { help(); process.exit(0); }
  if (command === 'manifest') {
    const manifest = createHardwareManifest();
    console.log(json ? JSON.stringify(manifest, null, 2) : `Architecture: ${manifest.architecture}\nNVMe queue depth: ${manifest.layout.nvmeQueueDepth}\nxHCI TRBs: ${manifest.layout.xhciRingTrbs}\nVirtIO queue: ${manifest.layout.virtioQueueSize}`);
  } else if (command === 'emit' || command === 'kernel') {
    const destination = resolve(output ?? (command === 'emit' ? 'hardware.kr' : 'kernel-hardware.kr'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, command === 'emit' ? createHardwareKernelSource() : createCompleteHardwareKernelSource(), 'utf8');
    console.log(destination);
  } else if (command === 'build') {
    const result = await buildHardwareKernel(null, { outDir: resolve(outDir), dryRun });
    console.log(JSON.stringify({ outDir: result.plan.outDir, elf: result.plan.elf, dryRun, link: result.linkResult }, null, 2));
  } else if (command === 'smoke') {
    console.log(JSON.stringify(await hardwareSmokeTest(), null, 2));
  } else if (command === 'runtime-manifest') {
    const manifest = createHardwareRuntimeManifest();
    console.log(json ? JSON.stringify(manifest, null, 2) : `PCI: recursive enumeration + BAR assignment\nDMA: contiguous allocator + IOMMU domains\nInterrupts: MSI/MSI-X + vector ownership`);
  } else if (command === 'runtime-smoke') {
    console.log(JSON.stringify(await hardwareRuntimeSmokeTest(), (_, value) => typeof value === 'bigint' ? `0x${value.toString(16)}` : value, 2));
  } else throw new Error(`Unknown command '${command}'.`);
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
