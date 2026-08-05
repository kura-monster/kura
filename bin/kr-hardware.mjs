#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHardwareManifest, createHardwareKernelSource, createCompleteHardwareKernelSource, buildHardwareKernel, hardwareSmokeTest, runHardwareQemuSmoke } from '../lib/system-hardware.mjs';
import { createHardwareRuntimeManifest, hardwareRuntimeSmokeTest } from '../lib/system-hardware-runtime.mjs';
import { createPlatformFirmwareManifest, platformFirmwareSmokeTest } from '../lib/system-platform-firmware.mjs';

const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
const take = (name, fallback = null) => { const index = args.indexOf(name); if (index < 0) return fallback; const value = args[index + 1]; args.splice(index, 2); return value; };
const flag = name => { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; };
const output = take('-o', take('--output'));
const outDir = take('--out-dir', 'build/hardware');
const json = flag('--json');
const dryRun = flag('--dry-run');
const timeoutMs = Number(take('--timeout-ms', '30000'));
const memory = Number(take('--memory', '256'));
const cpus = Number(take('--cpus', '2'));

function help() {
  console.log(`Kura hardware-driver foundation\n\nkr-hardware manifest [--json]\nkr-hardware emit -o hardware.kr\nkr-hardware kernel -o kernel-hardware.kr\nkr-hardware build [--out-dir build/hardware] [--dry-run]\nkr-hardware smoke\nkr-hardware runtime-manifest [--json]\nkr-hardware runtime-smoke\nkr-hardware firmware-manifest [--json]\nkr-hardware firmware-smoke\nkr-hardware qemu-smoke [--out-dir build/hardware-qemu-smoke] [--timeout-ms 30000]\n`);
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
  } else if (command === 'firmware-manifest') {
    const manifest = createPlatformFirmwareManifest();
    console.log(json ? JSON.stringify(manifest, null, 2) : 'ACPI RSDP/RSDT/XSDT + MCFG ECAM + DMAR/IVRS IOMMU discovery + MSI-X mapping');
  } else if (command === 'firmware-smoke') {
    console.log(JSON.stringify(await platformFirmwareSmokeTest(), (_, value) => typeof value === 'bigint' ? `0x${value.toString(16)}` : value, 2));
  } else if (command === 'qemu-smoke') {
    const result = await runHardwareQemuSmoke({ outDir: resolve(outDir), timeoutMs, memory, cpus, dryRun });
    const summary = { iso: result.outputs.iso, elf: result.outputs.elf, dryRun, checkpoint: result.checkpoint, qemu: result.run ? { code: result.run.code, stdout: result.run.stdout, stderr: result.run.stderr, timedOut: result.run.timedOut, commandText: result.run.commandText } : null };
    console.log(json || dryRun ? JSON.stringify(summary, null, 2) : `QEMU hardware smoke passed: ${result.outputs.iso}`);
  } else throw new Error(`Unknown command '${command}'.`);
} catch (error) {
  console.error(error.stack ?? error.message);
  if (error.command) console.error(`Command: ${error.command}`);
  if (error.stdout) console.error(`stdout:\n${error.stdout}`);
  if (error.stderr) console.error(`stderr:\n${error.stderr}`);
  process.exitCode = 1;
}
