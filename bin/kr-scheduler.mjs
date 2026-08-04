#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  buildSchedulerKernel,
  createBootableIso,
  createContextSwitchAssembly,
  createKernelSchedulerManifest,
  createKernelSchedulerSource,
  createSchedulerBuildPlan,
  detectNativeToolchain,
  formatToolchainError,
  runNativeKernelQemu,
  runNativeKernelQemuSmoke,
} from '../lib/system-native.mjs';

function usage() {
  return `Kura kernel scheduler tool

Usage:
  kr-scheduler manifest [--json]
  kr-scheduler emit [-o kernel.kr] [--smoke] [--pic] [--no-smp]
  kr-scheduler init <directory> [--force] [--smoke] [--pic] [--no-smp]
  kr-scheduler build <kernel.kr> [--out-dir <dir>] [--dry-run]
  kr-scheduler build-generated [--out-dir <dir>] [--smoke] [--dry-run]
  kr-scheduler smoke [kernel.kr] [--out-dir <dir>] [--cpus <n>] [--memory <MiB>] [--dry-run]
  kr-scheduler run <kernel.elf|kernel.iso> [--cpus <n>] [--memory <MiB>]
  kr-scheduler context-switch [-o kura-context-switch.S]
  kr-scheduler toolchain [--json]

The generated kernel includes ticket spinlocks, per-CPU state, HPET/LAPIC timer
calibration, slab caches, kernel threads, context switching, sleep/wake, and a
four-priority round-robin scheduler with timer-driven reschedule requests.`;
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
    timerHz: 100,
    quantum: 5,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '-o' || argument === '--output') options.output = argv[++index];
    else if (argument === '--out-dir') options.outDir = argv[++index];
    else if (argument === '--memory') options.memory = Number(argv[++index]);
    else if (argument === '--cpus') options.cpus = Number(argv[++index]);
    else if (argument === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (argument === '--smoke-exit-code') options.smokeExitCode = Number(argv[++index]);
    else if (argument === '--timer-hz') options.timerHz = Number(argv[++index]);
    else if (argument === '--quantum') options.quantum = Number(argv[++index]);
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
  if (!Number.isInteger(options.timerHz) || options.timerHz < 10 || options.timerHz > 10000) throw new Error('--timer-hz must be between 10 and 10000.');
  if (!Number.isInteger(options.quantum) || options.quantum < 1 || options.quantum > 1000) throw new Error('--quantum must be between 1 and 1000 ticks.');
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
    timerHz: options.timerHz,
    quantum: options.quantum,
    ...extra,
  };
}

function projectReadme(options) {
  return `# Kura scheduled kernel

Build the ELF kernel:

\`\`\`bash
kr-scheduler build kernel.kr --out-dir build/system
\`\`\`

Run the scheduler smoke kernel:

\`\`\`bash
kr-scheduler smoke kernel.kr --out-dir build/smoke --cpus ${options.cpus}
\`\`\`

The runtime provides cooperative kernel context switching with timer-driven
reschedule requests. Threads hand off at scheduler yield, sleep, block, and
explicit preemption points.
`;
}

