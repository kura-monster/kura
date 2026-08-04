// SPDX-License-Identifier: MIT OR Apache-2.0
export { KuraNativeCompileError, tokenizeNativeSource } from './system-native-common.mjs';
export { parseNativeSystemSource } from './system-native-parser.mjs';
export { NativeCompiler, compileNativeSystemSource, describeNativeLayout } from './system-native-compiler.mjs';
export {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createKernelRuntimeSource,
  createX86_64BootstrapAssembly,
} from './system-kernel-runtime.mjs';
export {
  DEFAULT_KERNEL_PLATFORM_LAYOUT,
  createKernelPlatformManifest,
  decodeMultiboot2,
  createPhysicalFrameBitmap,
  parseAcpiMadt,
  createApTrampolineBytes,
  createKernelPlatformSource,
} from './system-kernel-platform.mjs';
export {
  KuraNativeToolchainError,
  detectNativeToolchain,
  createNativeLinkerScript,
  createGrubConfig,
  createNativeBuildPlan,
  emitNativeObject,
  emitNativeBootstrapObject,
  linkNativeElf,
  buildNativeKernel,
  buildBootableKernel,
  createBootableIso,
  runNativeKernelQemu,
  runNativeKernelQemuSmoke,
  formatToolchainError,
} from './system-native-toolchain.mjs';

export {
  DEFAULT_KERNEL_SCHEDULER_LAYOUT,
  createKernelSchedulerManifest,
  parseAcpiHpet,
  TicketSpinLockModel,
  SlabAllocatorModel,
  PriorityRoundRobinSchedulerModel,
  createContextSwitchAssembly,
  createKernelSchedulerSource,
  createSchedulerBuildPlan,
  emitSchedulerSupportObject,
  buildSchedulerKernel,
} from './system-kernel-scheduler.mjs';

export {
  NativeSafetyDiagnostic,
  SAFETY_ERROR_EXPLANATIONS,
  ownershipMode,
  analyzeNativeSafety,
  assertNativeSafety,
  formatNativeSafetyReport,
} from './system-native-safety.mjs';

export {
  DEFAULT_HARDWARE_LAYOUT,
  createHardwareManifest,
  decodeNvmeIdentifyController,
  decodeNvmeIdentifyNamespace,
  planNvmePrps,
  createNvmeCommand,
  createNvmeReadWriteCommand,
  NvmeQueueModel,
  encodeXhciTrb,
  decodeXhciTrb,
  XhciRingModel,
  parseUsbDescriptors,
  decodeBootKeyboardReport,
  decodeBootMouseReport,
  encodeVirtioNetHeader,
  VirtioNetDeviceModel,
  FramebufferSurface,
  createHardwareKernelSource,
  createCompleteHardwareKernelSource,
  createHardwareBuildPlan,
  buildHardwareKernel,
  hardwareFingerprint,
  hardwareSmokeTest,
} from './system-hardware.mjs';
