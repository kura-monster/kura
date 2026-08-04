// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { compileNativeSystemSource } from './system-native-compiler.mjs';
import { KuraNativeCompileError } from './system-native-common.mjs';

export class KuraNativeToolchainError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'KuraNativeToolchainError';
    this.code = options.code ?? 'KR-TOOLCHAIN-0001';
    this.command = options.command ?? null;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
  }
}

function probe(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? { command, version: (result.stdout || result.stderr).split(/\r?\n/)[0].trim() } : null;
}

export function detectNativeToolchain() {
  const clang = probe('clang');
  const llc = probe('llc');
  const lld = probe('ld.lld');
  const ld = probe('ld', ['--version']);
  const qemu = probe('qemu-system-x86_64', ['--version']);
  const grub = probe('grub-mkrescue', ['--version']);
  const objcopy = probe('llvm-objcopy') ?? probe('objcopy', ['--version']);
  return {
    clang,
    llc,
    linker: lld ?? ld,
    qemu,
    grub,
    objcopy,
    canEmitObject: Boolean(llc || clang),
    canLinkElf: Boolean(lld || ld),
    canRunQemu: Boolean(qemu),
    canBuildIso: Boolean(grub),
  };
}

export function createNativeLinkerScript(options = {}) {
  const entry = options.entry ?? 'kernel_main';
  const baseAddress = options.baseAddress ?? '1M';
  return `OUTPUT_FORMAT(elf64-x86-64)
OUTPUT_ARCH(i386:x86-64)
ENTRY(${entry})

SECTIONS
{
  . = ${baseAddress};

  .multiboot2 ALIGN(8) :
  {
    KEEP(*(.multiboot2))
  }

  .text ALIGN(4K) :
  {
    *(.text .text.*)
  }

  .rodata ALIGN(4K) :
  {
    *(.rodata .rodata.*)
  }

  .data ALIGN(4K) :
  {
    *(.data .data.*)
  }

  .bss ALIGN(4K) :
  {
    *(COMMON)
    *(.bss .bss.*)
  }

  /DISCARD/ :
  {
    *(.eh_frame .eh_frame.*)
    *(.comment)
    *(.note .note.*)
  }
}
`;
}

export function createGrubConfig(options = {}) {
  const title = options.title ?? 'Kura OS';
  const kernelPath = options.kernelPath ?? '/boot/kernel.elf';
  return `set timeout=0
set default=0

menuentry "${title.replaceAll('"', '')}" {
  multiboot2 ${kernelPath}
  boot
}
`;
}

export function createNativeBuildPlan(options = {}) {
  const input = path.resolve(options.input ?? 'kernel.kr');
  const outDir = path.resolve(options.outDir ?? path.join(path.dirname(input), 'build', 'system'));
  const name = options.name ?? path.basename(input, path.extname(input));
  const target = options.target ?? 'x86_64-unknown-none';
  const entry = options.entry ?? 'kernel_main';
  const llvm = path.join(outDir, `${name}.ll`);
  const object = path.join(outDir, `${name}.o`);
  const linkerScript = path.join(outDir, 'kura-linker.ld');
  const elf = path.join(outDir, `${name}.elf`);
  const isoRoot = path.join(outDir, 'iso-root');
  const iso = path.join(outDir, `${name}.iso`);
  return { input, outDir, name, target, entry, llvm, object, linkerScript, elf, isoRoot, iso };
}

function commandText(command, args) {
  return [command, ...args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
}

async function run(command, args, options = {}) {
  if (options.dryRun) return { command, args, commandText: commandText(command, args), code: 0, stdout: '', stderr: '', dryRun: true };
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    if (!options.inherit) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    let timedOut = false;
    const timeout = options.timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs) : null;
    timeout?.unref?.();
    child.once('error', reject);
    child.once('exit', code => {
      if (timeout) clearTimeout(timeout);
      const result = { command, args, commandText: commandText(command, args), code: code ?? 1, stdout, stderr, timedOut };
      if (code === 0 && !timedOut) resolve(result);
      else reject(new KuraNativeToolchainError(
        timedOut ? `Command timed out: ${result.commandText}` : `Command failed (${code}): ${result.commandText}`,
        { code: timedOut ? 'KR-TOOLCHAIN-0002' : 'KR-TOOLCHAIN-0003', command: result.commandText, stdout, stderr },
      ));
    });
  });
}

