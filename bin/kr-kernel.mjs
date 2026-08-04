#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  buildBootableKernel,
  createApTrampolineBytes,
  createBootableIso,
  createKernelPlatformManifest,
  createKernelPlatformSource,
  createNativeBuildPlan,
  detectNativeToolchain,
  formatToolchainError,
  runNativeKernelQemu,
  runNativeKernelQemuSmoke,
} from '../lib/system-native.mjs';

function usage() {
  return `Kura kernel platform tool

Usage:
  kr-kernel manifest [--json]
  kr-kernel emit [-o kernel.kr] [--smoke] [--pic] [--no-smp]
  kr-kernel init <directory> [--force] [--smoke] [--pic] [--no-smp]
  kr-kernel build <kernel.kr> [--out-dir <dir>] [--dry-run]
  kr-kernel build-generated [--out-dir <dir>] [--smoke] [--pic] [--no-smp] [--dry-run]
  kr-kernel smoke [kernel.kr] [--out-dir <dir>] [--cpus <n>] [--memory <MiB>] [--timeout-ms <ms>] [--dry-run]
  kr-kernel run <kernel.elf|kernel.iso> [--cpus <n>] [--memory <MiB>] [--timeout-ms <ms>]
  kr-kernel trampoline [-o ap-trampoline.bin]
  kr-kernel toolchain [--json]

The generated platform includes Multiboot2 RAM discovery, reusable physical frames,
four-level page mapping, a coalescing heap, ACPI MADT, IOAPIC routing, and x86_64 SMP startup.`;
}

function parseArguments(argv) {
  const positional = [];
  const options = {
    output: null,
    outDir: null,
    json: false,
    dryRun: false,
    smoke: false,
    force: false,
    preferIoApic: true,
    enableSmp: true,
    memory: 256,
    cpus: 4,
    timeoutMs: 20000,
    smokeExitCode: 0x10,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '-o' || argument === '--output') options.output = argv[++index];
    else if (argument === '--out-dir') options.outDir = argv[++index];
    else if (argument === '--memory') options.memory = Number(argv[++index]);
    else if (argument === '--cpus') options.cpus = Number(argv[++index]);
    else if (argument === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (argument === '--smoke-exit-code') options.smokeExitCode = Number(argv[++index]);
    else if (argument === '--json') options.json = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--smoke') options.smoke = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--pic') options.preferIoApic = false;
    else if (argument === '--ioapic') options.preferIoApic = true;
    else if (argument === '--no-smp') options.enableSmp = false;
    else if (argument === '--smp') options.enableSmp = true;
    else if (argument === '-h' || argument === '--help') options.help = true;
    else positional.push(argument);
  }
  if (!Number.isInteger(options.cpus) || options.cpus < 1 || options.cpus > 256) throw new Error('--cpus must be between 1 and 256.');
  if (!Number.isFinite(options.memory) || options.memory < 32 || options.memory > 65536) throw new Error('--memory must be between 32 and 65536 MiB.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new Error('--timeout-ms must be zero or greater.');
  if (!Number.isInteger(options.smokeExitCode) || options.smokeExitCode < 0 || options.smokeExitCode > 127) throw new Error('--smoke-exit-code must be between 0 and 127.');
  return { command: positional[0], files: positional.slice(1), options };
}

function sourceOptions(options, extra = {}) {
  return {
    smoke: options.smoke,
    preferIoApic: options.preferIoApic,
    enableSmp: options.enableSmp,
    smokeExitCode: options.smokeExitCode,
    ...extra,
  };
}

function toolchainText(tools) {
  const row = (name, item) => `${name.padEnd(12)} ${item?.version ?? 'not found'}`;
  return [
    row('clang', tools.clang),
    row('llc', tools.llc),
    row('assembler', tools.assembler),
    row('linker', tools.linker),
    row('grub', tools.grub),
    row('qemu', tools.qemu),
    '',
    `Bootable ELF: ${tools.canBuildBootableElf ? 'ready' : 'unavailable'}`,
    `Bootable ISO: ${tools.canBuildIso ? 'ready' : 'unavailable'}`,
    `QEMU:        ${tools.canRunQemu ? 'ready' : 'unavailable'}`,
  ].join('\n');
}

function projectReadme(options) {
  return `# Kura x86_64 kernel

This project uses Kura's advanced kernel platform runtime.

## Build

\`\`\`bash
kr-kernel build kernel.kr --out-dir build/system
\`\`\`

## QEMU smoke boot

\`\`\`bash
kr-kernel smoke kernel.kr --out-dir build/smoke --cpus ${options.cpus}
\`\`\`

The runtime discovers RAM from Multiboot2, parses ACPI MADT, prefers IOAPIC routing,
and starts application processors when SMP is enabled.
`;
}

