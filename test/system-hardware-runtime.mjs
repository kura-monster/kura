// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import {
  PciConfigSpaceModel, enumeratePciHierarchy, PciResourceAllocator,
  DmaAllocator, IommuDomainModel, createMsiMessage, MsixTableModel,
  InterruptRouterModel, InterruptDrivenQueue, createHardwareRuntimeKernelSource,
  hardwareRuntimeSmokeTest,
} from '../lib/system-hardware-runtime.mjs';

const config = new PciConfigSpaceModel([
  { bus: 0, device: 2, vendorId: 0x8086, deviceId: 0x1111, classCode: 0x06, subclass: 0x04, headerType: 1, secondaryBus: 3 },
  { bus: 3, device: 0, vendorId: 0x144D, deviceId: 0xA808, classCode: 1, subclass: 8, programmingInterface: 2, bars: [{ type: 'memory64', base: 0xA0000000n, size: 0x4000n }] },
]);
const devices = enumeratePciHierarchy(config);
assert.equal(devices.length, 2);
const nvme = devices.find(item => item.classCode === 1);
assert.equal(nvme.bus, 3);
assert.equal(nvme.bars[0].size, 0x4000n);
const allocation = new PciResourceAllocator().allocate(nvme.bars[0], 'nvme');
assert.equal(allocation.address % allocation.size, 0n);
const dma = new DmaAllocator({ base: 0x4000000, size: 0x10000 });
const first = dma.allocate({ size: 5000, alignment: 4096 });
assert.equal(first.size, 8192n);
dma.free(first);
assert.equal(dma.stats().used, 0n);
const second = dma.allocate({ size: 4096 });
const domain = new IommuDomainModel(); domain.map(0x100000n, second.physicalAddress, second.size, 'rw');
assert.equal(domain.translate(0x100010n), second.physicalAddress + 0x10n);
assert.throws(() => domain.map(0x100000n, second.physicalAddress, second.size), /already mapped/);
const router = new InterruptRouterModel(); const vector = router.allocate('test', () => true);
const message = createMsiMessage({ vector, destinationApicId: 1 });
const msix = new MsixTableModel(2); msix.program(0, message, { masked: false }); msix.enable();
assert.equal(msix.signal(0).data, vector);
const queue = new InterruptDrivenQueue({ router, vector: vector + 1, depth: 8 }); const id = queue.submit('request');
assert.equal(queue.deviceComplete(id, 0).handled, true);
const source = createHardwareRuntimeKernelSource();
assert.match(source, /pci_scan_all/); assert.match(source, /msix_program_entry/); assert.match(source, /dma_alloc_pages/);
assert.equal((await hardwareRuntimeSmokeTest()).ok, true);
console.log('hardware runtime tests passed');