export async function emitNativeObject(source, options = {}) {
  const plan = options.plan ?? createNativeBuildPlan(options);
  const tools = options.tools ?? detectNativeToolchain();
  await mkdir(plan.outDir, { recursive: true });
  const llvm = compileNativeSystemSource(source, { file: options.file ?? plan.input, target: plan.target });
  if (!options.dryRun) await writeFile(plan.llvm, llvm, 'utf8');
  let step;
  if (tools.llc) {
    step = await run(tools.llc.command, ['-filetype=obj', `-mtriple=${plan.target}`, '-o', plan.object, plan.llvm], options);
  } else if (tools.clang) {
    step = await run(tools.clang.command, [
      '-target', plan.target,
      '-ffreestanding', '-fno-stack-protector', '-fno-pic', '-mno-red-zone',
      '-c', '-x', 'ir', plan.llvm, '-o', plan.object,
    ], options);
  } else {
    throw new KuraNativeToolchainError('Neither llc nor clang is available for object generation.', { code: 'KR-TOOLCHAIN-0101' });
  }
  return { plan, llvm, step };
}

export async function linkNativeElf(objects, options = {}) {
  const plan = options.plan ?? createNativeBuildPlan(options);
  const tools = options.tools ?? detectNativeToolchain();
  await mkdir(plan.outDir, { recursive: true });
  const script = createNativeLinkerScript({ entry: plan.entry, baseAddress: options.baseAddress });
  if (!options.dryRun) await writeFile(plan.linkerScript, script, 'utf8');
  const linker = tools.linker;
  if (!linker) throw new KuraNativeToolchainError('No ELF linker was found. Install ld.lld or GNU ld.', { code: 'KR-TOOLCHAIN-0102' });
  const args = linker.command.includes('ld.lld')
    ? ['-nostdlib', '-static', '-z', 'max-page-size=0x1000', '-T', plan.linkerScript, '-o', plan.elf, ...objects]
    : ['-nostdlib', '-static', '-z', 'max-page-size=0x1000', '-T', plan.linkerScript, '-o', plan.elf, ...objects];
  const step = await run(linker.command, args, options);
  return { plan, script, step };
}

export async function buildNativeKernel(source, options = {}) {
  const plan = options.plan ?? createNativeBuildPlan(options);
  const tools = options.tools ?? detectNativeToolchain();
  const objectResult = await emitNativeObject(source, { ...options, plan, tools });
  const linkResult = await linkNativeElf([plan.object], { ...options, plan, tools });
  return { plan, tools, objectResult, linkResult };
}

export async function createBootableIso(elfFile, options = {}) {
  const plan = options.plan ?? createNativeBuildPlan(options);
  const tools = options.tools ?? detectNativeToolchain();
  if (!tools.grub) throw new KuraNativeToolchainError('grub-mkrescue is required to create an ISO.', { code: 'KR-TOOLCHAIN-0103' });
  const boot = path.join(plan.isoRoot, 'boot');
  const grub = path.join(boot, 'grub');
  if (!options.dryRun) {
    await rm(plan.isoRoot, { recursive: true, force: true });
    await mkdir(grub, { recursive: true });
    await copyFile(elfFile, path.join(boot, 'kernel.elf'));
    await writeFile(path.join(grub, 'grub.cfg'), createGrubConfig(options), 'utf8');
  }
  const step = await run(tools.grub.command, ['-o', plan.iso, plan.isoRoot], options);
  return { plan, step };
}

export async function runNativeKernelQemu(kernelFile, options = {}) {
  const tools = options.tools ?? detectNativeToolchain();
  if (!tools.qemu) throw new KuraNativeToolchainError('qemu-system-x86_64 is not installed.', { code: 'KR-TOOLCHAIN-0104' });
  const memory = String(options.memory ?? 128);
  const args = [
    '-machine', options.machine ?? 'q35',
    '-m', memory,
    '-no-reboot', '-no-shutdown',
    '-display', options.display ?? 'none',
    '-serial', options.serial ?? 'stdio',
    '-monitor', 'none',
  ];
  if (kernelFile.endsWith('.iso')) args.push('-cdrom', kernelFile);
  else args.push('-kernel', kernelFile);
  return run(tools.qemu.command, args, { ...options, inherit: options.inherit ?? true });
}

export function formatToolchainError(error) {
  if (error instanceof KuraNativeCompileError) {
    return `${error.file}:${error.line}:${error.column}: ${error.code}: ${error.message}`;
  }
  if (error instanceof KuraNativeToolchainError) {
    const details = [error.message, error.stderr?.trim()].filter(Boolean).join('\n');
    return `${error.code}: ${details}`;
  }
  return error?.stack ?? String(error);
}
