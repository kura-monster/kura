#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  buildBootableKernel,
  buildNativeKernel,
  compileNativeSystemSource,
  createBootableIso,
  createKernelArchitectureManifest,
  createKernelRuntimeSource,
  createNativeBuildPlan,
  createNativeLinkerScript,
  createX86_64BootstrapAssembly,
  describeNativeLayout,
  detectNativeToolchain,
  emitNativeObject,
  formatToolchainError,
  linkNativeElf,
  parseNativeSystemSource,
  runNativeKernelQemu,
  runNativeKernelQemuSmoke,
} from '../lib/system-native.mjs';

function usage() {
  return `Kura native system compiler

Usage:
  kr-system check <file.kr> [--target <triple>]
  kr-system emit-llvm <file.kr> [-o <file.ll>] [--target <triple>]
  kr-system emit-object <file.kr> [-o <file.o>] [--dry-run]
  kr-system link-elf <file.o...> [-o <kernel.elf>] [--entry <symbol>] [--dry-run]
  kr-system build <file.kr> [--out-dir <dir>] [--entry <symbol>] [--dry-run]
  kr-system build-bootable <file.kr> [--out-dir <dir>] [--dry-run]
  kr-system emit-iso <file.elf> [-o <file.iso>] [--dry-run]
  kr-system run-qemu <file.elf|file.iso> [--memory <MiB>] [--timeout-ms <ms>]
  kr-system qemu-smoke <file.kr> [--out-dir <dir>] [--timeout-ms <ms>] [--dry-run]
  kr-system linker-script [-o <file.ld>] [--entry <symbol>]
  kr-system bootstrap [-o <kura-bootstrap.S>]
  kr-system architecture [--json]
  kr-system kernel-runtime [-o <kernel.kr>] [--smoke] [--apic]
  kr-system kernel-init <directory> [--smoke] [--apic] [--force]
  kr-system layout <file.kr> [--json]
  kr-system ast <file.kr>
  kr-system toolchain [--json]

Current target: x86_64-unknown-none`;
}

function parseArguments(argv) {
  const positional = [];
  const options = {
    output: null,
    target: null,
    outDir: null,
    entry: 'kernel_main',
    kernelEntry: 'kernel_main',
    json: false,
    help: false,
    dryRun: false,
    smoke: false,
    apic: false,
    force: false,
    memory: 128,
    timeoutMs: 0,
    baseAddress: '1M',
    smokeExitCode: 0x10,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '-o' || argument === '--output') options.output = argv[++index];
    else if (argument === '--target') options.target = argv[++index];
    else if (argument === '--out-dir') options.outDir = argv[++index];
    else if (argument === '--entry') options.entry = argv[++index];
    else if (argument === '--kernel-entry') options.kernelEntry = argv[++index];
    else if (argument === '--memory') options.memory = Number(argv[++index]);
    else if (argument === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (argument === '--base-address') options.baseAddress = argv[++index];
    else if (argument === '--smoke-exit-code') options.smokeExitCode = Number(argv[++index]);
    else if (argument === '--json') options.json = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--smoke') options.smoke = true;
    else if (argument === '--apic') options.apic = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '-h' || argument === '--help') options.help = true;
    else positional.push(argument);
  }
  if (!Number.isFinite(options.memory) || options.memory < 16 || options.memory > 65536) throw new Error('--memory must be between 16 and 65536 MiB.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new Error('--timeout-ms must be zero or greater.');
  if (!Number.isInteger(options.smokeExitCode) || options.smokeExitCode < 0 || options.smokeExitCode > 127) throw new Error('--smoke-exit-code must be between 0 and 127.');
  return { command: positional[0], files: positional.slice(1), options };
}

