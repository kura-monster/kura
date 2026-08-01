// SPDX-License-Identifier: MIT OR Apache-2.0
export async function gpuAvailable() { return Boolean(globalThis.navigator?.gpu); }
export async function gpuRequestDevice() {
  if (!globalThis.navigator?.gpu) throw new Error("WebGPU is unavailable in this runtime");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter found");
  return adapter.requestDevice();
}
export function gpuCreateBuffer(device, size, usage) { return device.createBuffer({size, usage}); }
export function gpuWriteBuffer(device, buffer, data, offset = 0) { device.queue.writeBuffer(buffer, offset, data); }
export async function gpuReadBuffer(buffer, size) { await buffer.mapAsync(GPUMapMode.READ, 0, size); return buffer.getMappedRange(0, size).slice(0); }
export function gpuDestroyBuffer(buffer) { buffer.destroy(); }
export function gpuDestroyDevice(device) { device.destroy?.(); }
