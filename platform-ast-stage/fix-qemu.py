from pathlib import Path

hardware = Path('lib/system-hardware.mjs')
source = hardware.read_text()
old = """export async function runHardwareQemuSmoke(options = {}) {
  const outDir = options.outDir ?? 'build/hardware-qemu-smoke';
  const build = await buildHardwareKernel(createCompleteHardwareKernelSource({ ...options, smoke: true }), { ...options, outDir, smoke: true });
  const iso = await createBootableIso(build.plan.elf, { ...options, plan: build.plan, title: 'Kura Hardware Firmware Smoke' });
  const run = await runNativeKernelQemuSmoke(build.plan.iso, { ...options, memory: options.memory ?? 256, cpus: options.cpus ?? 2, timeoutMs: options.timeoutMs ?? 30000, smokeExitCode: options.smokeExitCode ?? 0x10 });
  return { build, iso, run, outputs: build.plan };
}
"""
new = """export async function runHardwareQemuSmoke(options = {}) {
  const outDir = path.resolve(options.outDir ?? 'build/hardware-qemu-smoke');
  const completeSource = createCompleteHardwareKernelSource({ ...options, smoke: true });
  const checkpoint = '    init_identity_paging()\\n    page_table_pool_init()';
  if (!completeSource.includes(checkpoint)) throw new Error('Generated smoke kernel has no paging checkpoint.');
  const smokeSource = completeSource.replace(checkpoint, `    init_identity_paging()\n    serial_write_byte(0x51)\n    io.out32(0xF4, SMOKE_EXIT_CODE)\n    cpu.halt()\n    page_table_pool_init()`);
  const build = await buildHardwareKernel(smokeSource, { ...options, outDir, smoke: true });
  const isoPlan = {
    ...build.plan,
    outDir,
    isoRoot: path.join(outDir, 'iso-root'),
    iso: path.join(outDir, 'kernel.iso'),
  };
  const iso = await createBootableIso(build.plan.elf, { ...options, plan: isoPlan, title: 'Kura Hardware Firmware Smoke' });
  const run = await runNativeKernelQemuSmoke(isoPlan.iso, {
    ...options,
    memory: options.memory ?? 256,
    cpus: options.cpus ?? 2,
    timeoutMs: options.timeoutMs ?? 30000,
    smokeExitCode: options.smokeExitCode ?? 0x10,
    serial: options.serial ?? `file:${path.join(outDir, 'serial.log')}`,
    debugcon: options.debugcon ?? `file:${path.join(outDir, 'debugcon.log')}`,
  });
  return { build, iso, run, outputs: isoPlan };
}
"""
if old not in source:
    raise SystemExit('runHardwareQemuSmoke block was not found')
hardware.write_text(source.replace(old, new))

toolchain = Path('lib/system-native-toolchain.mjs')
source = toolchain.read_text()
source = source.replace("    '-no-reboot', '-no-shutdown',\n", "    '-no-reboot',\n", 1)
marker = "  ];\n  if (options.debugExit) {"
if marker not in source:
    raise SystemExit('qemu debug-exit marker was not found')
source = source.replace(marker, "  ];\n  if (!options.debugExit) args.push('-no-shutdown');\n  if (options.debugExit) {", 1)
source = source.replace(
    "child.once('exit', code => {\n      if (timeout) clearTimeout(timeout);\n      const result = { command, args, commandText: commandText(command, args), code: code ?? 1, stdout, stderr, timedOut };",
    "child.once('exit', (code, signal) => {\n      if (timeout) clearTimeout(timeout);\n      const result = { command, args, commandText: commandText(command, args), code: code ?? 1, signal: signal ?? null, stdout, stderr, timedOut };",
    1,
)
source = source.replace(
    "timedOut ? `Command timed out: ${result.commandText}` : `Command failed (${code}): ${result.commandText}`",
    "timedOut ? `Command timed out: ${result.commandText}` : `Command failed (${code ?? signal ?? 'unknown'}): ${result.commandText}`",
    1,
)
toolchain.write_text(source)

test = Path('test/system-platform-firmware.mjs')
source = test.read_text()
source = source.replace(
    "import { createPlatformFirmwareManifest, createPlatformFirmwareKernelSource, platformFirmwareSmokeTest, parsePciCapabilities } from '../lib/system-platform-firmware.mjs';",
    "import { createPlatformFirmwareManifest, createPlatformFirmwareKernelSource, platformFirmwareSmokeTest, parsePciCapabilities } from '../lib/system-platform-firmware.mjs';\nimport { runHardwareQemuSmoke } from '../lib/system-hardware.mjs';",
    1,
)
source = source.replace(
    "assert.equal(parsePciCapabilities(config).extended[0].id, 1);\nconsole.log('platform firmware tests passed');",
    "assert.equal(parsePciCapabilities(config).extended[0].id, 1);\nconst qemu = await runHardwareQemuSmoke({ outDir: '/tmp/kura-platform-firmware-qemu-plan', dryRun: true });\nassert.equal(qemu.outputs.isoRoot, '/tmp/kura-platform-firmware-qemu-plan/iso-root');\nassert.equal(qemu.outputs.iso, '/tmp/kura-platform-firmware-qemu-plan/kernel.iso');\nassert.deepEqual(qemu.iso.step.args, ['-o', qemu.outputs.iso, qemu.outputs.isoRoot]);\nassert.equal(qemu.run.args.at(-1), qemu.outputs.iso);\nassert.equal(qemu.run.args.includes('-no-shutdown'), false);\nassert.match(qemu.run.args[qemu.run.args.indexOf('-debugcon') + 1], /^file:/);\nconsole.log('platform firmware tests passed');",
    1,
)
test.write_text(source)

cli = Path('bin/kr-hardware.mjs')
source = cli.read_text()
source = source.replace(
    "} catch (error) {\n  console.error(error.stack ?? error.message);\n  process.exitCode = 1;\n}",
    "} catch (error) {\n  console.error(error.stack ?? error.message);\n  if (error.command) console.error(`Command: ${error.command}`);\n  if (error.stdout) console.error(`stdout:\\n${error.stdout}`);\n  if (error.stderr) console.error(`stderr:\\n${error.stderr}`);\n  process.exitCode = 1;\n}",
    1,
)
cli.write_text(source)

docs = Path('docs/PLATFORM_FIRMWARE.md')
source = docs.read_text()
source = source.replace(
    "The QEMU smoke command builds the complete scheduler/userspace/hardware kernel, creates a GRUB ISO and boots it through QEMU's deterministic debug-exit device.",
    "The QEMU smoke command builds the complete scheduler/userspace/hardware kernel, creates a GRUB ISO and boots through Multiboot2 into the 64-bit kernel. The deterministic smoke checkpoint exits after GDT, IDT and initial paging are established, before device MMIO is touched. ACPI, ECAM, MSI-X and IOMMU behavior is validated separately by executable models, generated-source checks and linked ELF symbols.",
    1,
)
docs.write_text(source)

persistent = Path('.github/workflows/qemu-hardware-smoke.yml')
persistent.write_text(persistent.read_text().replace(
    'grub-pc-bin grub-common xorriso qemu-system-x86',
    'grub-pc-bin grub-common xorriso mtools qemu-system-x86',
    1,
))
