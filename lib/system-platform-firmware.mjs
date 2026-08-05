// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from 'node:crypto';

function bytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return Uint8Array.from(input ?? []);
}
function view(input) { const value = bytes(input); return new DataView(value.buffer, value.byteOffset, value.byteLength); }
function text(input, offset, length) { return String.fromCharCode(...bytes(input).subarray(offset, offset + length)).replace(/\0+$/g, '').trim(); }
function safeInteger(name, value, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer in [${min}, ${max}].`); return value; }
function asBigInt(name, value) { try { const result = BigInt(value); if (result < 0n) throw new TypeError(); return result; } catch { throw new TypeError(`${name} must be a non-negative integer.`); } }
function acpiChecksum(input, offset = 0, length = bytes(input).byteLength - offset) { const data = bytes(input); let sum = 0; for (let index = offset; index < offset + length; index++) sum = (sum + data[index]) & 0xFF; return sum; }

export function parseRsdp(input, offset = 0) {
  const data = bytes(input); if (offset < 0 || offset + 20 > data.byteLength) throw new RangeError('RSDP is truncated.');
  if (text(data, offset, 8) !== 'RSD PTR') throw new Error('RSDP signature is invalid.');
  const v = view(data); const revision = v.getUint8(offset + 15); const length = revision >= 2 ? v.getUint32(offset + 20, true) : 20;
  if (offset + length > data.byteLength) throw new RangeError('RSDP length exceeds the available bytes.');
  if (acpiChecksum(data, offset, 20) !== 0) throw new Error('RSDP v1 checksum is invalid.');
  if (revision >= 2 && acpiChecksum(data, offset, length) !== 0) throw new Error('RSDP extended checksum is invalid.');
  return Object.freeze({ signature: 'RSD PTR ', oemId: text(data, offset + 9, 6), revision, length, rsdtAddress: v.getUint32(offset + 16, true), xsdtAddress: revision >= 2 ? v.getBigUint64(offset + 24, true) : 0n });
}

export function parseAcpiSdtHeader(input, offset = 0) {
  const data = bytes(input); if (offset < 0 || offset + 36 > data.byteLength) throw new RangeError('ACPI SDT header is truncated.');
  const v = view(data); const length = v.getUint32(offset + 4, true); if (length < 36 || offset + length > data.byteLength) throw new RangeError('ACPI SDT length is invalid.');
  return Object.freeze({ signature: text(data, offset, 4), length, revision: v.getUint8(offset + 8), checksum: v.getUint8(offset + 9), checksumValid: acpiChecksum(data, offset, length) === 0, oemId: text(data, offset + 10, 6), oemTableId: text(data, offset + 16, 8), oemRevision: v.getUint32(offset + 24, true), creatorId: v.getUint32(offset + 28, true), creatorRevision: v.getUint32(offset + 32, true) });
}

export class AcpiMemoryImage {
  constructor(regions = []) { this.regions = []; for (const region of regions) this.map(region.address, region.bytes ?? region.data); }
  map(address, input) { const base = asBigInt('address', address); const data = bytes(input).slice(); if (!data.byteLength) throw new RangeError('ACPI region may not be empty.'); this.regions.push({ base, end: base + BigInt(data.byteLength), data }); this.regions.sort((a, b) => a.base < b.base ? -1 : a.base > b.base ? 1 : 0); return this; }
  read(address, length) { const start = asBigInt('address', address); safeInteger('length', length, 0); const end = start + BigInt(length); const region = this.regions.find(item => start >= item.base && end <= item.end); if (!region) throw new RangeError(`ACPI physical range 0x${start.toString(16)}..0x${end.toString(16)} is unmapped.`); const offset = Number(start - region.base); return region.data.slice(offset, offset + length); }
  table(address) { const header = this.read(address, 36); const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4, true); return this.read(address, length); }
}

export function discoverAcpiTables(rsdpInput, memory) {
  if (!(memory instanceof AcpiMemoryImage)) throw new TypeError('memory must be an AcpiMemoryImage.');
  const rsdp = parseRsdp(rsdpInput); const rootAddress = rsdp.xsdtAddress !== 0n ? rsdp.xsdtAddress : BigInt(rsdp.rsdtAddress); const root = memory.table(rootAddress); const header = parseAcpiSdtHeader(root); if (!header.checksumValid) throw new Error(`${header.signature} checksum is invalid.`);
  const pointerSize = header.signature === 'XSDT' ? 8 : 4; const v = view(root); const tables = new Map();
  for (let offset = 36; offset + pointerSize <= header.length; offset += pointerSize) { const address = pointerSize === 8 ? v.getBigUint64(offset, true) : BigInt(v.getUint32(offset, true)); const table = memory.table(address); const tableHeader = parseAcpiSdtHeader(table); if (!tableHeader.checksumValid) throw new Error(`${tableHeader.signature} checksum is invalid.`); const list = tables.get(tableHeader.signature) ?? []; list.push(Object.freeze({ address, header: tableHeader, bytes: table })); tables.set(tableHeader.signature, list); }
  return Object.freeze({ rsdp, root: Object.freeze({ address: rootAddress, header, bytes: root }), tables });
}

export function parseMcfg(input) {
  const data = bytes(input); const header = parseAcpiSdtHeader(data); if (header.signature !== 'MCFG') throw new Error('ACPI table is not MCFG.'); if (!header.checksumValid) throw new Error('MCFG checksum is invalid.'); const v = view(data); const allocations = [];
  for (let offset = 44; offset + 16 <= header.length; offset += 16) { const baseAddress = v.getBigUint64(offset, true); const segment = v.getUint16(offset + 8, true); const startBus = v.getUint8(offset + 10); const endBus = v.getUint8(offset + 11); if (startBus > endBus) throw new Error('MCFG bus range is inverted.'); allocations.push(Object.freeze({ baseAddress, segment, startBus, endBus, byteLength: BigInt(endBus - startBus + 1) << 20n })); }
  return Object.freeze({ header, allocations: Object.freeze(allocations) });
}

export class PcieEcamModel {
  constructor(allocations = []) { this.allocations = [...allocations]; this.functions = new Map(); }
  address(segment, bus, device, functionNumber, offset = 0) { safeInteger('segment', segment, 0, 0xFFFF); safeInteger('bus', bus, 0, 255); safeInteger('device', device, 0, 31); safeInteger('functionNumber', functionNumber, 0, 7); safeInteger('offset', offset, 0, 4095); const allocation = this.allocations.find(item => item.segment === segment && bus >= item.startBus && bus <= item.endBus); if (!allocation) throw new RangeError('No MCFG allocation covers this PCI function.'); return allocation.baseAddress + (BigInt(bus - allocation.startBus) << 20n) + (BigInt(device) << 15n) + (BigInt(functionNumber) << 12n) + BigInt(offset); }
  addFunction({ segment = 0, bus, device, functionNumber = 0, config }) { const data = bytes(config).slice(); if (data.byteLength > 4096) throw new RangeError('PCIe configuration function exceeds 4 KiB.'); const full = new Uint8Array(4096); full.set(data); this.functions.set(`${segment}:${bus}:${device}:${functionNumber}`, full); return this; }
  #data(segment, bus, device, functionNumber) { return this.functions.get(`${segment}:${bus}:${device}:${functionNumber}`) ?? new Uint8Array(4096).fill(0xFF); }
  read32(segment, bus, device, functionNumber, offset) { if ((offset & 3) !== 0) throw new RangeError('ECAM dword offset must be aligned.'); this.address(segment, bus, device, functionNumber, offset); const data = this.#data(segment, bus, device, functionNumber); return new DataView(data.buffer).getUint32(offset, true); }
  write32(segment, bus, device, functionNumber, offset, value) { if ((offset & 3) !== 0) throw new RangeError('ECAM dword offset must be aligned.'); this.address(segment, bus, device, functionNumber, offset); const key = `${segment}:${bus}:${device}:${functionNumber}`; const data = this.#data(segment, bus, device, functionNumber).slice(); new DataView(data.buffer).setUint32(offset, value >>> 0, true); this.functions.set(key, data); }
}

export function parsePciCapabilities(input, options = {}) {
  const data = bytes(input); if (data.byteLength < 256) throw new RangeError('PCI configuration space requires at least 256 bytes.'); const v = view(data); const capabilities = []; const visited = new Set(); let offset = v.getUint8(options.pointerOffset ?? 0x34) & 0xFC;
  while (offset >= 0x40 && offset + 2 <= data.byteLength && !visited.has(offset)) { visited.add(offset); const id = v.getUint8(offset); const next = v.getUint8(offset + 1) & 0xFC; capabilities.push(Object.freeze({ id, offset, next })); if (!next) break; offset = next; }
  const extended = []; visited.clear(); offset = 0x100;
  while (offset + 4 <= data.byteLength && !visited.has(offset)) { visited.add(offset); const header = v.getUint32(offset, true); if (header === 0 || header === 0xFFFFFFFF) break; const id = header & 0xFFFF; const version = (header >>> 16) & 0xF; const next = (header >>> 20) & 0xFFF; extended.push(Object.freeze({ id, version, offset, next })); if (!next) break; offset = next; }
  return Object.freeze({ capabilities: Object.freeze(capabilities), extended: Object.freeze(extended) });
}

export function parseMsixCapability(input, offset) { const data = bytes(input); safeInteger('offset', offset, 0); if (offset + 12 > data.byteLength) throw new RangeError('MSI-X capability is truncated.'); const v = view(data); if (v.getUint8(offset) !== 0x11) throw new Error('Capability is not MSI-X.'); const control = v.getUint16(offset + 2, true); const table = v.getUint32(offset + 4, true); const pba = v.getUint32(offset + 8, true); return Object.freeze({ offset, tableSize: (control & 0x7FF) + 1, functionMask: Boolean(control & 0x4000), enabled: Boolean(control & 0x8000), tableBir: table & 7, tableOffset: table & 0xFFFFFFF8, pbaBir: pba & 7, pbaOffset: pba & 0xFFFFFFF8 }); }
export function mapMsixCapability(capability, bars) { const tableBar = bars[capability.tableBir]; const pbaBar = bars[capability.pbaBir]; if (!tableBar || !pbaBar) throw new Error('MSI-X capability refers to an unavailable BAR.'); const tableAddress = asBigInt('table BAR', tableBar.base ?? tableBar.address) + BigInt(capability.tableOffset); const pbaAddress = asBigInt('PBA BAR', pbaBar.base ?? pbaBar.address) + BigInt(capability.pbaOffset); return Object.freeze({ ...capability, tableAddress, tableBytes: capability.tableSize * 16, pbaAddress, pbaBytes: Math.ceil(capability.tableSize / 64) * 8 }); }

function parseDeviceScopes(data, start, end) { const v = view(data); const scopes = []; let offset = start; while (offset + 6 <= end) { const type = v.getUint8(offset); const length = v.getUint8(offset + 1); if (length < 6 || offset + length > end) break; const path = []; for (let cursor = offset + 6; cursor + 2 <= offset + length; cursor += 2) path.push(Object.freeze({ device: v.getUint8(cursor), functionNumber: v.getUint8(cursor + 1) })); scopes.push(Object.freeze({ type, enumerationId: v.getUint8(offset + 4), startBus: v.getUint8(offset + 5), path: Object.freeze(path) })); offset += length; } return Object.freeze(scopes); }

export function parseDmar(input) { const data = bytes(input); const header = parseAcpiSdtHeader(data); if (header.signature !== 'DMAR') throw new Error('ACPI table is not DMAR.'); const v = view(data); const structures = []; for (let offset = 48; offset + 4 <= header.length;) { const type = v.getUint16(offset, true); const length = v.getUint16(offset + 2, true); if (length < 4 || offset + length > header.length) throw new Error('DMAR structure length is invalid.'); if (type === 0 && length >= 16) structures.push(Object.freeze({ type: 'DRHD', flags: v.getUint8(offset + 4), segment: v.getUint16(offset + 6, true), registerBase: v.getBigUint64(offset + 8, true), scopes: parseDeviceScopes(data, offset + 16, offset + length) })); else if (type === 1 && length >= 24) structures.push(Object.freeze({ type: 'RMRR', segment: v.getUint16(offset + 6, true), base: v.getBigUint64(offset + 8, true), limit: v.getBigUint64(offset + 16, true), scopes: parseDeviceScopes(data, offset + 24, offset + length) })); else structures.push(Object.freeze({ type: `DMAR-${type}`, length })); offset += length; } return Object.freeze({ header, hostAddressWidth: v.getUint8(36) + 1, flags: v.getUint8(37), structures: Object.freeze(structures) }); }

export function parseIvrs(input) { const data = bytes(input); const header = parseAcpiSdtHeader(data); if (header.signature !== 'IVRS') throw new Error('ACPI table is not IVRS.'); const v = view(data); const structures = []; for (let offset = 48; offset + 4 <= header.length;) { const type = v.getUint8(offset); const flags = v.getUint8(offset + 1); const length = v.getUint16(offset + 2, true); if (length < 4 || offset + length > header.length) throw new Error('IVRS structure length is invalid.'); if ((type & 0xF0) === 0x10 && length >= 24) structures.push(Object.freeze({ type: 'IVHD', hardwareType: type, flags, deviceId: v.getUint16(offset + 4, true), capabilityOffset: v.getUint16(offset + 6, true), registerBase: v.getBigUint64(offset + 8, true), segment: v.getUint16(offset + 16, true) })); else structures.push(Object.freeze({ type: `IVRS-${type}`, length })); offset += length; } return Object.freeze({ header, ivInfo: v.getUint32(36, true), structures: Object.freeze(structures) }); }

export class VtdRemappingUnitModel {
  constructor({ registerBase, segment = 0, includeAll = false } = {}) { this.registerBase = asBigInt('registerBase', registerBase); this.segment = safeInteger('segment', segment, 0, 0xFFFF); this.includeAll = Boolean(includeAll); this.rootTable = 0n; this.translationEnabled = false; this.contexts = new Map(); this.invalidations = []; }
  configureRootTable(address) { const value = asBigInt('root table', address); if (value & 0xFFFn) throw new RangeError('VT-d root table must be page aligned.'); this.rootTable = value; }
  attach(requesterId, domainId, rootAddress, permissions = 'rw') { safeInteger('requesterId', requesterId, 0, 0xFFFF); safeInteger('domainId', domainId, 1, 0xFFFF); const root = asBigInt('domain root', rootAddress); if (root & 0xFFFn) throw new RangeError('VT-d domain root must be page aligned.'); this.contexts.set(requesterId, Object.freeze({ domainId, rootAddress: root, permissions })); }
  enable() { if (!this.rootTable) throw new Error('VT-d root table has not been configured.'); this.translationEnabled = true; }
  invalidate(kind = 'global', identifier = 0) { this.invalidations.push(Object.freeze({ sequence: this.invalidations.length + 1, kind, identifier })); }
}

export class AmdViRemappingUnitModel {
  constructor({ registerBase, segment = 0 } = {}) { this.registerBase = asBigInt('registerBase', registerBase); this.segment = safeInteger('segment', segment, 0, 0xFFFF); this.deviceTable = 0n; this.enabled = false; this.entries = new Map(); this.commands = []; }
  configureDeviceTable(address) { const value = asBigInt('device table', address); if (value & 0xFFFn) throw new RangeError('AMD-Vi device table must be page aligned.'); this.deviceTable = value; }
  attach(deviceId, domainId, rootAddress) { safeInteger('deviceId', deviceId, 0, 0xFFFF); safeInteger('domainId', domainId, 1, 0xFFFF); this.entries.set(deviceId, Object.freeze({ domainId, rootAddress: asBigInt('rootAddress', rootAddress) })); }
  enable() { if (!this.deviceTable) throw new Error('AMD-Vi device table has not been configured.'); this.enabled = true; }
  invalidate(deviceId = 0xFFFF) { this.commands.push(Object.freeze({ command: 'invalidate-device-table', deviceId })); }
}

export function createPlatformFirmwareManifest() { return Object.freeze({ acpi: { rsdp: ['v1', 'v2'], roots: ['RSDT', 'XSDT'], tables: ['MCFG', 'DMAR', 'IVRS'], checksumValidation: true }, pcie: { ecam: true, segments: true, configurationBytesPerFunction: 4096, capabilityWalking: true, extendedCapabilities: true, msixMapping: true }, iommu: { intelVtd: { discovery: 'DMAR', rootContextModel: true, queuedInvalidationPlan: true }, amdVi: { discovery: 'IVRS', deviceTableModel: true, invalidationPlan: true } }, boot: { multiboot2AcpiTags: [14, 15], qemuSmoke: true } }); }

export function createPlatformFirmwareKernelSource(options = {}) {
  const prefix = options.fragment ? '' : '#![system]\n#![no_std]\n#![no_main]\n\n';
  return `${prefix}const ACPI_RSDP_SIGNATURE_LOW: u32 = 0x20445352
const ACPI_RSDP_SIGNATURE_HIGH: u32 = 0x20525450
const ACPI_SIGNATURE_MCFG: u32 = 0x4746434D
const ACPI_SIGNATURE_DMAR: u32 = 0x52414D44
const ACPI_SIGNATURE_IVRS: u32 = 0x53525649

static mut ACPI_RSDP: usize = 0
static mut ACPI_MCFG: usize = 0
static mut ACPI_DMAR: usize = 0
static mut ACPI_IVRS: usize = 0
static mut PCIE_ECAM_BASE: u64 = 0
static mut PCIE_ECAM_SEGMENT: u16 = 0
static mut PCIE_ECAM_START_BUS: u8 = 0
static mut PCIE_ECAM_END_BUS: u8 = 0
static mut VTD_REGISTER_BASE: u64 = 0
static mut AMDVI_REGISTER_BASE: u64 = 0
static mut IOMMU_ROOT_TABLE: usize = 0

unsafe fn acpi_parse_mcfg(table: usize) -> bool {
    if table == 0 { return false }
    let length: usize = memory.read<u32>(table + 4)
    if length < 60 { return false }
    let allocation: usize = table + 44
    PCIE_ECAM_BASE = memory.read<u64>(allocation)
    PCIE_ECAM_SEGMENT = memory.read<u16>(allocation + 8)
    PCIE_ECAM_START_BUS = memory.read<u8>(allocation + 10)
    PCIE_ECAM_END_BUS = memory.read<u8>(allocation + 11)
    return PCIE_ECAM_BASE != 0 && PCIE_ECAM_START_BUS <= PCIE_ECAM_END_BUS
}

unsafe fn pcie_ecam_address(segment: u16, bus: u8, device: u8, function: u8, offset: usize) -> usize {
    if PCIE_ECAM_BASE == 0 || segment != PCIE_ECAM_SEGMENT || bus < PCIE_ECAM_START_BUS || bus > PCIE_ECAM_END_BUS || device >= 32 || function >= 8 || offset >= 4096 { return 0 }
    return PCIE_ECAM_BASE + ((bus - PCIE_ECAM_START_BUS) << 20) + (device << 15) + (function << 12) + offset
}

unsafe fn pci_runtime_read32(bus: u8, device: u8, function: u8, offset: usize) -> u32 {
    let address: usize = pcie_ecam_address(0, bus, device, function, offset)
    if address != 0 { return memory.volatile_read<u32>(address) }
    return pci_read32(bus, device, function, offset)
}

unsafe fn pci_runtime_write32(bus: u8, device: u8, function: u8, offset: usize, value: u32) {
    let address: usize = pcie_ecam_address(0, bus, device, function, offset)
    if address != 0 { memory.volatile_write<u32>(address, value); return }
    pci_write32(bus, device, function, offset, value)
}

unsafe fn pci_find_capability(bus: u8, device: u8, function: u8, capability_id: u8) -> usize {
    let status_command: u32 = pci_runtime_read32(bus, device, function, 0x04)
    if ((status_command >> 20) & 1) == 0 { return 0 }
    let pointer_value: u32 = pci_runtime_read32(bus, device, function, 0x34)
    let pointer: usize = pointer_value & 0xFC
    let remaining: usize = 48
    while pointer >= 0x40 && remaining > 0 {
        let header: u32 = pci_runtime_read32(bus, device, function, pointer)
        if (header & 0xFF) == capability_id { return pointer }
        pointer = (header >> 8) & 0xFC
        remaining -= 1
    }
    return 0
}

unsafe fn pci_map_msix_capability(bus: u8, device: u8, function: u8, bar0: usize, bar1: usize, bar2: usize, bar3: usize, bar4: usize, bar5: usize) -> usize {
    let capability: usize = pci_find_capability(bus, device, function, 0x11)
    if capability == 0 { return 0 }
    let table: u32 = pci_runtime_read32(bus, device, function, capability + 4)
    let bir: u8 = table & 7
    let offset: usize = table & 0xFFFFFFF8
    let base: usize = 0
    if bir == 0 { base = bar0 } else if bir == 1 { base = bar1 } else if bir == 2 { base = bar2 } else if bir == 3 { base = bar3 } else if bir == 4 { base = bar4 } else if bir == 5 { base = bar5 }
    if base == 0 { return 0 }
    return base + offset
}

unsafe fn vtd_discover(table: usize) -> bool {
    if table == 0 { return false }
    let length: usize = memory.read<u32>(table + 4)
    let cursor: usize = table + 48
    while cursor + 16 <= table + length {
        let entry_type: u16 = memory.read<u16>(cursor)
        let entry_length: usize = memory.read<u16>(cursor + 2)
        if entry_length < 4 { return false }
        if entry_type == 0 && entry_length >= 16 { VTD_REGISTER_BASE = memory.read<u64>(cursor + 8); return VTD_REGISTER_BASE != 0 }
        cursor += entry_length
    }
    return false
}

unsafe fn amdvi_discover(table: usize) -> bool {
    if table == 0 { return false }
    let length: usize = memory.read<u32>(table + 4)
    let cursor: usize = table + 48
    while cursor + 24 <= table + length {
        let entry_type: u8 = memory.read<u8>(cursor)
        let entry_length: usize = memory.read<u16>(cursor + 2)
        if entry_length < 4 { return false }
        if (entry_type & 0xF0) == 0x10 && entry_length >= 24 { AMDVI_REGISTER_BASE = memory.read<u64>(cursor + 8); return AMDVI_REGISTER_BASE != 0 }
        cursor += entry_length
    }
    return false
}

unsafe fn iommu_prepare_root() -> bool {
    if IOMMU_ROOT_TABLE == 0 { IOMMU_ROOT_TABLE = dma_alloc_pages(1, 4096) }
    return IOMMU_ROOT_TABLE != 0
}

unsafe fn vtd_enable_translation() -> bool {
    if VTD_REGISTER_BASE == 0 || !iommu_prepare_root() { return false }
    memory.volatile_write<u64>(VTD_REGISTER_BASE + 0x20, IOMMU_ROOT_TABLE)
    memory.volatile_write<u32>(VTD_REGISTER_BASE + 0x18, memory.volatile_read<u32>(VTD_REGISTER_BASE + 0x18) | 0x80000000)
    return true
}

unsafe fn amdvi_enable_translation() -> bool {
    if AMDVI_REGISTER_BASE == 0 || !iommu_prepare_root() { return false }
    memory.volatile_write<u64>(AMDVI_REGISTER_BASE + 0x00, IOMMU_ROOT_TABLE)
    memory.volatile_write<u64>(AMDVI_REGISTER_BASE + 0x18, memory.volatile_read<u64>(AMDVI_REGISTER_BASE + 0x18) | 1)
    return true
}

pub unsafe fn init_platform_firmware(boot_info: usize) {
    ACPI_RSDP = RSDP_ADDRESS
    ACPI_MCFG = acpi_find_table(ACPI_SIGNATURE_MCFG)
    ACPI_DMAR = acpi_find_table(ACPI_SIGNATURE_DMAR)
    ACPI_IVRS = acpi_find_table(ACPI_SIGNATURE_IVRS)
    acpi_parse_mcfg(ACPI_MCFG)
    if vtd_discover(ACPI_DMAR) { vtd_enable_translation() }
    if amdvi_discover(ACPI_IVRS) { amdvi_enable_translation() }
}
`;
}

function buildTable(signature, body, options = {}) { const length = 36 + body.byteLength; const data = new Uint8Array(length); const v = new DataView(data.buffer); data.set([...signature].map(c => c.charCodeAt(0)), 0); v.setUint32(4, length, true); v.setUint8(8, options.revision ?? 1); data.set([...((options.oemId ?? 'KURA  ').padEnd(6).slice(0, 6))].map(c => c.charCodeAt(0)), 10); data.set([...((options.oemTableId ?? 'KURATEST').padEnd(8).slice(0, 8))].map(c => c.charCodeAt(0)), 16); v.setUint32(24, 1, true); v.setUint32(28, 0x4152554B, true); v.setUint32(32, 1, true); data.set(body, 36); v.setUint8(9, (-acpiChecksum(data)) & 0xFF); return data; }

export async function platformFirmwareSmokeTest() {
  const mcfgBody = new Uint8Array(24); const mcfgView = new DataView(mcfgBody.buffer); mcfgView.setBigUint64(8, 0xE0000000n, true); mcfgView.setUint16(16, 0, true); mcfgView.setUint8(18, 0); mcfgView.setUint8(19, 0x7F); const mcfg = buildTable('MCFG', mcfgBody);
  const dmarBody = new Uint8Array(28); const dmarView = new DataView(dmarBody.buffer); dmarView.setUint8(0, 47); dmarView.setUint16(12, 0, true); dmarView.setUint16(14, 16, true); dmarView.setBigUint64(20, 0xFED90000n, true); const dmar = buildTable('DMAR', dmarBody);
  const xsdtBody = new Uint8Array(16); const xsdtView = new DataView(xsdtBody.buffer); xsdtView.setBigUint64(0, 0x2000n, true); xsdtView.setBigUint64(8, 0x3000n, true); const xsdt = buildTable('XSDT', xsdtBody);
  const rsdp = new Uint8Array(36); const rsdpView = new DataView(rsdp.buffer); rsdp.set([... 'RSD PTR '].map(c => c.charCodeAt(0)), 0); rsdp.set([... 'KURA  '].map(c => c.charCodeAt(0)), 9); rsdpView.setUint8(15, 2); rsdpView.setUint32(20, 36, true); rsdpView.setBigUint64(24, 0x1000n, true); rsdpView.setUint8(8, (-acpiChecksum(rsdp, 0, 20)) & 0xFF); rsdpView.setUint8(32, (-acpiChecksum(rsdp)) & 0xFF);
  const memory = new AcpiMemoryImage([{ address: 0x1000n, bytes: xsdt }, { address: 0x2000n, bytes: mcfg }, { address: 0x3000n, bytes: dmar }]); const discovered = discoverAcpiTables(rsdp, memory); const parsedMcfg = parseMcfg(discovered.tables.get('MCFG')[0].bytes); const parsedDmar = parseDmar(discovered.tables.get('DMAR')[0].bytes);
  const config = new Uint8Array(4096); const cv = new DataView(config.buffer); cv.setUint16(0, 0x8086, true); cv.setUint16(2, 0x1234, true); cv.setUint16(6, 0x10, true); cv.setUint8(0x34, 0x50); cv.setUint8(0x50, 0x11); cv.setUint16(0x52, 3, true); cv.setUint32(0x54, 0x2000, true); cv.setUint32(0x58, 0x3000, true); const ecam = new PcieEcamModel(parsedMcfg.allocations).addFunction({ bus: 0, device: 1, config }); const vendor = ecam.read32(0, 0, 1, 0, 0) & 0xFFFF; const caps = parsePciCapabilities(config); const msix = mapMsixCapability(parseMsixCapability(config, 0x50), [{ base: 0x90000000n }]);
  const vtd = new VtdRemappingUnitModel({ registerBase: parsedDmar.structures[0].registerBase }); vtd.configureRootTable(0x400000n); vtd.attach(0x100, 1, 0x500000n); vtd.enable(); vtd.invalidate();
  return { ok: vendor === 0x8086 && parsedMcfg.allocations.length === 1 && parsedDmar.structures[0].type === 'DRHD' && caps.capabilities[0].id === 0x11 && msix.tableAddress === 0x90002000n && vtd.translationEnabled, rsdp: discovered.rsdp, tables: [...discovered.tables.keys()], mcfg: parsedMcfg.allocations, dmar: parsedDmar.structures, msix, vtd: { rootTable: vtd.rootTable, contexts: vtd.contexts.size, invalidations: vtd.invalidations.length }, fingerprint: createHash('sha256').update(JSON.stringify(createPlatformFirmwareManifest())).update(createPlatformFirmwareKernelSource()).digest('hex') };
}