async function createProject(directory, options) {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true });
  const flag = options.force ? 'w' : 'wx';
  const source = createKernelPlatformSource(sourceOptions(options));
  const config = {
    target: 'x86_64-unknown-none',
    bootEntry: 'kura_boot_entry',
    kernelEntry: 'kernel_main',
    memoryDiscovery: 'multiboot2',
    interruptController: options.preferIoApic ? 'ioapic-with-pic-fallback' : 'pic8259',
    smp: options.enableSmp,
    smoke: options.smoke,
  };
  try {
    await writeFile(path.join(root, 'kernel.kr'), source, { encoding: 'utf8', flag });
    await writeFile(path.join(root, 'kura-kernel.json'), `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag });
    await writeFile(path.join(root, 'README.md'), projectReadme(options), { encoding: 'utf8', flag });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`A kernel project already exists in ${root}. Use --force to replace it.`);
    throw error;
  }
  return root;
}

async function buildSource(source, input, options) {
  const plan = createNativeBuildPlan({
    input,
    outDir: options.outDir,
    entry: 'kura_boot_entry',
    kernelEntry: 'kernel_main',
  });
  const result = await buildBootableKernel(source, {
    plan,
    file: input,
    dryRun: options.dryRun,
  });
  return { plan, result };
}

async function main() {
  const { command, files, options } = parseArguments(process.argv.slice(2));
  if (!command || options.help) {
    console.log(usage());
    return;
  }

  if (command === 'manifest') {
    const manifest = createKernelPlatformManifest();
    if (options.json) console.log(JSON.stringify(manifest, null, 2));
    else {
      console.log(`target: ${manifest.target}`);
      console.log(`identity map: ${manifest.identityMappedBytes} bytes`);
      console.log(`tracked RAM: ${manifest.maxTrackedPhysicalBytes} bytes`);
      for (const region of manifest.regions) {
        console.log(`${region.name.padEnd(20)} 0x${region.start.toString(16)}..0x${region.end.toString(16)}`);
      }
    }
    return;
  }

  if (command === 'emit') {
    const source = createKernelPlatformSource(sourceOptions(options));
    if (options.output) {
      await writeFile(options.output, source, 'utf8');
      console.log(`wrote ${options.output}`);
    } else process.stdout.write(source);
    return;
  }

  if (command === 'init') {
    const root = await createProject(files[0] ?? 'kura-os', options);
    console.log(`created ${root}`);
    return;
  }

  if (command === 'build') {
    const file = files[0];
    if (!file) throw new Error('build requires a kernel.kr file.');
    const source = await readFile(file, 'utf8');
    const { plan, result } = await buildSource(source, file, options);
    if (options.dryRun) console.log(JSON.stringify({
      object: result.objectResult.step,
      bootstrap: result.bootstrapResult.step,
      link: result.linkResult.step,
      outputs: plan,
    }, null, 2));
    else console.log(`wrote ${plan.elf}`);
    return;
  }

  if (command === 'build-generated') {
    const outDir = path.resolve(options.outDir ?? 'build/kernel-platform');
    await mkdir(outDir, { recursive: true });
    const input = path.join(outDir, 'kernel.kr');
    const source = createKernelPlatformSource(sourceOptions(options));
    if (!options.dryRun) await writeFile(input, source, 'utf8');
    const { plan, result } = await buildSource(source, input, { ...options, outDir });
    if (options.dryRun) console.log(JSON.stringify({
      object: result.objectResult.step,
      bootstrap: result.bootstrapResult.step,
      link: result.linkResult.step,
      outputs: plan,
    }, null, 2));
    else console.log(`wrote ${plan.elf}`);
    return;
  }

  if (command === 'smoke') {
    const tools = detectNativeToolchain();
    const outDir = path.resolve(options.outDir ?? 'build/kernel-smoke');
    await mkdir(outDir, { recursive: true });
    const supplied = files[0];
    const input = supplied ? path.resolve(supplied) : path.join(outDir, 'kernel-smoke.kr');
    const source = supplied
      ? await readFile(input, 'utf8')
      : createKernelPlatformSource(sourceOptions(options, { smoke: true }));
    if (!supplied && !options.dryRun) await writeFile(input, source, 'utf8');
    const plan = createNativeBuildPlan({ input, outDir, entry: 'kura_boot_entry', kernelEntry: 'kernel_main' });
    const build = await buildBootableKernel(source, { plan, tools, file: input, dryRun: options.dryRun });
    const iso = await createBootableIso(plan.elf, { plan, tools, dryRun: options.dryRun, title: 'Kura SMP Smoke' });
    const run = await runNativeKernelQemuSmoke(plan.iso, {
      tools,
      cpus: options.cpus,
      memory: options.memory,
      timeoutMs: options.timeoutMs,
      smokeExitCode: options.smokeExitCode,
      dryRun: options.dryRun,
    });
    if (options.dryRun) console.log(JSON.stringify({ build, iso: iso.step, qemu: run, outputs: plan }, null, 2));
    else console.log(`QEMU platform smoke passed with ${options.cpus} CPU(s): ${plan.iso}`);
    return;
  }

  if (command === 'run') {
    const file = files[0];
    if (!file) throw new Error('run requires a kernel ELF or ISO.');
    await runNativeKernelQemu(path.resolve(file), {
      cpus: options.cpus,
      memory: options.memory,
      timeoutMs: options.timeoutMs,
      inherit: true,
      dryRun: options.dryRun,
    });
    return;
  }

  if (command === 'trampoline') {
    const bytes = createApTrampolineBytes();
    const output = options.output ?? 'ap-trampoline.bin';
    await writeFile(output, bytes);
    console.log(`wrote ${output} (${bytes.length} bytes)`);
    return;
  }

  if (command === 'toolchain') {
    const tools = detectNativeToolchain();
    console.log(options.json ? JSON.stringify(tools, null, 2) : toolchainText(tools));
    return;
  }

  throw new Error(`Unknown command '${command}'.\n\n${usage()}`);
}

main().catch(error => {
  console.error(formatToolchainError(error));
  process.exitCode = 1;
});
