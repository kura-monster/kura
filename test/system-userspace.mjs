// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createUserspaceManifest, createUserspaceAssembly, createUserspaceKernelSource,
  createCompleteUserspaceKernelSource, parseElf64Executable, ProcessTableModel,
  VirtualFileSystem, decodePciConfiguration, VirtioQueueModel,
  encodeIpv4Packet, decodeIpv4Packet, encodeUdpDatagram, decodeUdpDatagram, TcpConnectionModel,
} from '../lib/system-userspace.mjs';

const manifest = createUserspaceManifest();
assert.equal(manifest.features.ring3, true);
assert.equal(manifest.selectors.userCode, 0x23);
assert.match(createUserspaceAssembly(), /sysretq/);
assert.match(createUserspaceKernelSource(), /kura_syscall_dispatch/);
assert.match(createCompleteUserspaceKernelSource({ enableSmp: false }), /launch_user_process/);

const elf = new Uint8Array(0x200); const view = new DataView(elf.buffer);
elf.set([0x7F, 0x45, 0x4C, 0x46, 2, 1, 1, 0]); view.setUint16(16, 2, true); view.setUint16(18, 0x3E, true);
view.setBigUint64(24, 0x400000n, true); view.setBigUint64(32, 64n, true); view.setUint16(52, 64, true); view.setUint16(54, 56, true); view.setUint16(56, 1, true);
view.setUint32(64, 1, true); view.setUint32(68, 5, true); view.setBigUint64(72, 0x100n, true); view.setBigUint64(80, 0x400000n, true); view.setBigUint64(88, 0x400000n, true); view.setBigUint64(96, 4n, true); view.setBigUint64(104, 4n, true); view.setBigUint64(112, 0x1000n, true);
elf.set([0xC3, 0, 0, 0], 0x100);
assert.equal(parseElf64Executable(elf).segments[0].executable, true);

const processes = new ProcessTableModel(); const init = processes.spawn({ name: 'init', entry: 0x400000n }); processes.transition(init.pid, 'running'); processes.exit(init.pid, 0); assert.equal(processes.reap(init.pid).exitCode, 0);
const vfs = new VirtualFileSystem(); vfs.mkdir('/etc', { recursive: true }); vfs.create('/etc/hostname', 'kura'); const fd = vfs.open('/etc/hostname', 'r'); assert.equal(new TextDecoder().decode(vfs.read(fd, 16)), 'kura');
const pci = new Uint8Array(256); const pciView = new DataView(pci.buffer); pciView.setUint16(0, 0x1AF4, true); pciView.setUint16(2, 0x1000, true); assert.equal(decodePciConfiguration(pci).vendorId, 0x1AF4);
const queue = new VirtioQueueModel(8); const [descriptor] = queue.allocate(); queue.configure(descriptor, { address: 0x1000, length: 64 }); queue.submit(descriptor); queue.complete(queue.devicePop().head, 64); assert.equal(queue.driverPopUsed().chain[0], descriptor);
const ipv4 = encodeIpv4Packet({ source: '10.0.0.1', destination: '10.0.0.2', protocol: 17, payload: encodeUdpDatagram({ sourcePort: 1000, destinationPort: 2000, payload: [42] }) });
assert.equal(decodeUdpDatagram(decodeIpv4Packet(ipv4).payload).payload[0], 42);
const tcp = new TcpConnectionModel(); tcp.activeOpen(); tcp.receive({ syn: true, ack: true, sequence: 10 }); assert.equal(tcp.state, 'ESTABLISHED');

if (process.platform !== 'win32' && spawnSync('clang', ['--version'], { stdio: 'ignore' }).status === 0) {
  const directory = await mkdtemp(join(tmpdir(), 'kura-userspace-')); const assembly = join(directory, 'userspace.S'); const object = join(directory, 'userspace.o');
  await writeFile(assembly, createUserspaceAssembly()); const built = spawnSync('clang', ['-c', assembly, '-o', object], { encoding: 'utf8' }); assert.equal(built.status, 0, built.stderr);
}
console.log('userspace OS tests passed');