function print(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function toolchainText(tools) {
  const row = (name, item) => `${name.padEnd(14)} ${item ? item.version : 'not found'}`;
  return [
    row('clang', tools.clang),
    row('llc', tools.llc),
    row('assembler', tools.assembler),
    row('linker', tools.linker),
    row('qemu', tools.qemu),
    row('grub', tools.grub),
    row('objcopy', tools.objcopy),
    '',
    `Object:       ${tools.canEmitObject ? 'ready' : 'unavailable'}`,
    `Bootstrap:    ${tools.canAssembleBootstrap ? 'ready' : 'unavailable'}`,
    `ELF:          ${tools.canLinkElf ? 'ready' : 'unavailable'}`,
    `Bootable ELF: ${tools.canBuildBootableElf ? 'ready' : 'unavailable'}`,
    `QEMU:         ${tools.canRunQemu ? 'ready' : 'unavailable'}`,
    `ISO:          ${tools.canBuildIso ? 'ready' : 'unavailable'}`,
  ].join('\n');
}

function kernelReadme() {
  return `# Kura kernel project

Build the freestanding ELF image:

\`\`\`bash
kr-system build-bootable kernel.kr --out-dir build/system
\`\`\`

Create a GRUB ISO:

\`\`\`bash
kr-system emit-iso build/system/kernel.elf -o build/system/kernel.iso
\`\`\`

Run an automated QEMU smoke boot:

\`\`\`bash
kr-system qemu-smoke kernel.kr --out-dir build/smoke
\`\`\`
`;
}

async function writeKernelProject(directory, options) {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true });
  const flag = options.force ? 'w' : 'wx';
  const source = createKernelRuntimeSource({
    smoke: options.smoke,
    enableApic: options.apic,
    smokeExitCode: options.smokeExitCode,
  });
  try {
    await writeFile(path.join(root, 'kernel.kr'), source, { encoding: 'utf8', flag });
    await writeFile(path.join(root, 'README.md'), kernelReadme(), { encoding: 'utf8', flag });
    await writeFile(path.join(root, 'kura-kernel.json'), `${JSON.stringify({
      target: 'x86_64-unknown-none',
      entry: 'kernel_main',
      bootEntry: 'kura_boot_entry',
      interruptController: options.apic ? 'xapic' : 'pic8259',
      smoke: options.smoke,
    }, null, 2)}\n`, { encoding: 'utf8', flag });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Kernel project file already exists in ${root}. Use --force to replace it.`);
    throw error;
  }
  return root;
}

async function main() {
  const { command, files, options } = parseArguments(process.argv.slice(2));
  if (options.help || !command) { console.log(usage()); return; }

  const file = files[0];
  const compileOptions = { file, target: options.target ?? undefined };
  switch (command) {
    case 'check': {
      if (!file) throw new Error('check requires a .kr file.');
      const source = await readFile(file, 'utf8');
      compileNativeSystemSource(source, compileOptions);
      console.log(`${file}: native system check passed`);
      return;
    }
    case 'emit-llvm': {
      if (!file) throw new Error('emit-llvm requires a .kr file.');
      const source = await readFile(file, 'utf8');
      const llvm = compileNativeSystemSource(source, compileOptions);
      if (options.output) { await writeFile(options.output, llvm, 'utf8'); console.log(`wrote ${options.output}`); }
      else process.stdout.write(llvm);
      return;
    }
    case 'emit-object': {
      if (!file) throw new Error('emit-object requires a .kr file.');
      const source = await readFile(file, 'utf8');
      const requested = options.output ? path.resolve(options.output) : null;
      const plan = createNativeBuildPlan({ input: file, outDir: options.outDir, target: options.target, entry: options.entry });
      if (requested) plan.object = requested;
      const result = await emitNativeObject(source, { plan, file, dryRun: options.dryRun });
      print(options.dryRun ? result.step : `wrote ${result.plan.object}`, options.json);
      return;
    }
    case 'link-elf': {
      if (!files.length) throw new Error('link-elf requires one or more .o files.');
      const first = path.resolve(files[0]);
      const plan = createNativeBuildPlan({ input: first, outDir: options.outDir ?? path.dirname(first), entry: options.entry });
      if (options.output) plan.elf = path.resolve(options.output);
      const result = await linkNativeElf(files.map(item => path.resolve(item)), { plan, entry: options.entry, baseAddress: options.baseAddress, dryRun: options.dryRun });
      print(options.dryRun ? result.step : `wrote ${result.plan.elf}`, options.json);
      return;
    }
    case 'build': {
      if (!file) throw new Error('build requires a .kr file.');
      const source = await readFile(file, 'utf8');
      const plan = createNativeBuildPlan({ input: file, outDir: options.outDir, target: options.target, entry: options.entry });
      if (options.output) plan.elf = path.resolve(options.output);
      const result = await buildNativeKernel(source, { plan, file, dryRun: options.dryRun, baseAddress: options.baseAddress });
      if (options.dryRun) print({ object: result.objectResult.step, link: result.linkResult.step, outputs: result.plan }, options.json);
      else console.log(`wrote ${result.plan.elf}`);
      return;
    }
    case 'build-bootable': {
      if (!file) throw new Error('build-bootable requires a .kr file.');
      const source = await readFile(file, 'utf8');
      const plan = createNativeBuildPlan({
        input: file,
        outDir: options.outDir,
        target: options.target,
        entry: 'kura_boot_entry',
        kernelEntry: options.kernelEntry,
      });
      if (options.output) plan.elf = path.resolve(options.output);
      const result = await buildBootableKernel(source, { plan, file, dryRun: options.dryRun, baseAddress: options.baseAddress });
      if (options.dryRun) print({
        object: result.objectResult.step,
        bootstrap: result.bootstrapResult.step,
        link: result.linkResult.step,
        outputs: result.plan,
      }, options.json);
      else console.log(`wrote ${result.plan.elf}`);
      return;
    }
    case 'emit-iso': {
      if (!file) throw new Error('emit-iso requires a kernel ELF file.');
      const plan = createNativeBuildPlan({ input: file, outDir: options.outDir ?? path.dirname(path.resolve(file)), entry: options.entry });
      if (options.output) plan.iso = path.resolve(options.output);
      const result = await createBootableIso(path.resolve(file), { plan, dryRun: options.dryRun });
      print(options.dryRun ? result.step : `wrote ${result.plan.iso}`, options.json);
      return;
    }
    case 'run-qemu': {
      if (!file) throw new Error('run-qemu requires a kernel ELF or ISO file.');
      await runNativeKernelQemu(path.resolve(file), { memory: options.memory, timeoutMs: options.timeoutMs, inherit: true, dryRun: options.dryRun });
      return;
    }
    case 'qemu-smoke': {
      if (!file) throw new Error('qemu-smoke requires a .kr file.');
      const source = await readFile(file, 'utf8');
      const plan = createNativeBuildPlan({
        input: file,
        outDir: options.outDir,
        entry: 'kura_boot_entry',
        kernelEntry: options.kernelEntry,
      });
      const tools = detectNativeToolchain();
      const build = await buildBootableKernel(source, { plan, tools, file, dryRun: options.dryRun, baseAddress: options.baseAddress });
      const iso = await createBootableIso(plan.elf, { plan, tools, dryRun: options.dryRun, title: 'Kura QEMU Smoke' });
      const run = await runNativeKernelQemuSmoke(plan.iso, {
        tools,
        memory: options.memory,
        timeoutMs: options.timeoutMs || 15000,
        smokeExitCode: options.smokeExitCode,
        dryRun: options.dryRun,
      });
      if (options.dryRun) print({ build, iso: iso.step, qemu: run, outputs: plan }, options.json);
      else console.log(`QEMU smoke boot passed: ${plan.iso}`);
      return;
    }
    case 'linker-script': {
      const script = createNativeLinkerScript({ entry: options.entry, baseAddress: options.baseAddress });
      if (options.output) { await writeFile(options.output, script, 'utf8'); console.log(`wrote ${options.output}`); }
      else process.stdout.write(script);
      return;
    }
    case 'bootstrap': {
      const assembly = createX86_64BootstrapAssembly({ kernelEntry: options.kernelEntry, bootEntry: 'kura_boot_entry' });
      if (options.output) { await writeFile(options.output, assembly, 'utf8'); console.log(`wrote ${options.output}`); }
      else process.stdout.write(assembly);
      return;
    }
    case 'architecture': {
      const manifest = createKernelArchitectureManifest();
      if (options.json) print(manifest, true);
      else {
        console.log(`target: ${manifest.target}`);
        console.log(`identity map: ${manifest.identityMappedBytes} bytes`);
        for (const region of manifest.regions) console.log(`${region.name.padEnd(18)} 0x${region.start.toString(16)}..0x${region.end.toString(16)}`);
      }
      return;
    }
    case 'kernel-runtime': {
      const source = createKernelRuntimeSource({ smoke: options.smoke, enableApic: options.apic, smokeExitCode: options.smokeExitCode });
      if (options.output) { await writeFile(options.output, source, 'utf8'); console.log(`wrote ${options.output}`); }
      else process.stdout.write(source);
      return;
    }
    case 'kernel-init': {
      const directory = file ?? 'kura-kernel';
      const root = await writeKernelProject(directory, options);
      console.log(`created ${root}`);
      return;
    }
    case 'layout': {
      if (!file) throw new Error('layout requires a .kr file.');
      const source = await readFile(file, 'utf8');
      const layout = describeNativeLayout(source, compileOptions);
      if (options.json) print(layout, true);
      else {
        console.log(`target: ${layout.target}`);
        for (const struct of layout.structs) {
          console.log(`${struct.name}: size=${struct.size}, align=${struct.alignment}${struct.packed ? ', packed' : ''}`);
          for (const fieldInfo of struct.fields) console.log(`  +${fieldInfo.offset} ${fieldInfo.name}: ${fieldInfo.type} (size=${fieldInfo.size}, align=${fieldInfo.alignment})`);
        }
        for (const constant of layout.constants) console.log(`const ${constant.name}: ${constant.type} = ${constant.value}`);
        for (const global of layout.globals) console.log(`static${global.mutable ? ' mut' : ''} ${global.name}: ${global.type} -> @${global.symbol}`);
      }
      return;
    }
    case 'ast': {
      if (!file) throw new Error('ast requires a .kr file.');
      console.log(JSON.stringify(parseNativeSystemSource(await readFile(file, 'utf8'), compileOptions), null, 2));
      return;
    }
    case 'toolchain': {
      const tools = detectNativeToolchain();
      print(options.json ? tools : toolchainText(tools), options.json);
      return;
    }
    default: throw new Error(`Unknown command '${command}'.\n\n${usage()}`);
  }
}

main().catch(error => {
  console.error(formatToolchainError(error));
  process.exitCode = 1;
});
