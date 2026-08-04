// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHardwareManifest, decodeNvmeIdentifyController, decodeNvmeIdentifyNamespace,
  planNvmePrps, createNvmeReadWriteCommand, NvmeQueueModel,
  encodeXhciTrb, decodeXhciTrb, XhciRingModel, parseUsbDescriptors,
  decodeBootKeyboardReport, decodeBootMouseReport, VirtioNetDeviceModel,
  FramebufferSurface, createHardwareKernelSource, createCompleteHardwareKernelSource,
  buildHardwareKernel, hardwareSmokeTest,
} from '../lib/system-hardware.mjs';

const manifest = createHardwareManifest();
assert.equal(manifest.features.nvmeIoQueues, true);
assert.equal(manifest.features.usbHidBootProtocol, true);
assert.equal(manifest.layout.nvmeQueueDepth, 64);
assert.throws(() => createHardwareManifest({ nvmeAdminCompletion: manifest.layout.nvmeAdminSubmission }), /overlap/);

const controllerBytes = new Uint8Array(4096); const controller = new DataView(controllerBytes.buffer);
controller.setUint16(0, 0x1D0F, true); controllerBytes.set(new TextEncoder().encode('SERIAL-1'.padEnd(20)), 4); controllerBytes.set(new TextEncoder().encode('Kura Virtual NVMe'.padEnd(40)), 24); controllerBytes.set(new TextEncoder().encode('1.0'.padEnd(8)), 64); controller.setUint32(516, 2, true); controller.setUint8(512, 0x66); controller.setUint8(513, 0x44);
const identifyController = decodeNvmeIdentifyController(controllerBytes);
assert.equal(identifyController.modelNumber, 'Kura Virtual NVMe');
assert.equal(identifyController.namespaceCount, 2);

const namespaceBytes = new Uint8Array(4096); const namespace = new DataView(namespaceBytes.buffer);
namespace.setBigUint64(0, 1024n, true); namespace.setBigUint64(8, 1024n, true); namespace.setBigUint64(16, 128n, true); namespace.setUint8(26, 0); namespace.setUint16(128, 0, true); namespace.setUint8(130, 12);
assert.equal(decodeNvmeIdentifyNamespace(namespaceBytes).lbaSize, 4096);
assert.deepEqual(planNvmePrps({ address: 0x1100, length: 0x1800 }).pages, [0x1000, 0x2000]);
assert.equal(planNvmePrps({ address: 0x1100, length: 0x3000, listPageAddress: 0x9000 }).list.length, 3);

const nvme = new NvmeQueueModel(8); const command = createNvmeReadWriteCommand({ startLba: 9n, blockCount: 4, prp1: 0x1000, prp2: 0x2000 });
const submitted = nvme.submit(command, { kind: 'read' }); const deviceCommand = nvme.devicePopSubmission(); assert.equal(deviceCommand.commandId, submitted.commandId); nvme.complete({ commandId: submitted.commandId, result: 4 }); const completion = nvme.driverPopCompletion(); assert.equal(completion.success, true); assert.equal(completion.metadata.kind, 'read');

const trb = encodeXhciTrb({ parameter: 0x1234n, status: 8, type: 9, flags: 0x20 }); assert.equal(decodeXhciTrb(trb).type, 9);
const ring = new XhciRingModel(16, { baseAddress: 0x4000n }); ring.enqueue(trb); assert.equal(ring.hardwarePop().parameter, 0x1234n);

const usb = parseUsbDescriptors(Uint8Array.from([
  18, 1, 0x00, 0x02, 0, 0, 0, 64, 0x34, 0x12, 0x78, 0x56, 0, 1, 1, 2, 3, 1,
  9, 2, 25, 0, 1, 1, 0, 0x80, 50,
  9, 4, 0, 0, 1, 3, 1, 1, 0,
  7, 5, 0x81, 3, 8, 0, 10,
]));
assert.equal(usb.device.vendorId, 0x1234); assert.equal(usb.interfaces[0].interfaceClass, 3); assert.equal(usb.endpoints[0].direction, 'in');
const keyboard = decodeBootKeyboardReport([2, 0, 4, 5, 0, 0, 0, 0]); assert.deepEqual(keyboard.keys, ['A', 'B']);
const keyboard2 = decodeBootKeyboardReport([0, 0, 5, 0, 0, 0, 0, 0], keyboard); assert.deepEqual(keyboard2.released, [4]);
assert.deepEqual(decodeBootMouseReport([5, 0xFF, 2, 0xFE]), { buttons: 5, left: true, right: false, middle: true, x: -1, y: 2, wheel: -2 });

const net = new VirtioNetDeviceModel({ deviceFeatures: 0x20n, queueSize: 8 }); assert.equal(net.negotiate(0x21n), 0x20n); const packetId = net.send([1, 2, 3]); const packet = net.devicePopTransmit(); assert.equal(packet.id, packetId); net.completeTransmit(packet); net.injectReceive([4, 5]); assert.deepEqual([...net.receive().frame], [4, 5]);
const framebuffer = new FramebufferSurface({ width: 3, height: 3 }); framebuffer.fillRect(1, 1, 2, 2, 0xFF112233); assert.equal(framebuffer.getPixel(1, 1), 0xFF112233); const copy = new FramebufferSurface({ width: 3, height: 3 }); copy.blit(framebuffer, 1, 1, 1, 1, 0, 0); assert.equal(copy.getPixel(0, 0), 0xFF112233);

assert.match(createHardwareKernelSource(), /unsafe fn nvme_init/);
const completeSource = createCompleteHardwareKernelSource({ enableSmp: false });
assert.match(completeSource, /init_userspace\(GDT_BASE\)/); assert.match(completeSource, /init_hardware_drivers\(\)/);
assert.equal((await hardwareSmokeTest()).ok, true);

if (process.platform !== 'win32' && spawnSync('clang', ['--version'], { stdio: 'ignore' }).status === 0 && spawnSync('ld.lld', ['--version'], { stdio: 'ignore' }).status === 0) {
  const directory = await mkdtemp(join(tmpdir(), 'kura-hardware-'));
  const result = await buildHardwareKernel(null, { outDir: directory, enableSmp: false });
  assert.equal(spawnSync('test', ['-s', result.plan.elf]).status, 0);
}
console.log('hardware driver tests passed');
