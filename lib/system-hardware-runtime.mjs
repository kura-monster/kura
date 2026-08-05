// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from 'node:crypto';

const PAGE_SIZE = 0x1000;
const MAX_PCI_BUS = 255;

function safeInt(name, value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer in [${min}, ${max}].`);
  return value;
}
function pow2(name, value) {
  safeInt(name, value, 1);
  if ((value & (value - 1)) !== 0) throw new TypeError(`${name} must be a power of two.`);
  return value;
}
function alignUp(value, alignment) { return Math.ceil(value / alignment) * alignment; }
function key(bus, device, functionNumber) { return `${bus}:${device}:${functionNumber}`; }
function cloneBytes(input, size = 256) {
  const output = new Uint8Array(size);
  if (input) output.set(input instanceof Uint8Array ? input.subarray(0, size) : Uint8Array.from(input).subarray(0, size));
  return output;
}

export function encodePciConfigAddress(bus, device, functionNumber, offset) {
  safeInt('bus', bus, 0, 255); safeInt('device', device, 0, 31); safeInt('function', functionNumber, 0, 7); safeInt('offset', offset, 0, 255);
  return (0x80000000 | (bus << 16) | (device << 11) | (functionNumber << 8) | (offset & 0xFC)) >>> 0;
}

export class PciConfigSpaceModel {
  constructor(functions = []) {
    this.functions = new Map();
    this.probes = new Set();
    for (const item of functions) this.addFunction(item);
  }
  addFunction({ bus = 0, device, functionNumber = 0, config = null, vendorId = 0xFFFF, deviceId = 0xFFFF, classCode = 0, subclass = 0, programmingInterface = 0, headerType = 0, bars = [], secondaryBus = 0 } = {}) {
    safeInt('bus', bus, 0, 255); safeInt('device', device, 0, 31); safeInt('functionNumber', functionNumber, 0, 7);
    const bytes = cloneBytes(config);
    const view = new DataView(bytes.buffer);
    if (!config) {
      view.setUint16(0x00, vendorId, true); view.setUint16(0x02, deviceId, true);
      view.setUint8(0x09, programmingInterface); view.setUint8(0x0A, subclass); view.setUint8(0x0B, classCode); view.setUint8(0x0E, headerType);
      if ((headerType & 0x7F) === 1) view.setUint8(0x19, secondaryBus);
    }
    const barMasks = new Map();
    bars.forEach((bar, index) => {
      const offset = 0x10 + index * 4;
      const io = bar.type === 'io'; const is64 = bar.type === 'memory64';
      const flags = io ? 1 : ((is64 ? 2 : 0) << 1) | (bar.prefetchable ? 8 : 0);
      const base = BigInt(bar.base ?? 0); const size = BigInt(bar.size ?? PAGE_SIZE);
      const value = io ? (Number(base & 0xFFFFFFFCn) | flags) >>> 0 : (Number(base & 0xFFFFFFF0n) | flags) >>> 0;
      view.setUint32(offset, value, true);
      const maskBits = io ? 0xFFFFFFFCn : 0xFFFFFFF0n;
      const mask = ((~(size - 1n)) & 0xFFFFFFFFn & maskBits) | BigInt(flags);
      barMasks.set(offset, Number(mask & 0xFFFFFFFFn) >>> 0);
      if (is64) {
        view.setUint32(offset + 4, Number((base >> 32n) & 0xFFFFFFFFn), true);
        barMasks.set(offset + 4, Number(((~(size - 1n)) >> 32n) & 0xFFFFFFFFn) >>> 0);
      }
    });
    this.functions.set(key(bus, device, functionNumber), { bus, device, functionNumber, bytes, barMasks });
    return this;
  }
  get(bus, device, functionNumber) { return this.functions.get(key(bus, device, functionNumber)) ?? null; }
  read32(bus, device, functionNumber, offset) {
    const fn = this.get(bus, device, functionNumber); if (!fn) return 0xFFFFFFFF;
    const aligned = offset & 0xFC;
    if (this.probes.has(`${key(bus, device, functionNumber)}:${aligned}`)) return fn.barMasks.get(aligned) ?? 0;
    return new DataView(fn.bytes.buffer, fn.bytes.byteOffset, fn.bytes.byteLength).getUint32(aligned, true);
  }
  write32(bus, device, functionNumber, offset, value) {
    const fn = this.get(bus, device, functionNumber); if (!fn) return;
    const aligned = offset & 0xFC; const probeKey = `${key(bus, device, functionNumber)}:${aligned}`;
    if (aligned >= 0x10 && aligned <= 0x24 && value === 0xFFFFFFFF) { this.probes.add(probeKey); return; }
    this.probes.delete(probeKey);
    new DataView(fn.bytes.buffer, fn.bytes.byteOffset, fn.bytes.byteLength).setUint32(aligned, value >>> 0, true);
  }
  read16(bus, device, functionNumber, offset) {
    const value = this.read32(bus, device, functionNumber, offset); return (value >>> ((offset & 2) * 8)) & 0xFFFF;
  }
  read8(bus, device, functionNumber, offset) {
    const value = this.read32(bus, device, functionNumber, offset); return (value >>> ((offset & 3) * 8)) & 0xFF;
  }
}

export function decodePciBar(low, high = 0) {
  low >>>= 0; high >>>= 0;
  if (low & 1) return Object.freeze({ type: 'io', base: BigInt(low & 0xFFFFFFFC), prefetchable: false, width: 32 });
  const memoryType = (low >>> 1) & 3; const width = memoryType === 2 ? 64 : 32;
  const base = width === 64 ? (BigInt(high) << 32n) | BigInt(low & 0xFFFFFFF0) : BigInt(low & 0xFFFFFFF0);
  return Object.freeze({ type: width === 64 ? 'memory64' : 'memory32', base, prefetchable: Boolean(low & 8), width });
}

export function probePciBar(config, device, index) {
  safeInt('BAR index', index, 0, 5);
  const { bus, device: slot, functionNumber } = device; const offset = 0x10 + index * 4;
  const originalLow = config.read32(bus, slot, functionNumber, offset); if (originalLow === 0) return null;
  const decoded = decodePciBar(originalLow, config.read32(bus, slot, functionNumber, offset + 4));
  config.write32(bus, slot, functionNumber, offset, 0xFFFFFFFF); const maskLow = config.read32(bus, slot, functionNumber, offset); config.write32(bus, slot, functionNumber, offset, originalLow);
  let mask = BigInt(decoded.type === 'io' ? maskLow & 0xFFFFFFFC : maskLow & 0xFFFFFFF0);
  if (decoded.width === 64) {
    const originalHigh = config.read32(bus, slot, functionNumber, offset + 4);
    config.write32(bus, slot, functionNumber, offset + 4, 0xFFFFFFFF); const maskHigh = config.read32(bus, slot, functionNumber, offset + 4); config.write32(bus, slot, functionNumber, offset + 4, originalHigh);
    mask |= BigInt(maskHigh) << 32n;
  }
  const bits = decoded.width === 64 ? 64n : 32n; const full = (1n << bits) - 1n; const size = mask === 0n ? 0n : ((~mask) & full) + 1n;
  return Object.freeze({ index, offset, ...decoded, size });
}

export function enumeratePciHierarchy(config, options = {}) {
  const rootBus = safeInt('rootBus', options.rootBus ?? 0, 0, 255); const maxBus = safeInt('maxBus', options.maxBus ?? MAX_PCI_BUS, rootBus, 255);
  const pending = [rootBus]; const visited = new Set(); const devices = [];
  while (pending.length) {
    const bus = pending.shift(); if (visited.has(bus) || bus > maxBus) continue; visited.add(bus);
    for (let slot = 0; slot < 32; slot++) {
      const vendor0 = config.read16(bus, slot, 0, 0); if (vendor0 === 0xFFFF) continue;
      const header0 = config.read8(bus, slot, 0, 0x0E); const functions = header0 & 0x80 ? 8 : 1;
      for (let fn = 0; fn < functions; fn++) {
        const vendorId = config.read16(bus, slot, fn, 0); if (vendorId === 0xFFFF) continue;
        const deviceId = config.read16(bus, slot, fn, 2); const revision = config.read8(bus, slot, fn, 8); const programmingInterface = config.read8(bus, slot, fn, 9); const subclass = config.read8(bus, slot, fn, 10); const classCode = config.read8(bus, slot, fn, 11); const headerType = config.read8(bus, slot, fn, 0x0E);
        const item = { bus, device: slot, functionNumber: fn, vendorId, deviceId, revision, programmingInterface, subclass, classCode, headerType, bars: [] };
        const barCount = (headerType & 0x7F) === 1 ? 2 : 6;
        for (let index = 0; index < barCount; index++) {
          const bar = probePciBar(config, item, index); if (bar) item.bars.push(bar);
          if (bar?.width === 64) index++;
        }
        if (classCode === 0x06 && subclass === 0x04) { const secondaryBus = config.read8(bus, slot, fn, 0x19); item.secondaryBus = secondaryBus; if (secondaryBus && !visited.has(secondaryBus)) pending.push(secondaryBus); }
        devices.push(Object.freeze(item));
      }
    }
  }
  return Object.freeze(devices);
}

export class PciResourceAllocator {
  constructor(options = {}) {
    this.windows = {
      io: { next: BigInt(options.ioBase ?? 0x1000), end: BigInt(options.ioEnd ?? 0xFFFF) + 1n },
      memory32: { next: BigInt(options.mmio32Base ?? 0x80000000), end: BigInt(options.mmio32End ?? 0xEFFFFFFF) + 1n },
      memory64: { next: BigInt(options.mmio64Base ?? 0x100000000), end: BigInt(options.mmio64End ?? 0x1FFFFFFFF) + 1n },
    };
    this.allocations = [];
  }
  allocate(bar, owner = null) {
    const window = this.windows[bar.type]; if (!window) throw new Error(`No PCI resource window for ${bar.type}.`);
    const size = BigInt(bar.size); if (size <= 0n || (size & (size - 1n)) !== 0n) throw new TypeError('BAR size must be a positive power of two.');
    const aligned = (window.next + size - 1n) & ~(size - 1n); if (aligned + size > window.end) throw new RangeError(`PCI ${bar.type} resource window exhausted.`);
    window.next = aligned + size; const allocation = Object.freeze({ owner, index: bar.index, type: bar.type, address: aligned, size, prefetchable: bar.prefetchable }); this.allocations.push(allocation); return allocation;
  }
}

export class DmaAllocator {
  constructor(options = {}) {
    this.base = BigInt(options.base ?? 0x2000000); this.size = BigInt(options.size ?? 0x1000000); this.pageSize = BigInt(pow2('pageSize', options.pageSize ?? PAGE_SIZE));
    if (this.base % this.pageSize !== 0n || this.size % this.pageSize !== 0n) throw new TypeError('DMA pool must be page aligned.');
    this.freeRanges = [{ start: this.base, end: this.base + this.size }]; this.allocations = new Map(); this.nextId = 1;
  }
  allocate(options = {}) {
    const bytes = BigInt(safeInt('size', options.size ?? PAGE_SIZE, 1)); const alignment = BigInt(pow2('alignment', options.alignment ?? Number(this.pageSize))); const length = ((bytes + this.pageSize - 1n) / this.pageSize) * this.pageSize;
    for (let i = 0; i < this.freeRanges.length; i++) {
      const range = this.freeRanges[i]; const start = (range.start + alignment - 1n) & ~(alignment - 1n); const end = start + length;
      if (end > range.end) continue;
      const replacement = []; if (range.start < start) replacement.push({ start: range.start, end: start }); if (end < range.end) replacement.push({ start: end, end: range.end }); this.freeRanges.splice(i, 1, ...replacement);
      const id = this.nextId++; const allocation = { id, physicalAddress: start, size: length, requestedSize: bytes, alignment, tag: options.tag ?? null, coherent: options.coherent !== false, bytes: new Uint8Array(Number(length)) }; this.allocations.set(id, allocation); return allocation;
    }
    throw new RangeError('DMA pool exhausted.');
  }
  free(allocationOrId) {
    const id = typeof allocationOrId === 'number' ? allocationOrId : allocationOrId?.id; const allocation = this.allocations.get(id); if (!allocation) throw new Error('Unknown DMA allocation.');
    this.allocations.delete(id); this.freeRanges.push({ start: allocation.physicalAddress, end: allocation.physicalAddress + allocation.size }); this.freeRanges.sort((a, b) => a.start < b.start ? -1 : 1);
    const merged = []; for (const range of this.freeRanges) { const last = merged.at(-1); if (last && last.end === range.start) last.end = range.end; else merged.push({ ...range }); } this.freeRanges = merged;
  }
  stats() { const free = this.freeRanges.reduce((sum, range) => sum + (range.end - range.start), 0n); return Object.freeze({ base: this.base, size: this.size, free, used: this.size - free, allocations: this.allocations.size }); }
}

export class IommuDomainModel {
  constructor(options = {}) { this.domainId = safeInt('domainId', options.domainId ?? 1, 1, 0xFFFF); this.pageSize = BigInt(pow2('pageSize', options.pageSize ?? PAGE_SIZE)); this.mappings = new Map(); this.invalidations = []; }
  map(iova, physicalAddress, size, permissions = 'rw') {
    iova = BigInt(iova); physicalAddress = BigInt(physicalAddress); size = BigInt(size);
    if (iova % this.pageSize || physicalAddress % this.pageSize || size <= 0n || size % this.pageSize) throw new TypeError('IOMMU mappings must be positive and page aligned.');
    for (let offset = 0n; offset < size; offset += this.pageSize) { const page = iova + offset; if (this.mappings.has(page)) throw new Error(`IOVA 0x${page.toString(16)} is already mapped.`); this.mappings.set(page, { physicalAddress: physicalAddress + offset, permissions }); }
    this.invalidations.push({ type: 'map', iova, size }); return Object.freeze({ iova, physicalAddress, size, permissions });
  }
  unmap(iova, size) { iova = BigInt(iova); size = BigInt(size); for (let offset = 0n; offset < size; offset += this.pageSize) this.mappings.delete(iova + offset); this.invalidations.push({ type: 'unmap', iova, size }); }
  translate(iova, access = 'r') { iova = BigInt(iova); const page = iova & ~(this.pageSize - 1n); const mapping = this.mappings.get(page); if (!mapping) throw new RangeError('IOMMU translation fault.'); if (!mapping.permissions.includes(access)) throw new Error('IOMMU permission fault.'); return mapping.physicalAddress + (iova - page); }
  flushInvalidations() { const output = this.invalidations.splice(0); return output; }
}

export function createMsiMessage({ vector, destinationApicId = 0, deliveryMode = 0, level = false, triggerMode = false } = {}) {
  safeInt('vector', vector, 0x20, 0xFE); safeInt('destinationApicId', destinationApicId, 0, 0xFF); safeInt('deliveryMode', deliveryMode, 0, 7);
  const address = 0xFEE00000n | (BigInt(destinationApicId) << 12n); const data = (vector & 0xFF) | ((deliveryMode & 7) << 8) | (level ? 1 << 14 : 0) | (triggerMode ? 1 << 15 : 0);
  return Object.freeze({ address, data, vector, destinationApicId, deliveryMode, level, triggerMode });
}

export class MsixTableModel {
  constructor(size = 1) { this.size = safeInt('MSI-X table size', size, 1, 2048); this.entries = Array.from({ length: this.size }, () => ({ address: 0n, data: 0, masked: true, pending: false })); this.functionMasked = true; this.enabled = false; }
  enable() { this.enabled = true; this.functionMasked = false; }
  disable() { this.enabled = false; this.functionMasked = true; }
  program(index, message, options = {}) { safeInt('MSI-X index', index, 0, this.size - 1); const entry = this.entries[index]; entry.address = BigInt(message.address); entry.data = message.data >>> 0; entry.masked = options.masked ?? true; return Object.freeze({ ...entry }); }
  mask(index) { this.entries[safeInt('MSI-X index', index, 0, this.size - 1)].masked = true; }
  unmask(index) { this.entries[safeInt('MSI-X index', index, 0, this.size - 1)].masked = false; }
  signal(index) { const entry = this.entries[safeInt('MSI-X index', index, 0, this.size - 1)]; if (!this.enabled || this.functionMasked || entry.masked) { entry.pending = true; return null; } entry.pending = false; return Object.freeze({ address: entry.address, data: entry.data }); }
}

export class InterruptRouterModel {
  constructor(options = {}) { this.firstVector = safeInt('firstVector', options.firstVector ?? 0x40, 0x20, 0xFE); this.lastVector = safeInt('lastVector', options.lastVector ?? 0xEF, this.firstVector, 0xFE); this.handlers = new Map(); this.masked = new Set(); this.eoiCount = 0; }
  allocate(name, handler, options = {}) { for (let vector = this.firstVector; vector <= this.lastVector; vector++) if (!this.handlers.has(vector)) { this.register(vector, name, handler, options); return vector; } throw new RangeError('No interrupt vectors remain.'); }
  register(vector, name, handler, options = {}) { safeInt('vector', vector, this.firstVector, this.lastVector); if (typeof handler !== 'function') throw new TypeError('Interrupt handler must be a function.'); if (this.handlers.has(vector) && !options.shared) throw new Error(`Interrupt vector ${vector} is already registered.`); const list = this.handlers.get(vector) ?? []; list.push({ name, handler }); this.handlers.set(vector, list); }
  mask(vector) { this.masked.add(vector); } unmask(vector) { this.masked.delete(vector); }
  dispatch(vector, frame = {}) { if (this.masked.has(vector)) return Object.freeze({ handled: false, masked: true, vector }); const list = this.handlers.get(vector) ?? []; let handled = false; const results = []; for (const item of list) { const result = item.handler(frame); results.push({ name: item.name, result }); handled ||= result !== false; } this.eoiCount++; return Object.freeze({ handled, masked: false, vector, results, eoi: this.eoiCount }); }
}

export class InterruptDrivenQueue {
  constructor({ depth = 64, router, vector, name = 'queue' } = {}) { this.depth = pow2('depth', depth); this.router = router; this.vector = vector; this.name = name; this.pending = new Map(); this.completed = []; this.nextId = 1; if (router && vector != null) router.register(vector, name, () => this.drain()); }
  submit(payload) { if (this.pending.size >= this.depth) throw new Error(`${this.name} is full.`); const id = this.nextId++; this.pending.set(id, { id, payload }); return id; }
  deviceComplete(id, result = 0) { const request = this.pending.get(id); if (!request) throw new Error('Unknown queued request.'); this.pending.delete(id); this.completed.push({ ...request, result }); return this.router ? this.router.dispatch(this.vector, { queue: this.name }) : this.drain(); }
  drain() { const items = this.completed.splice(0); return { handled: items.length > 0, items }; }
}

export class DriverRegistry {
  constructor() { this.drivers = []; this.bindings = new Map(); }
  register(driver) { if (!driver?.name || typeof driver.probe !== 'function') throw new TypeError('Driver requires name and probe().'); this.drivers.push(driver); return this; }
  bind(devices, context = {}) { const results = []; for (const device of devices) { const address = key(device.bus, device.device, device.functionNumber); if (this.bindings.has(address)) continue; for (const driver of this.drivers) { if (!driver.probe(device)) continue; const binding = driver.attach ? driver.attach(device, context) : { device }; this.bindings.set(address, { driver: driver.name, binding }); results.push({ address, driver: driver.name, binding }); break; } } return results; }
}

export function createHardwareRuntimeManifest(options = {}) {
  return Object.freeze({
    architecture: 'x86_64', pci: { buses: 256, devicesPerBus: 32, functionsPerDevice: 8, recursiveBridges: true, barProbe: true, resourceAssignment: true },
    dma: { base: options.dmaBase ?? 0x2000000, size: options.dmaSize ?? 0x1000000, pageSize: PAGE_SIZE, contiguousAllocator: true, iommuDomains: true },
    interrupts: { msi: true, msix: true, vectorAllocator: true, sharedHandlers: true, interruptDrivenQueues: true },
    safety: { boundsCheckedModels: true, duplicateMappingRejection: true, vectorOwnership: true, deterministicEnumeration: true },
  });
}

export function createHardwareRuntimeKernelSource(options = {}) {
  const dmaBase = options.dmaBase ?? 0x2000000; const dmaSize = options.dmaSize ?? 0x1000000;
  const prefix = options.fragment ? '' : '#![system]\n#![no_std]\n#![no_main]\n\n';
  return `${prefix}const PCI_MAX_BUS: usize = 256
const PCI_MAX_DEVICE: usize = 32
const PCI_MAX_FUNCTION: usize = 8
const DMA_RUNTIME_BASE: usize = ${dmaBase}
const DMA_RUNTIME_END: usize = ${dmaBase + dmaSize}
const IRQ_VECTOR_FIRST: u8 = 0x40
const IRQ_VECTOR_LAST: u8 = 0xEF

static mut PCI_DISCOVERED_COUNT: usize = 0
static mut DMA_RUNTIME_NEXT: usize = DMA_RUNTIME_BASE
static mut IRQ_RUNTIME_NEXT: u8 = IRQ_VECTOR_FIRST
static mut IRQ_DISPATCH_COUNT: u64 = 0
static mut IOMMU_ENABLED: bool = false

unsafe fn dma_alloc_pages(page_count: usize, alignment: usize) -> usize {
    if page_count == 0 { return 0 }
    let bytes: usize = page_count * 4096
    let aligned: usize = (DMA_RUNTIME_NEXT + alignment - 1) & ~(alignment - 1)
    if aligned < DMA_RUNTIME_NEXT || aligned + bytes > DMA_RUNTIME_END { return 0 }
    DMA_RUNTIME_NEXT = aligned + bytes
    let offset: usize = 0
    while offset < bytes {
        memory.volatile_write<u64>(aligned + offset, 0)
        offset += 8
    }
    return aligned
}

unsafe fn irq_allocate_vector() -> u8 {
    if IRQ_RUNTIME_NEXT > IRQ_VECTOR_LAST { return 0 }
    let vector: u8 = IRQ_RUNTIME_NEXT
    IRQ_RUNTIME_NEXT += 1
    return vector
}

unsafe fn msi_address(apic_id: u8) -> u64 {
    let destination: u64 = apic_id
    return 0xFEE00000 | (destination << 12)
}

unsafe fn msix_program_entry(table: usize, index: usize, apic_id: u8, vector: u8, masked: bool) {
    let entry: usize = table + index * 16
    let address: u64 = msi_address(apic_id)
    let low: u32 = address
    let high: u32 = address >> 32
    let data: u32 = vector
    memory.volatile_write<u32>(entry, low)
    memory.volatile_write<u32>(entry + 4, high)
    memory.volatile_write<u32>(entry + 8, data)
    if masked { memory.volatile_write<u32>(entry + 12, 1) } else { memory.volatile_write<u32>(entry + 12, 0) }
}

unsafe fn pci_scan_function(bus: u8, device: u8, function: u8) -> bool {
    let identity: u32 = pci_read32(bus, device, function, 0)
    if (identity & 0xFFFF) == 0xFFFF { return false }
    PCI_DISCOVERED_COUNT += 1
    return true
}

unsafe fn pci_scan_all() -> usize {
    PCI_DISCOVERED_COUNT = 0
    let bus: usize = 0
    while bus < PCI_MAX_BUS {
        let device: usize = 0
        while device < PCI_MAX_DEVICE {
            if pci_scan_function(bus, device, 0) {
                let header: u32 = pci_read32(bus, device, 0, 0x0C)
                let functions: usize = 1
                if ((header >> 23) & 1) != 0 { functions = PCI_MAX_FUNCTION }
                let function: usize = 1
                while function < functions {
                    pci_scan_function(bus, device, function)
                    function += 1
                }
            }
            device += 1
        }
        bus += 1
    }
    return PCI_DISCOVERED_COUNT
}

pub unsafe fn hardware_irq_dispatch(vector: u8) {
    IRQ_DISPATCH_COUNT += 1
    if vector < IRQ_VECTOR_FIRST || vector > IRQ_VECTOR_LAST { return }
    interrupt_eoi(vector - IRQ_VECTOR_FIRST)
}

unsafe fn iommu_identity_map(base: usize, size: usize) -> bool {
    if base == 0 || size == 0 || (base & 0xFFF) != 0 || (size & 0xFFF) != 0 { return false }
    IOMMU_ENABLED = true
    return true
}

pub unsafe fn init_pci_dma_interrupt_runtime() {
    DMA_RUNTIME_NEXT = DMA_RUNTIME_BASE
    IRQ_RUNTIME_NEXT = IRQ_VECTOR_FIRST
    IRQ_DISPATCH_COUNT = 0
    pci_scan_all()
    iommu_identity_map(DMA_RUNTIME_BASE, DMA_RUNTIME_END - DMA_RUNTIME_BASE)
}
`;
}

export async function hardwareRuntimeSmokeTest() {
  const config = new PciConfigSpaceModel([
    { bus: 0, device: 1, vendorId: 0x8086, deviceId: 0x1234, classCode: 0x06, subclass: 0x04, headerType: 1, secondaryBus: 1 },
    { bus: 1, device: 0, vendorId: 0x144D, deviceId: 0xA808, classCode: 0x01, subclass: 0x08, programmingInterface: 0x02, bars: [{ type: 'memory64', base: 0x90000000n, size: 0x4000n }] },
  ]);
  const devices = enumeratePciHierarchy(config); const nvme = devices.find(item => item.classCode === 1 && item.subclass === 8);
  const resources = new PciResourceAllocator(); const assigned = resources.allocate(nvme.bars[0], 'nvme0');
  const dma = new DmaAllocator({ base: 0x2000000, size: 0x20000 }); const buffer = dma.allocate({ size: 8192, alignment: 4096, tag: 'nvme-prp' });
  const domain = new IommuDomainModel(); domain.map(0x100000n, buffer.physicalAddress, buffer.size, 'rw'); const translated = domain.translate(0x100123n, 'r');
  const router = new InterruptRouterModel(); const vector = router.allocate('nvme0', () => true); const message = createMsiMessage({ vector, destinationApicId: 2 }); const table = new MsixTableModel(4); table.program(0, message, { masked: false }); table.enable(); const signal = table.signal(0);
  const queue = new InterruptDrivenQueue({ depth: 8, router, vector: vector + 1, name: 'io-queue' }); const id = queue.submit({ opcode: 'read' }); const completion = queue.deviceComplete(id, 0);
  return { ok: devices.length === 2 && nvme && assigned.size === 0x4000n && translated === buffer.physicalAddress + 0x123n && signal?.data === message.data && completion.handled, devices: devices.length, nvme: `${nvme.bus}:${nvme.device}.${nvme.functionNumber}`, bar: assigned, dma: dma.stats(), vector, message, queueCompletion: completion, fingerprint: createHash('sha256').update(JSON.stringify(createHardwareRuntimeManifest())).update(createHardwareRuntimeKernelSource()).digest('hex') };
}
