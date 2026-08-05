// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCompleteUserspaceKernelSource, buildUserspaceKernel, createUserspaceBuildPlan } from './system-userspace.mjs';
import { createHardwareRuntimeManifest, createHardwareRuntimeKernelSource, hardwareRuntimeSmokeTest } from './system-hardware-runtime.mjs';
import { createPlatformFirmwareManifest, createPlatformFirmwareKernelSource } from './system-platform-firmware.mjs';
import { createBootableIso, runNativeKernelQemuSmoke } from './system-native-toolchain.mjs';

const PAGE_SIZE = 0x1000;
const PCI_CONFIG_ADDRESS = 0xCF8;
const PCI_CONFIG_DATA = 0xCFC;

function integer(name, value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer >= ${minimum}.`);
  return value;
}
function powerOfTwo(name, value, minimum = 2) {
  integer(name, value, minimum);
  if ((value & (value - 1)) !== 0) throw new TypeError(`${name} must be a power of two.`);
  return value;
}
function alignUp(value, alignment) { return Math.ceil(value / alignment) * alignment; }
function aligned(name, value, alignment = PAGE_SIZE) {
  integer(name, value, alignment);
  if (value % alignment !== 0) throw new TypeError(`${name} must be aligned to ${alignment}.`);
  return value;
}
function asUint8(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new TypeError('Expected bytes.');
}
function asView(input) {
  const bytes = asUint8(input);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function ascii(bytes, start, length) {
  return new TextDecoder().decode(bytes.subarray(start, start + length)).replace(/\0+$/g, '').trim();
}
function assertRange(view, offset, size, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > view.byteLength) throw new RangeError(`${label} is truncated.`);
}
function freezeDeep(value) {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freezeDeep(item);
  }
  return value;
}

export const DEFAULT_HARDWARE_LAYOUT = Object.freeze({
  dmaPool: 0xE00000,
  dmaPoolSize: 0x400000,
  nvmeAdminSubmission: 0x1200000,
  nvmeAdminCompletion: 0x1201000,
  nvmeIoSubmission: 0x1202000,
  nvmeIoCompletion: 0x1204000,
  xhciCommandRing: 0x1210000,
  xhciEventRing: 0x1214000,
  xhciDeviceContexts: 0x1218000,
  xhciScratchpads: 0x1220000,
  virtioNetRx: 0x1230000,
  virtioNetTx: 0x1238000,
  framebufferShadow: 0x1240000,
  framebufferShadowSize: 0x800000,
  nvmeQueueDepth: 64,
  xhciRingTrbs: 256,
  virtioQueueSize: 256,
});

export function createHardwareManifest(options = {}) {
  const source = { ...DEFAULT_HARDWARE_LAYOUT, ...(options.layout ?? options) };
  const layout = {
    dmaPool: aligned('dmaPool', source.dmaPool),
    dmaPoolSize: aligned('dmaPoolSize', source.dmaPoolSize),
    nvmeAdminSubmission: aligned('nvmeAdminSubmission', source.nvmeAdminSubmission),
    nvmeAdminCompletion: aligned('nvmeAdminCompletion', source.nvmeAdminCompletion),
    nvmeIoSubmission: aligned('nvmeIoSubmission', source.nvmeIoSubmission),
    nvmeIoCompletion: aligned('nvmeIoCompletion', source.nvmeIoCompletion),
    xhciCommandRing: aligned('xhciCommandRing', source.xhciCommandRing),
    xhciEventRing: aligned('xhciEventRing', source.xhciEventRing),
    xhciDeviceContexts: aligned('xhciDeviceContexts', source.xhciDeviceContexts),
    xhciScratchpads: aligned('xhciScratchpads', source.xhciScratchpads),
    virtioNetRx: aligned('virtioNetRx', source.virtioNetRx),
    virtioNetTx: aligned('virtioNetTx', source.virtioNetTx),
    framebufferShadow: aligned('framebufferShadow', source.framebufferShadow),
    framebufferShadowSize: aligned('framebufferShadowSize', source.framebufferShadowSize),
    nvmeQueueDepth: powerOfTwo('nvmeQueueDepth', source.nvmeQueueDepth, 2),
    xhciRingTrbs: powerOfTwo('xhciRingTrbs', source.xhciRingTrbs, 16),
    virtioQueueSize: powerOfTwo('virtioQueueSize', source.virtioQueueSize, 8),
  };
  if (layout.nvmeQueueDepth > 4096) throw new TypeError('nvmeQueueDepth exceeds the NVMe queue entry limit.');
  if (layout.xhciRingTrbs > 4096) throw new TypeError('xhciRingTrbs exceeds the supported software ring limit.');
  if (layout.virtioQueueSize > 32768) throw new TypeError('virtioQueueSize exceeds the VirtIO queue limit.');
  const regions = [
    ['dmaPool', layout.dmaPool, layout.dmaPool + layout.dmaPoolSize],
    ['nvmeAdminSubmission', layout.nvmeAdminSubmission, layout.nvmeAdminSubmission + PAGE_SIZE],
    ['nvmeAdminCompletion', layout.nvmeAdminCompletion, layout.nvmeAdminCompletion + PAGE_SIZE],
    ['nvmeIoSubmission', layout.nvmeIoSubmission, layout.nvmeIoSubmission + PAGE_SIZE * 2],
    ['nvmeIoCompletion', layout.nvmeIoCompletion, layout.nvmeIoCompletion + PAGE_SIZE * 2],
    ['xhciCommandRing', layout.xhciCommandRing, layout.xhciCommandRing + PAGE_SIZE * 4],
    ['xhciEventRing', layout.xhciEventRing, layout.xhciEventRing + PAGE_SIZE * 4],
    ['xhciDeviceContexts', layout.xhciDeviceContexts, layout.xhciDeviceContexts + PAGE_SIZE * 8],
    ['xhciScratchpads', layout.xhciScratchpads, layout.xhciScratchpads + PAGE_SIZE * 8],
    ['virtioNetRx', layout.virtioNetRx, layout.virtioNetRx + PAGE_SIZE * 8],
    ['virtioNetTx', layout.virtioNetTx, layout.virtioNetTx + PAGE_SIZE * 8],
    ['framebufferShadow', layout.framebufferShadow, layout.framebufferShadow + layout.framebufferShadowSize],
  ].map(([name, start, end]) => ({ name, start, end })).sort((a, b) => a.start - b.start);
  for (let index = 1; index < regions.length; index++) {
    if (regions[index].start < regions[index - 1].end) throw new TypeError(`Hardware regions overlap: ${regions[index - 1].name} and ${regions[index].name}.`);
  }
  return freezeDeep({
    architecture: 'x86_64',
    pageSize: PAGE_SIZE,
    pciConfigPorts: { address: PCI_CONFIG_ADDRESS, data: PCI_CONFIG_DATA },
    layout,
    regions,
    runtime: createHardwareRuntimeManifest(options.runtime ?? options),
    firmware: createPlatformFirmwareManifest(options.firmware ?? options),
    pciClasses: {
      nvme: { classCode: 0x01, subclass: 0x08, programmingInterface: 0x02 },
      xhci: { classCode: 0x0C, subclass: 0x03, programmingInterface: 0x30 },
      display: { classCode: 0x03 },
      network: { classCode: 0x02 },
    },
    features: {
      nvmeAdminQueue: true,
      nvmeIoQueues: true,
      nvmePrpLists: true,
      xhciCommandRing: true,
      xhciEventRing: true,
      usbDescriptors: true,
      usbHidBootProtocol: true,
      virtioNet: true,
      framebuffer: true,
      pciEnumeration: true,
      pciBarProbe: true,
      pciResourceAssignment: true,
      dmaAllocator: true,
      msi: true,
      msiX: true,
      interruptDrivenIo: true,
      iommuDomains: true,
    },
  });
}

export function decodeNvmeIdentifyController(input) {
  const bytes = asUint8(input); const view = asView(bytes);
  assertRange(view, 0, 4096, 'NVMe identify-controller data');
  const oacs = view.getUint16(256, true);
  const oncs = view.getUint16(520, true);
  const sgls = view.getUint32(536, true);
  return freezeDeep({
    pciVendorId: view.getUint16(0, true),
    subsystemVendorId: view.getUint16(2, true),
    serialNumber: ascii(bytes, 4, 20),
    modelNumber: ascii(bytes, 24, 40),
    firmwareRevision: ascii(bytes, 64, 8),
    recommendedArbitrationBurst: view.getUint8(72),
    ieeeOui: [bytes[73], bytes[74], bytes[75]],
    controllerMultiPathIoAndNamespaceSharingCapabilities: view.getUint8(76),
    maximumDataTransferSizeExponent: view.getUint8(77),
    controllerId: view.getUint16(78, true),
    version: view.getUint32(80, true),
    namespaceCount: view.getUint32(516, true),
    submissionQueueEntrySize: { required: 1 << (view.getUint8(512) & 0x0F), maximum: 1 << (view.getUint8(512) >>> 4) },
    completionQueueEntrySize: { required: 1 << (view.getUint8(513) & 0x0F), maximum: 1 << (view.getUint8(513) >>> 4) },
    optionalAdminCommands: {
      security: Boolean(oacs & 1), format: Boolean(oacs & 2), firmware: Boolean(oacs & 4), namespaceManagement: Boolean(oacs & 8), selfTest: Boolean(oacs & 0x10), directives: Boolean(oacs & 0x20), virtualization: Boolean(oacs & 0x80), doorbellBuffer: Boolean(oacs & 0x100),
    },
    optionalNvmCommands: {
      compare: Boolean(oncs & 1), writeUncorrectable: Boolean(oncs & 2), datasetManagement: Boolean(oncs & 4), writeZeroes: Boolean(oncs & 8), saveFeatures: Boolean(oncs & 0x10), reservations: Boolean(oncs & 0x20), timestamp: Boolean(oncs & 0x40), verify: Boolean(oncs & 0x80),
    },
    scatterGather: { supported: Boolean(sgls & 0x3), keyed: Boolean(sgls & 0x4), bitBucket: Boolean(sgls & 0x10000) },
  });
}

export function decodeNvmeIdentifyNamespace(input) {
  const bytes = asUint8(input); const view = asView(bytes);
  assertRange(view, 0, 4096, 'NVMe identify-namespace data');
  const format = view.getUint8(26) & 0x0F;
  const formatOffset = 128 + format * 4;
  const metadataSize = view.getUint16(formatOffset, true);
  const lbaDataSizeExponent = view.getUint8(formatOffset + 2);
  return freezeDeep({
    sizeInLogicalBlocks: view.getBigUint64(0, true),
    capacityInLogicalBlocks: view.getBigUint64(8, true),
    utilizationInLogicalBlocks: view.getBigUint64(16, true),
    thinProvisioning: Boolean(view.getUint8(24) & 1),
    namespaceAtomicWriteUnitNormal: view.getUint16(34, true),
    namespaceAtomicWriteUnitPowerFail: view.getUint16(36, true),
    selectedLbaFormat: format,
    metadataSize,
    lbaDataSizeExponent,
    lbaSize: 2 ** lbaDataSizeExponent,
    relativePerformance: view.getUint8(formatOffset + 3) & 0x3,
    eui64: [...bytes.subarray(120, 128)],
  });
}

export function planNvmePrps({ address, length, pageSize = PAGE_SIZE, listPageAddress = null } = {}) {
  integer('address', address, 0); integer('length', length, 1); powerOfTwo('pageSize', pageSize, 512);
  const firstPage = address - (address % pageSize);
  const firstOffset = address - firstPage;
  const pages = [];
  let remaining = length;
  let cursor = address;
  while (remaining > 0) {
    pages.push(cursor - (cursor % pageSize));
    const consumed = Math.min(remaining, pageSize - (cursor % pageSize));
    cursor += consumed; remaining -= consumed;
  }
  const uniquePages = [...new Set(pages)];
  if (uniquePages.length === 1) return { prp1: address, prp2: 0, pages: uniquePages, list: [] };
  if (uniquePages.length === 2) return { prp1: address, prp2: uniquePages[1], pages: uniquePages, list: [] };
  if (listPageAddress == null) throw new TypeError('listPageAddress is required for transfers spanning more than two pages.');
  aligned('listPageAddress', listPageAddress, pageSize);
  return { prp1: address, prp2: listPageAddress, pages: uniquePages, list: uniquePages.slice(1), firstOffset };
}

export function createNvmeCommand(options = {}) {
  const opcode = integer('opcode', options.opcode ?? 0, 0);
  const commandId = integer('commandId', options.commandId ?? 0, 0);
  const namespaceId = integer('namespaceId', options.namespaceId ?? 0, 0);
  if (opcode > 0xFF || commandId > 0xFFFF || namespaceId > 0xFFFFFFFF) throw new RangeError('NVMe command field is out of range.');
  const bytes = new Uint8Array(64); const view = new DataView(bytes.buffer);
  view.setUint8(0, opcode); view.setUint8(1, options.fuse ?? 0); view.setUint16(2, commandId, true); view.setUint32(4, namespaceId, true);
  view.setBigUint64(24, BigInt(options.prp1 ?? 0), true); view.setBigUint64(32, BigInt(options.prp2 ?? 0), true);
  const dwords = options.commandDwords ?? [];
  for (let index = 0; index < Math.min(6, dwords.length); index++) view.setUint32(40 + index * 4, dwords[index] >>> 0, true);
  return bytes;
}
export function createNvmeReadWriteCommand({ write = false, commandId = 0, namespaceId = 1, startLba = 0n, blockCount = 1, prp1 = 0, prp2 = 0, forceUnitAccess = false, limitedRetry = false } = {}) {
  integer('blockCount', blockCount, 1);
  if (blockCount > 0x10000) throw new RangeError('blockCount exceeds the NVMe NLB field.');
  const control = (forceUnitAccess ? 1 << 14 : 0) | (limitedRetry ? 1 << 15 : 0);
  return createNvmeCommand({ opcode: write ? 0x01 : 0x02, commandId, namespaceId, prp1, prp2, commandDwords: [Number(startLba & 0xFFFFFFFFn), Number((startLba >> 32n) & 0xFFFFFFFFn), (blockCount - 1) | control, 0, 0, 0] });
}

export class NvmeQueueModel {
  constructor(depth = 64) {
    this.depth = powerOfTwo('depth', depth, 2);
    this.submission = Array(this.depth).fill(null);
    this.completion = Array(this.depth).fill(null);
    this.submissionTail = 0; this.deviceSubmissionHead = 0;
    this.deviceCompletionTail = 0; this.driverCompletionHead = 0;
    this.devicePhase = 1; this.driverPhase = 1;
    this.pending = new Map(); this.nextCommandId = 1;
  }
  allocateCommandId() {
    for (let count = 0; count < 0xFFFF; count++) {
      const id = this.nextCommandId++ & 0xFFFF;
      if (id !== 0 && !this.pending.has(id)) return id;
    }
    throw new Error('No free NVMe command identifier is available.');
  }
  submit(command, metadata = {}) {
    if (this.pending.size >= this.depth - 1) throw new Error('NVMe submission queue is full.');
    const bytes = asUint8(command);
    if (bytes.byteLength !== 64) throw new TypeError('NVMe submission commands must be 64 bytes.');
    const copy = Uint8Array.from(bytes); const view = new DataView(copy.buffer);
    let commandId = view.getUint16(2, true);
    if (commandId === 0) { commandId = this.allocateCommandId(); view.setUint16(2, commandId, true); }
    if (this.pending.has(commandId)) throw new Error(`NVMe command identifier ${commandId} is already pending.`);
    const slot = this.submissionTail; this.submission[slot] = { command: copy, commandId, metadata, slot };
    this.submissionTail = (this.submissionTail + 1) % this.depth;
    this.pending.set(commandId, { metadata, slot, submittedAt: Date.now() });
    return { commandId, slot, doorbell: this.submissionTail };
  }
  devicePopSubmission() {
    if (this.deviceSubmissionHead === this.submissionTail) return null;
    const item = this.submission[this.deviceSubmissionHead]; this.submission[this.deviceSubmissionHead] = null;
    this.deviceSubmissionHead = (this.deviceSubmissionHead + 1) % this.depth;
    return item;
  }
  complete({ commandId, statusCode = 0, statusCodeType = 0, result = 0, submissionQueueId = 1 } = {}) {
    if (!this.pending.has(commandId)) throw new Error(`Unknown pending NVMe command ${commandId}.`);
    if (this.completion[this.deviceCompletionTail]) throw new Error('NVMe completion queue is full.');
    const status = ((statusCode & 0xFF) << 1) | ((statusCodeType & 0x7) << 9) | this.devicePhase;
    this.completion[this.deviceCompletionTail] = { commandId, status, statusCode, statusCodeType, result: result >>> 0, submissionQueueHead: this.deviceSubmissionHead, submissionQueueId, phase: this.devicePhase };
    this.deviceCompletionTail++;
    if (this.deviceCompletionTail === this.depth) { this.deviceCompletionTail = 0; this.devicePhase ^= 1; }
  }
  driverPopCompletion() {
    const item = this.completion[this.driverCompletionHead];
    if (!item || item.phase !== this.driverPhase) return null;
    this.completion[this.driverCompletionHead] = null;
    this.driverCompletionHead++;
    if (this.driverCompletionHead === this.depth) { this.driverCompletionHead = 0; this.driverPhase ^= 1; }
    const pending = this.pending.get(item.commandId); this.pending.delete(item.commandId);
    return { ...item, metadata: pending?.metadata ?? null, success: item.statusCode === 0 && item.statusCodeType === 0, doorbell: this.driverCompletionHead };
  }
}

export function encodeXhciTrb({ parameter = 0n, status = 0, type = 1, cycle = 1, flags = 0 } = {}) {
  integer('status', status, 0); integer('type', type, 0); integer('cycle', cycle, 0); integer('flags', flags, 0);
  if (type > 63 || cycle > 1) throw new RangeError('Invalid xHCI TRB type or cycle state.');
  const bytes = new Uint8Array(16); const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(parameter), true); view.setUint32(8, status >>> 0, true); view.setUint32(12, ((type & 0x3F) << 10) | (flags & 0xFFFFFC00) | cycle, true);
  return bytes;
}
export function decodeXhciTrb(input) {
  const view = asView(input); assertRange(view, 0, 16, 'xHCI TRB');
  const control = view.getUint32(12, true);
  return { parameter: view.getBigUint64(0, true), status: view.getUint32(8, true), cycle: control & 1, evaluateNext: Boolean(control & 2), interruptOnShortPacket: Boolean(control & 4), noSnoop: Boolean(control & 8), chain: Boolean(control & 0x10), interruptOnCompletion: Boolean(control & 0x20), immediateData: Boolean(control & 0x40), type: (control >>> 10) & 0x3F, control };
}

export class XhciRingModel {
  constructor(entries = 256, options = {}) {
    this.entries = powerOfTwo('entries', entries, 16);
    this.usable = this.entries - 1;
    this.ring = Array(this.entries).fill(null);
    this.enqueueIndex = 0; this.dequeueIndex = 0;
    this.producerCycle = 1; this.consumerCycle = 1;
    this.baseAddress = BigInt(options.baseAddress ?? 0);
    this.pending = 0;
    this.#writeLink();
  }
  #writeLink() {
    this.ring[this.usable] = encodeXhciTrb({ parameter: this.baseAddress, type: 6, cycle: this.producerCycle, flags: 1 << 1 });
  }
  enqueue(trb) {
    if (this.pending >= this.usable) throw new Error('xHCI transfer ring is full.');
    if (this.enqueueIndex === this.usable) {
      this.producerCycle ^= 1; this.enqueueIndex = 0; this.#writeLink();
    }
    const decoded = decodeXhciTrb(trb);
    const bytes = encodeXhciTrb({ parameter: decoded.parameter, status: decoded.status, type: decoded.type, cycle: this.producerCycle, flags: decoded.control & 0xFFFFFC00 });
    const index = this.enqueueIndex++; this.ring[index] = bytes; this.pending++;
    return { index, cycle: this.producerCycle, address: this.baseAddress + BigInt(index * 16) };
  }
  hardwarePop() {
    if (this.pending === 0) return null;
    if (this.dequeueIndex === this.usable) { this.consumerCycle ^= 1; this.dequeueIndex = 0; }
    const bytes = this.ring[this.dequeueIndex]; const decoded = decodeXhciTrb(bytes);
    if (decoded.cycle !== this.consumerCycle) return null;
    const index = this.dequeueIndex++; this.ring[index] = null; this.pending--;
    return { index, bytes, ...decoded };
  }
}

export function parseUsbDescriptors(input) {
  const bytes = asUint8(input); const view = asView(bytes);
  const descriptors = [];
  for (let offset = 0; offset < bytes.length;) {
    assertRange(view, offset, 2, 'USB descriptor header');
    const length = view.getUint8(offset); const type = view.getUint8(offset + 1);
    if (length < 2) throw new TypeError(`Invalid USB descriptor length ${length} at offset ${offset}.`);
    assertRange(view, offset, length, 'USB descriptor');
    const raw = bytes.slice(offset, offset + length);
    let value = { type, length, offset, raw };
    if (type === 1 && length >= 18) value = { ...value, kind: 'device', usbVersion: view.getUint16(offset + 2, true), deviceClass: view.getUint8(offset + 4), deviceSubclass: view.getUint8(offset + 5), protocol: view.getUint8(offset + 6), maxPacketSize0: view.getUint8(offset + 7), vendorId: view.getUint16(offset + 8, true), productId: view.getUint16(offset + 10, true), deviceVersion: view.getUint16(offset + 12, true), manufacturerIndex: view.getUint8(offset + 14), productIndex: view.getUint8(offset + 15), serialIndex: view.getUint8(offset + 16), configurations: view.getUint8(offset + 17) };
    else if (type === 2 && length >= 9) value = { ...value, kind: 'configuration', totalLength: view.getUint16(offset + 2, true), interfaces: view.getUint8(offset + 4), configurationValue: view.getUint8(offset + 5), attributes: view.getUint8(offset + 7), maxPowerMilliAmps: view.getUint8(offset + 8) * 2 };
    else if (type === 4 && length >= 9) value = { ...value, kind: 'interface', interfaceNumber: view.getUint8(offset + 2), alternateSetting: view.getUint8(offset + 3), endpoints: view.getUint8(offset + 4), interfaceClass: view.getUint8(offset + 5), interfaceSubclass: view.getUint8(offset + 6), interfaceProtocol: view.getUint8(offset + 7), stringIndex: view.getUint8(offset + 8) };
    else if (type === 5 && length >= 7) { const attributes = view.getUint8(offset + 3); value = { ...value, kind: 'endpoint', address: view.getUint8(offset + 2), direction: view.getUint8(offset + 2) & 0x80 ? 'in' : 'out', endpointNumber: view.getUint8(offset + 2) & 0x0F, transferType: ['control', 'isochronous', 'bulk', 'interrupt'][attributes & 0x3], synchronizationType: (attributes >>> 2) & 0x3, usageType: (attributes >>> 4) & 0x3, maxPacketSize: view.getUint16(offset + 4, true) & 0x7FF, interval: view.getUint8(offset + 6) }; }
    else if (type === 0x21 && length >= 9) value = { ...value, kind: 'hid', hidVersion: view.getUint16(offset + 2, true), countryCode: view.getUint8(offset + 4), descriptorCount: view.getUint8(offset + 5), reportDescriptorType: view.getUint8(offset + 6), reportDescriptorLength: view.getUint16(offset + 7, true) };
    descriptors.push(value); offset += length;
  }
  const device = descriptors.find(item => item.kind === 'device') ?? null;
  const configurations = descriptors.filter(item => item.kind === 'configuration');
  const interfaces = descriptors.filter(item => item.kind === 'interface');
  const endpoints = descriptors.filter(item => item.kind === 'endpoint');
  return freezeDeep({ descriptors, device, configurations, interfaces, endpoints, hid: descriptors.filter(item => item.kind === 'hid') });
}

const HID_KEY_NAMES = Object.freeze({ 0x04: 'A', 0x05: 'B', 0x06: 'C', 0x07: 'D', 0x08: 'E', 0x09: 'F', 0x0A: 'G', 0x0B: 'H', 0x0C: 'I', 0x0D: 'J', 0x0E: 'K', 0x0F: 'L', 0x10: 'M', 0x11: 'N', 0x12: 'O', 0x13: 'P', 0x14: 'Q', 0x15: 'R', 0x16: 'S', 0x17: 'T', 0x18: 'U', 0x19: 'V', 0x1A: 'W', 0x1B: 'X', 0x1C: 'Y', 0x1D: 'Z', 0x1E: '1', 0x1F: '2', 0x20: '3', 0x21: '4', 0x22: '5', 0x23: '6', 0x24: '7', 0x25: '8', 0x26: '9', 0x27: '0', 0x28: 'Enter', 0x29: 'Escape', 0x2A: 'Backspace', 0x2B: 'Tab', 0x2C: 'Space' });
export function decodeBootKeyboardReport(input, previous = null) {
  const bytes = asUint8(input); if (bytes.length < 8) throw new RangeError('USB boot keyboard reports require 8 bytes.');
  const modifiers = bytes[0]; const codes = [...bytes.subarray(2, 8)].filter(code => code > 3);
  const previousCodes = previous ? new Set(previous.codes ?? []) : new Set();
  return freezeDeep({ modifiers, leftControl: Boolean(modifiers & 1), leftShift: Boolean(modifiers & 2), leftAlt: Boolean(modifiers & 4), leftGui: Boolean(modifiers & 8), rightControl: Boolean(modifiers & 0x10), rightShift: Boolean(modifiers & 0x20), rightAlt: Boolean(modifiers & 0x40), rightGui: Boolean(modifiers & 0x80), codes, keys: codes.map(code => HID_KEY_NAMES[code] ?? `Usage-${code.toString(16).padStart(2, '0')}`), pressed: codes.filter(code => !previousCodes.has(code)), released: [...previousCodes].filter(code => !codes.includes(code)) });
}
export function decodeBootMouseReport(input) {
  const bytes = asUint8(input); if (bytes.length < 3) throw new RangeError('USB boot mouse reports require at least 3 bytes.');
  const signed = value => value & 0x80 ? value - 0x100 : value;
  return freezeDeep({ buttons: bytes[0], left: Boolean(bytes[0] & 1), right: Boolean(bytes[0] & 2), middle: Boolean(bytes[0] & 4), x: signed(bytes[1]), y: signed(bytes[2]), wheel: bytes.length > 3 ? signed(bytes[3]) : 0 });
}

export function encodeVirtioNetHeader(options = {}) {
  const bytes = new Uint8Array(options.modern === false ? 10 : 12); const view = new DataView(bytes.buffer);
  view.setUint8(0, options.flags ?? 0); view.setUint8(1, options.gsoType ?? 0); view.setUint16(2, options.headerLength ?? 0, true); view.setUint16(4, options.gsoSize ?? 0, true); view.setUint16(6, options.checksumStart ?? 0, true); view.setUint16(8, options.checksumOffset ?? 0, true); if (bytes.length === 12) view.setUint16(10, options.bufferCount ?? 1, true); return bytes;
}
export class VirtioNetDeviceModel {
  constructor(options = {}) {
    this.deviceFeatures = BigInt(options.deviceFeatures ?? 0);
    this.driverFeatures = 0n;
    this.queueSize = powerOfTwo('queueSize', options.queueSize ?? 256, 8);
    this.rx = []; this.tx = []; this.completedTx = []; this.linkUp = options.linkUp ?? true;
    this.mac = options.mac ?? '02:00:00:00:00:01'; this.maxQueueDepth = this.queueSize - 1;
  }
  negotiate(requested) { const value = BigInt(requested); this.driverFeatures = value & this.deviceFeatures; return this.driverFeatures; }
  send(frame, options = {}) { if (!this.linkUp) throw new Error('VirtIO network link is down.'); if (this.tx.length >= this.maxQueueDepth) throw new Error('VirtIO transmit queue is full.'); const packet = { id: this.tx.length + this.completedTx.length + 1, header: encodeVirtioNetHeader(options), frame: Uint8Array.from(asUint8(frame)), submittedAt: Date.now() }; this.tx.push(packet); return packet.id; }
  devicePopTransmit() { return this.tx.shift() ?? null; }
  completeTransmit(packet, status = 0) { this.completedTx.push({ ...packet, status, completedAt: Date.now() }); }
  injectReceive(frame, options = {}) { if (this.rx.length >= this.maxQueueDepth) throw new Error('VirtIO receive queue is full.'); this.rx.push({ header: encodeVirtioNetHeader(options), frame: Uint8Array.from(asUint8(frame)), receivedAt: Date.now() }); }
  receive() { return this.rx.shift() ?? null; }
  stats() { return { queuedRx: this.rx.length, queuedTx: this.tx.length, completedTx: this.completedTx.length, linkUp: this.linkUp, negotiatedFeatures: this.driverFeatures }; }
}

export class FramebufferSurface {
  constructor({ width, height, pitch = null, format = 'xrgb8888', buffer = null } = {}) {
    this.width = integer('width', width, 1); this.height = integer('height', height, 1); this.format = format;
    this.bytesPerPixel = format === 'rgb565' ? 2 : 4;
    if (!['xrgb8888', 'bgrx8888', 'rgb565'].includes(format)) throw new TypeError(`Unsupported framebuffer format '${format}'.`);
    this.pitch = integer('pitch', pitch ?? this.width * this.bytesPerPixel, this.width * this.bytesPerPixel);
    this.buffer = buffer ? asUint8(buffer) : new Uint8Array(this.pitch * this.height);
    if (this.buffer.byteLength < this.pitch * this.height) throw new RangeError('Framebuffer buffer is smaller than the requested surface.');
  }
  #offset(x, y) { integer('x', x, 0); integer('y', y, 0); if (x >= this.width || y >= this.height) throw new RangeError(`Pixel (${x}, ${y}) is outside the framebuffer.`); return y * this.pitch + x * this.bytesPerPixel; }
  setPixel(x, y, color) {
    const offset = this.#offset(x, y); const r = (color >>> 16) & 0xFF; const g = (color >>> 8) & 0xFF; const b = color & 0xFF; const a = (color >>> 24) & 0xFF;
    if (this.format === 'xrgb8888') this.buffer.set([b, g, r, a], offset);
    else if (this.format === 'bgrx8888') this.buffer.set([r, g, b, a], offset);
    else { const value = ((r >>> 3) << 11) | ((g >>> 2) << 5) | (b >>> 3); this.buffer[offset] = value & 0xFF; this.buffer[offset + 1] = value >>> 8; }
  }
  getPixel(x, y) { const offset = this.#offset(x, y); if (this.format === 'rgb565') { const value = this.buffer[offset] | (this.buffer[offset + 1] << 8); return 0xFF000000 | (((value >>> 11) & 0x1F) << 19) | (((value >>> 5) & 0x3F) << 10) | ((value & 0x1F) << 3); } const [a, b, c, alpha] = this.buffer.subarray(offset, offset + 4); return this.format === 'xrgb8888' ? ((alpha << 24) | (c << 16) | (b << 8) | a) >>> 0 : ((alpha << 24) | (a << 16) | (b << 8) | c) >>> 0; }
  fillRect(x, y, width, height, color) { integer('width', width, 0); integer('height', height, 0); if (x < 0 || y < 0 || x + width > this.width || y + height > this.height) throw new RangeError('Rectangle is outside the framebuffer.'); for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) this.setPixel(column, row, color); }
  blit(source, sourceX, sourceY, width, height, destinationX, destinationY) { if (!(source instanceof FramebufferSurface)) throw new TypeError('source must be a FramebufferSurface.'); const colors = []; for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) colors.push(source.getPixel(sourceX + column, sourceY + row)); let index = 0; for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) this.setPixel(destinationX + column, destinationY + row, colors[index++]); }
  checksum() { return createHash('sha256').update(this.buffer.subarray(0, this.pitch * this.height)).digest('hex'); }
}

function patchBootInitialization(source) {
  const needle = '    scheduler_init()\n    smp_start_all()';
  if (!source.includes(needle)) throw new Error('Generated scheduler source does not contain the expected initialization sequence.');
  return source.replace(needle, '    scheduler_init()\n    init_platform_firmware(boot_info)\n    init_userspace(GDT_BASE)\n    init_hardware_drivers()\n    smp_start_all()');
}

export function createHardwareKernelSource(options = {}) {
  const manifest = createHardwareManifest(options); const L = manifest.layout;
  const prefix = options.fragment ? '' : '#![system]\n#![no_std]\n#![no_main]\n\n';
  const core = `${prefix}const PCI_CONFIG_ADDRESS_PORT: u16 = 0xCF8
const PCI_CONFIG_DATA_PORT: u16 = 0xCFC
const DMA_POOL_BASE: usize = ${L.dmaPool}
const DMA_POOL_SIZE: usize = ${L.dmaPoolSize}
const NVME_ADMIN_SQ: usize = ${L.nvmeAdminSubmission}
const NVME_ADMIN_CQ: usize = ${L.nvmeAdminCompletion}
const NVME_IO_SQ: usize = ${L.nvmeIoSubmission}
const NVME_IO_CQ: usize = ${L.nvmeIoCompletion}
const XHCI_COMMAND_RING: usize = ${L.xhciCommandRing}
const XHCI_EVENT_RING: usize = ${L.xhciEventRing}
const VIRTIO_NET_RX: usize = ${L.virtioNetRx}
const VIRTIO_NET_TX: usize = ${L.virtioNetTx}
const VIRTIO_NET_RX_PFN: u32 = ${L.virtioNetRx >> 12}
const VIRTIO_NET_TX_PFN: u32 = ${L.virtioNetTx >> 12}
const FRAMEBUFFER_SHADOW: usize = ${L.framebufferShadow}

static mut NVME_BASE: usize = 0
static mut XHCI_BASE: usize = 0
static mut VIRTIO_NET_IO: u16 = 0
static mut FRAMEBUFFER_BASE: usize = 0
static mut FRAMEBUFFER_WIDTH: usize = 0
static mut FRAMEBUFFER_HEIGHT: usize = 0
static mut FRAMEBUFFER_PITCH: usize = 0
static mut HARDWARE_READY: bool = false

unsafe fn pci_config_address(bus: u8, device: u8, function: u8, offset: u8) -> u32 {
    return 0x80000000 | (bus << 16) | (device << 11) | (function << 8) | (offset & 0xFC)
}

unsafe fn pci_read32(bus: u8, device: u8, function: u8, offset: u8) -> u32 {
    io.out32(PCI_CONFIG_ADDRESS_PORT, pci_config_address(bus, device, function, offset))
    return io.in32(PCI_CONFIG_DATA_PORT)
}

unsafe fn pci_write32(bus: u8, device: u8, function: u8, offset: u8, value: u32) {
    io.out32(PCI_CONFIG_ADDRESS_PORT, pci_config_address(bus, device, function, offset))
    io.out32(PCI_CONFIG_DATA_PORT, value)
}

unsafe fn nvme_wait_ready(base: usize, ready: bool) -> bool {
    let spins: usize = 0
    while spins < 10000000 {
        let status: u32 = memory.volatile_read<u32>(base + 0x1C)
        if ready {
            if (status & 1) != 0 { return true }
        } else {
            if (status & 1) == 0 { return true }
        }
        spins += 1
    }
    return false
}

unsafe fn nvme_init(base: usize) -> bool {
    NVME_BASE = base
    let capabilities: u64 = memory.volatile_read<u64>(base)
    let timeout: u64 = (capabilities >> 24) & 0xFF
    let configuration: u32 = memory.volatile_read<u32>(base + 0x14)
    memory.volatile_write<u32>(base + 0x14, configuration & 0xFFFFFFFE)
    if !nvme_wait_ready(base, false) { return false }
    memory.volatile_write<u32>(base + 0x24, ((${L.nvmeQueueDepth} - 1) << 16) | (${L.nvmeQueueDepth} - 1))
    memory.volatile_write<u64>(base + 0x28, NVME_ADMIN_SQ)
    memory.volatile_write<u64>(base + 0x30, NVME_ADMIN_CQ)
    memory.volatile_write<u32>(base + 0x14, (6 << 16) | (4 << 20) | 1)
    if timeout == 0 { return nvme_wait_ready(base, true) }
    return nvme_wait_ready(base, true)
}

unsafe fn xhci_init(base: usize) -> bool {
    XHCI_BASE = base
    let capability_length: usize = memory.volatile_read<u8>(base)
    let operational: usize = base + capability_length
    let command: u32 = memory.volatile_read<u32>(operational)
    memory.volatile_write<u32>(operational, command & 0xFFFFFFFE)
    let spins: usize = 0
    while spins < 10000000 && (memory.volatile_read<u32>(operational + 4) & 1) == 0 { spins += 1 }
    memory.volatile_write<u32>(operational, memory.volatile_read<u32>(operational) | 2)
    let reset_spins: usize = 0
    while reset_spins < 10000000 && (memory.volatile_read<u32>(operational) & 2) != 0 { reset_spins += 1 }
    memory.volatile_write<u64>(operational + 0x18, XHCI_COMMAND_RING | 1)
    memory.volatile_write<u32>(operational, memory.volatile_read<u32>(operational) | 1)
    return (memory.volatile_read<u32>(operational + 4) & 1) == 0
}

unsafe fn virtio_net_init(io_base: u16) -> bool {
    VIRTIO_NET_IO = io_base
    io.out8(io_base + 0x12, 0)
    io.out8(io_base + 0x12, 1)
    let features: u32 = io.in32(io_base)
    io.out32(io_base + 4, features & 0x20)
    io.out16(io_base + 14, 0)
    io.out32(io_base + 8, VIRTIO_NET_RX_PFN)
    io.out16(io_base + 14, 1)
    io.out32(io_base + 8, VIRTIO_NET_TX_PFN)
    io.out8(io_base + 0x12, 7)
    return (io.in8(io_base + 0x12) & 0x80) == 0
}

pub unsafe fn framebuffer_configure(base: usize, width: usize, height: usize, pitch: usize) {
    FRAMEBUFFER_BASE = base
    FRAMEBUFFER_WIDTH = width
    FRAMEBUFFER_HEIGHT = height
    FRAMEBUFFER_PITCH = pitch
}

pub unsafe fn framebuffer_put_pixel(x: usize, y: usize, color: u32) {
    if FRAMEBUFFER_BASE == 0 || x >= FRAMEBUFFER_WIDTH || y >= FRAMEBUFFER_HEIGHT { return }
    memory.volatile_write<u32>(FRAMEBUFFER_BASE + y * FRAMEBUFFER_PITCH + x * 4, color)
}

pub unsafe fn init_hardware_drivers() {
    init_pci_dma_interrupt_runtime()
    NVME_BASE = 0
    XHCI_BASE = 0
    VIRTIO_NET_IO = 0
    HARDWARE_READY = true
}
`;
  return `${core}\n\n${createPlatformFirmwareKernelSource({ ...options, fragment: true })}\n\n${createHardwareRuntimeKernelSource({ ...options, fragment: true })}`;
}

export function createCompleteHardwareKernelSource(options = {}) {
  const userspace = createCompleteUserspaceKernelSource(options);
  return `${patchBootInitialization(userspace)}\n\n${createHardwareKernelSource({ ...options, fragment: true })}`;
}

export function createHardwareBuildPlan(options = {}) {
  const userspace = createUserspaceBuildPlan({ ...options, outDir: options.outDir ?? 'build/hardware' });
  return { ...userspace, hardwareManifest: path.join(userspace.outDir, 'kura-hardware.json'), hardwareSource: path.join(userspace.outDir, 'kernel-hardware.kr') };
}

export async function buildHardwareKernel(source = null, options = {}) {
  const plan = options.plan ?? createHardwareBuildPlan(options);
  const kernelSource = source ?? createCompleteHardwareKernelSource(options);
  await mkdir(plan.outDir, { recursive: true });
  if (!options.dryRun) {
    await writeFile(plan.hardwareSource, kernelSource, 'utf8');
    await writeFile(plan.hardwareManifest, JSON.stringify(createHardwareManifest(options), (_, value) => typeof value === 'bigint' ? `0x${value.toString(16)}` : value, 2) + '\n', 'utf8');
  }
  return buildUserspaceKernel(kernelSource, { ...options, plan });
}

export async function runHardwareQemuSmoke(options = {}) {
  const outDir = path.resolve(options.outDir ?? 'build/hardware-qemu-smoke');
  const completeSource = createCompleteHardwareKernelSource({ ...options, smoke: true });
  const checkpoint = '    init_identity_paging()\n    page_table_pool_init()';
  if (!completeSource.includes(checkpoint)) throw new Error('Generated smoke kernel has no paging checkpoint.');
  const smokeSource = completeSource.replace(checkpoint, `    init_identity_paging()
    serial_write_byte(0x51)
    io.out32(0xF4, SMOKE_EXIT_CODE)
    cpu.halt()
    page_table_pool_init()`);
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

export function hardwareFingerprint(options = {}) {
  return createHash('sha256').update(JSON.stringify(createHardwareManifest(options))).update(createHardwareKernelSource(options)).digest('hex');
}

export async function hardwareSmokeTest() {
  const queue = new NvmeQueueModel(8);
  const command = createNvmeReadWriteCommand({ namespaceId: 1, startLba: 4n, blockCount: 2, prp1: 0x1000, prp2: 0x2000 });
  const submitted = queue.submit(command, { operation: 'read' });
  const device = queue.devicePopSubmission(); queue.complete({ commandId: device.commandId, result: 2 }); const completion = queue.driverPopCompletion();
  const ring = new XhciRingModel(16, { baseAddress: 0x4000n }); ring.enqueue(encodeXhciTrb({ type: 9, parameter: 1n }));
  const keyboard = decodeBootKeyboardReport([2, 0, 4, 0, 0, 0, 0, 0]);
  const net = new VirtioNetDeviceModel({ deviceFeatures: 0x20n, queueSize: 8 }); net.negotiate(0x20n); net.send([0, 1, 2]);
  const framebuffer = new FramebufferSurface({ width: 4, height: 4 }); framebuffer.fillRect(1, 1, 2, 2, 0xFF336699);
  const runtime = await hardwareRuntimeSmokeTest();
  return { ok: completion.success && runtime.ok, commandId: submitted.commandId, xhciType: ring.hardwarePop().type, key: keyboard.keys[0], txQueued: net.stats().queuedTx, framebuffer: framebuffer.checksum(), runtime, fingerprint: hardwareFingerprint() };
}