async function createProject(directory, options) {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true });
  const flag = options.force ? 'w' : 'wx';
  const source = createKernelSchedulerSource(sourceOptions(options));
  const config = {
    target: 'x86_64-unknown-none',
    kernelEntry: 'kernel_main',
    bootEntry: 'kura_boot_entry',
    timerHz: options.timerHz,
    quantum: options.quantum,
    priorities: 4,
    contextSwitch: 'callee-saved-x86_64',
    preemption: 'timer-requested-safe-handoff',
    smp: options.enableSmp,
  };
  try {
    await writeFile(path.join(root, 'kernel.kr'), source, { encoding: 'utf8', flag });
    await writeFile(path.join(root, 'kura-scheduler.json'), `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag });
    await writeFile(path.join(root, 'README.md'), projectReadme(options), { encoding: 'utf8', flag });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`A scheduler kernel already exists in ${root}. Use --force to replace it.`);
    throw error;
  }
  return root;
}

async function buildSource(source, input, options) {
  const plan = createSchedulerBuildPlan({
    input,
    outDir: options.outDir,
    entry: 'kura_boot_entry',
    kernelEntry: 'kernel_main',
  });
  const result = await buildSchedulerKernel(source, { plan, file: input, dryRun: options.dryRun });
  return { plan, result };
}

async function main() {
  const { command, files, options } = parseArguments(process.argv.slice(2));
  if (!command || options.help) {
    console.log(usage());
    return;
  }

  if (command === 'manifest') {
    const manifest = createKernelSchedulerManifest();
    if (options.json) console.log(JSON.stringify(manifest, null, 2));
    else {
      console.log(`target: ${manifest.target}`);
      console.log(`max tasks: ${manifest.maxTasks}`);
      console.log(`max CPUs: ${manifest.maxCpus}`);
      console.log(`priorities: ${manifest.priorities}`);
      console.log(`quantum: ${manifest.defaultQuantum}`);
      for (const region of manifest.regions) {
        console.log(`${region.name.padEnd(22)} 0x${region.start.toString(16)}..0x${region.end.toString(16)}`);
      }
    }
    return;
  }

  if (command === 'emit') {
    const source = createKernelSchedulerSource(sourceOptions(options));
    if (options.output) {
      await writeFile(options.output, source, 'utf8');
      console.log(`wrote ${options.output}`);
    } else process.stdout.write(source);
    return;
  }

  if (command === 'init') {
    const root = await createProject(files[0] ?? 'kura-scheduled-os', options);
    console.log(`created ${root}`);
    return;
  }

  if (command === 'build' || command === 'build-generated') {
    let input = files[0];
    let source;
    if (command === 'build') {
      if (!input) throw new Error('build requires a kernel.kr file.');
      input = path.resolve(input);
      source = await readFile(input, 'utf8');
    } else {
      const outDir = path.resolve(options.outDir ?? 'build/kernel-scheduler');
      await mkdir(outDir, { recursive: true });
      input = path.join(outDir, 'kernel.kr');
      source = createKernelSchedulerSource(sourceOptions(options));
      if (!options.dryRun) await writeFile(input, source, 'utf8');
      options.outDir = outDir;
    }
    const { plan, result } = await buildSource(source, input, options);
    if (options.dryRun) console.log(JSON.stringify({
      object: result.objectResult.step,
      bootstrap: result.bootstrapResult.step,
      contextSwitch: result.schedulerResult.step,
      link: result.linkResult.step,
      outputs: plan,
    }, null, 2));
    else console.log(`wrote ${plan.elf}`);
    return;
  }

  if (command === 'smoke') {
    const tools = detectNativeToolchain();
    const outDir = path.resolve(options.outDir ?? 'build/scheduler-smoke');
    await mkdir(outDir, { recursive: true });
    const supplied = files[0];
    const input = supplied ? path.resolve(supplied) : path.join(outDir, 'kernel-smoke.kr');
    const source = supplied
      ? await readFile(input, 'utf8')
      : createKernelSchedulerSource(sourceOptions(options, { smoke: true }));
    if (!supplied && !options.dryRun) await writeFile(input, source, 'utf8');
    const plan = createSchedulerBuildPlan({ input, outDir, entry: 'kura_boot_entry', kernelEntry: 'kernel_main' });
    const build = await buildSchedulerKernel(source, { plan, tools, file: input, dryRun: options.dryRun });
    const iso = await createBootableIso(plan.elf, { plan, tools, dryRun: options.dryRun, title: 'Kura Scheduler Smoke' });
    const run = await runNativeKernelQemuSmoke(plan.iso, {
      tools,
      cpus: options.cpus,
      memory: options.memory,
      timeoutMs: options.timeoutMs,
      smokeExitCode: options.smokeExitCode,
      dryRun: options.dryRun,
    });
    if (options.dryRun) console.log(JSON.stringify({ build, iso: iso.step, qemu: run, outputs: plan }, null, 2));
    else console.log(`QEMU scheduler smoke passed with ${options.cpus} CPU(s): ${plan.iso}`);
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

  if (command === 'context-switch') {
    const source = createContextSwitchAssembly();
    if (options.output) {
      await writeFile(options.output, source, 'utf8');
      console.log(`wrote ${options.output}`);
    } else process.stdout.write(source);
    return;
  }

  if (command === 'toolchain') {
    const tools = detectNativeToolchain();
    console.log(options.json ? JSON.stringify(tools, null, 2) : [
      `clang: ${tools.clang?.version ?? 'not found'}`,
      `assembler: ${tools.assembler?.version ?? 'not found'}`,
      `linker: ${tools.linker?.version ?? 'not found'}`,
      `qemu: ${tools.qemu?.version ?? 'not found'}`,
      `scheduler ELF: ${tools.canBuildBootableElf ? 'ready' : 'unavailable'}`,
    ].join('\n'));
    return;
  }

  throw new Error(`Unknown command '${command}'.\n\n${usage()}`);
}

main().catch(error => {
  console.error(formatToolchainError(error));
  process.exitCode = 1;
});
