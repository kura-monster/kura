// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createKernelRuntimeSource as createHardenedKernelRuntimeSource,
  createX86_64BootstrapAssembly,
} from './system-kernel-runtime-vm-hardened.mjs';

export {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createX86_64BootstrapAssembly,
};

export function createKernelRuntimeSource(options = {}) {
  return createHardenedKernelRuntimeSource(options)
    .replaceAll('pml4_entry |= PAGE_USER', 'pml4_entry = pml4_entry | PAGE_USER')
    .replaceAll('pdpt_entry |= PAGE_USER', 'pdpt_entry = pdpt_entry | PAGE_USER')
    .replaceAll('directory_entry |= PAGE_USER', 'directory_entry = directory_entry | PAGE_USER');
}
