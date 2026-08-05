// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createKernelRuntimeSource as createVirtualMemoryKernelRuntimeSource,
  createX86_64BootstrapAssembly,
} from './system-kernel-runtime-vm.mjs';

export {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createX86_64BootstrapAssembly,
};

function hex(value) {
  return `0x${value.toString(16).toUpperCase()}`;
}

function replaceOnce(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Kernel runtime hardening anchor not found: ${label}`);
  }
  return source.replace(search, replacement);
}

function replaceBetween(source, start, end, replacement, label) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) {
    throw new Error(`Kernel runtime hardening start anchor not found: ${label}`);
  }
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) {
    throw new Error(`Kernel runtime hardening end anchor not found: ${label}`);
  }
  return `${source.slice(0, startIndex)}${replacement}\n\n${source.slice(endIndex)}`;
}

function hardeningConstants(manifest) {
  const frameStateBytes = manifest.identityMappedBytes / manifest.pageSize;
  const safeHeapBase = Math.ceil((manifest.layout.heap + frameStateBytes) / manifest.pageSize) * manifest.pageSize;
  const heapEnd = manifest.layout.heap + manifest.layout.heapSize;
  if (safeHeapBase >= heapEnd) {
    throw new RangeError('Kernel heap is too small for the physical-frame ownership table.');
  }
  return {
    source: `const PAGE_ADDRESS_MASK: usize = 0x000FFFFFFFFFF000
const PAGE_WRITE_THROUGH: usize = 0x8
const PAGE_CACHE_DISABLE: usize = 0x10
const PAGE_GLOBAL: usize = 0x100
const PAGE_NO_EXECUTE: usize = 0x8000000000000000
const PAGE_ALLOWED_FLAGS: usize = PAGE_WRITABLE | PAGE_USER | PAGE_WRITE_THROUGH | PAGE_CACHE_DISABLE | PAGE_GLOBAL | PAGE_NO_EXECUTE
const FRAME_STATE_UNKNOWN: u8 = 0
const FRAME_STATE_ALLOCATED: u8 = 1
const FRAME_STATE_PAGE_TABLE: u8 = 2
const FRAME_STATE_RELEASED: u8 = 3
const FRAME_STATE_BASE: usize = ${hex(manifest.layout.heap)}
const FRAME_STATE_BYTES: usize = ${hex(frameStateBytes)}
const SAFE_HEAP_BASE: usize = ${hex(safeHeapBase)}
const SAFE_HEAP_SIZE: usize = ${hex(heapEnd - safeHeapBase)}
const VM_SELF_TEST_ADDRESS: usize = 0x40000000
const VM_SELF_TEST_PATTERN: u64 = 0x4B5552414D454D31
const ONE_GIB: usize = 0x40000000
const COM1: u16 = 0x3F8`,
  };
}

const OWNERSHIP_FUNCTIONS = `fn virtual_address_is_canonical(address: usize) -> bool {
    let upper: usize = address >> 48
    let sign: usize = (address >> 47) & 1
    if sign == 0 {
        return upper == 0
    }
    return upper == 0xFFFF
}

fn page_flags_are_valid(flags: usize) -> bool {
    return flags == (flags & PAGE_ALLOWED_FLAGS)
}

unsafe fn frame_state_get(address: usize) -> u8 {
    if address >= IDENTITY_MAPPED_BYTES {
        return FRAME_STATE_UNKNOWN
    }
    return memory.read<u8>(FRAME_STATE_BASE + address / PAGE_SIZE)
}

unsafe fn frame_state_set(address: usize, state: u8) {
    if address < IDENTITY_MAPPED_BYTES {
        memory.write<u8>(FRAME_STATE_BASE + address / PAGE_SIZE, state)
    }
}

unsafe fn frame_ownership_reset() {
    zero_region(FRAME_STATE_BASE, FRAME_STATE_BYTES)
}

unsafe fn release_owned_frame(address: usize, expected_state: u8) -> bool {
    if address == 0 || address % PAGE_SIZE != 0 {
        return false
    }
    if !frame_in_available_memory(address) || frame_is_reserved(address) {
        return false
    }
    if frame_state_get(address) != expected_state {
        return false
    }
    memory.write<usize>(address, FREE_FRAME_HEAD)
    frame_state_set(address, FRAME_STATE_RELEASED)
    FREE_FRAME_HEAD = address
    FREE_FRAME_COUNT += 1
    return true
}

unsafe fn alloc_page_table_frame() -> usize {
    let frame: usize = alloc_frame()
    if frame != 0 {
        frame_state_set(frame, FRAME_STATE_PAGE_TABLE)
    }
    return frame
}

unsafe fn free_page_table_frame(address: usize) -> bool {
    return release_owned_frame(address, FRAME_STATE_PAGE_TABLE)
}

unsafe fn page_table_root_is_valid(root: usize) -> bool {
    if root == PML4_BASE {
        return true
    }
    if root == 0 || root % PAGE_SIZE != 0 {
        return false
    }
    return frame_state_get(root) == FRAME_STATE_PAGE_TABLE
}`;

const FREE_FRAME_FUNCTIONS = `pub unsafe fn free_frame_count() -> usize {
    return FREE_FRAME_COUNT
}

pub unsafe fn free_frame(address: usize) -> bool {
    return release_owned_frame(address, FRAME_STATE_ALLOCATED)
}`;

const RELEASE_EMPTY_FUNCTION = `unsafe fn page_table_release_empty_child(parent: usize, index: usize, child: usize) {
    if child != 0 && page_table_is_empty(child) {
        memory.write<usize>(parent + index * 8, 0)
        free_page_table_frame(child)
    }
}`;

const PAGE_TABLE_CREATE = `pub unsafe fn page_table_create() -> usize {
    let root: usize = alloc_page_table_frame()
    if root == 0 {
        return 0
    }
    zero_region(root, PAGE_SIZE)
    let pdpt: usize = alloc_page_table_frame()
    if pdpt == 0 {
        free_page_table_frame(root)
        return 0
    }
    zero_region(pdpt, PAGE_SIZE)
    let directory: usize = alloc_page_table_frame()
    if directory == 0 {
        free_page_table_frame(pdpt)
        free_page_table_frame(root)
        return 0
    }
    zero_region(directory, PAGE_SIZE)
    memory.write<usize>(root, pdpt | PAGE_PRESENT | PAGE_WRITABLE)
    memory.write<usize>(pdpt, directory | PAGE_PRESENT | PAGE_WRITABLE)
    let index: usize = 0
    while index < PAGE_TABLE_ENTRIES {
        let physical: usize = index * HUGE_PAGE_SIZE
        memory.write<usize>(directory + index * 8, physical | PAGE_PRESENT | PAGE_WRITABLE | PAGE_HUGE)
        index += 1
    }
    return root
}`;

const PAGE_TABLE_ACTIVATE = `pub unsafe fn page_table_activate(root: usize) -> bool {
    if !page_table_root_is_valid(root) {
        return false
    }
    if (memory.read<usize>(root) & PAGE_PRESENT) == 0 {
        return false
    }
    cpu.write_cr3(root)
    return true
}`;

const PAGE_TABLE_MAP = `pub unsafe fn page_table_map(root: usize, virtual_address: usize, physical_address: usize, flags: usize) -> bool {
    if !page_table_root_is_valid(root) || !virtual_address_is_canonical(virtual_address) {
        return false
    }
    if virtual_address % PAGE_SIZE != 0 || physical_address == 0 || physical_address % PAGE_SIZE != 0 {
        return false
    }
    if (physical_address & PAGE_ADDRESS_MASK) != physical_address || !page_flags_are_valid(flags) {
        return false
    }
    let safe_flags: usize = flags & PAGE_ALLOWED_FLAGS
    let pml4_index: usize = page_table_index(virtual_address, 39)
    let pdpt_index: usize = page_table_index(virtual_address, 30)
    let directory_index: usize = page_table_index(virtual_address, 21)
    let table_index: usize = page_table_index(virtual_address, 12)
    let branch_flags: usize = PAGE_PRESENT | PAGE_WRITABLE | (safe_flags & PAGE_USER)

    let pml4_entry_address: usize = root + pml4_index * 8
    let pml4_entry: usize = memory.read<usize>(pml4_entry_address)
    let pdpt: usize = 0
    let created_pdpt: bool = false
    if (pml4_entry & PAGE_PRESENT) != 0 {
        if (pml4_entry & PAGE_HUGE) != 0 {
            return false
        }
        if (safe_flags & PAGE_USER) != 0 && (pml4_entry & PAGE_USER) == 0 {
            pml4_entry |= PAGE_USER
            memory.write<usize>(pml4_entry_address, pml4_entry)
        }
        pdpt = pml4_entry & PAGE_ADDRESS_MASK
    } else {
        pdpt = alloc_page_table_frame()
        if pdpt == 0 {
            return false
        }
        zero_region(pdpt, PAGE_SIZE)
        memory.write<usize>(pml4_entry_address, pdpt | branch_flags)
        created_pdpt = true
    }

    let pdpt_entry_address: usize = pdpt + pdpt_index * 8
    let pdpt_entry: usize = memory.read<usize>(pdpt_entry_address)
    let directory: usize = 0
    let created_directory: bool = false
    if (pdpt_entry & PAGE_PRESENT) != 0 {
        if (pdpt_entry & PAGE_HUGE) != 0 {
            if created_pdpt {
                page_table_release_empty_child(root, pml4_index, pdpt)
            }
            return false
        }
        if (safe_flags & PAGE_USER) != 0 && (pdpt_entry & PAGE_USER) == 0 {
            pdpt_entry |= PAGE_USER
            memory.write<usize>(pdpt_entry_address, pdpt_entry)
        }
        directory = pdpt_entry & PAGE_ADDRESS_MASK
    } else {
        directory = alloc_page_table_frame()
        if directory == 0 {
            if created_pdpt {
                page_table_release_empty_child(root, pml4_index, pdpt)
            }
            return false
        }
        zero_region(directory, PAGE_SIZE)
        memory.write<usize>(pdpt_entry_address, directory | branch_flags)
        created_directory = true
    }

    let directory_entry_address: usize = directory + directory_index * 8
    let directory_entry: usize = memory.read<usize>(directory_entry_address)
    let table: usize = 0
    let created_table: bool = false
    if (directory_entry & PAGE_PRESENT) != 0 {
        if (directory_entry & PAGE_HUGE) != 0 {
            if created_directory {
                page_table_release_empty_child(pdpt, pdpt_index, directory)
            }
            if created_pdpt {
                page_table_release_empty_child(root, pml4_index, pdpt)
            }
            return false
        }
        if (safe_flags & PAGE_USER) != 0 && (directory_entry & PAGE_USER) == 0 {
            directory_entry |= PAGE_USER
            memory.write<usize>(directory_entry_address, directory_entry)
        }
        table = directory_entry & PAGE_ADDRESS_MASK
    } else {
        table = alloc_page_table_frame()
        if table == 0 {
            if created_directory {
                page_table_release_empty_child(pdpt, pdpt_index, directory)
            }
            if created_pdpt {
                page_table_release_empty_child(root, pml4_index, pdpt)
            }
            return false
        }
        zero_region(table, PAGE_SIZE)
        memory.write<usize>(directory_entry_address, table | branch_flags)
        created_table = true
    }

    let entry_address: usize = table + table_index * 8
    if (memory.read<usize>(entry_address) & PAGE_PRESENT) != 0 {
        if created_table {
            page_table_release_empty_child(directory, directory_index, table)
        }
        if created_directory {
            page_table_release_empty_child(pdpt, pdpt_index, directory)
        }
        if created_pdpt {
            page_table_release_empty_child(root, pml4_index, pdpt)
        }
        return false
    }
    memory.write<usize>(entry_address, physical_address | safe_flags | PAGE_PRESENT)
    return true
}`;

const PAGE_TABLE_TRANSLATE = `pub unsafe fn page_table_translate(root: usize, virtual_address: usize) -> usize {
    if !page_table_root_is_valid(root) || !virtual_address_is_canonical(virtual_address) {
        return 0
    }
    let pml4_entry: usize = memory.read<usize>(root + page_table_index(virtual_address, 39) * 8)
    if (pml4_entry & PAGE_PRESENT) == 0 {
        return 0
    }
    let pdpt: usize = pml4_entry & PAGE_ADDRESS_MASK
    let pdpt_entry: usize = memory.read<usize>(pdpt + page_table_index(virtual_address, 30) * 8)
    if (pdpt_entry & PAGE_PRESENT) == 0 {
        return 0
    }
    if (pdpt_entry & PAGE_HUGE) != 0 {
        let base: usize = align_down(pdpt_entry & PAGE_ADDRESS_MASK, ONE_GIB)
        return base + (virtual_address & (ONE_GIB - 1))
    }
    let directory: usize = pdpt_entry & PAGE_ADDRESS_MASK
    let directory_entry: usize = memory.read<usize>(directory + page_table_index(virtual_address, 21) * 8)
    if (directory_entry & PAGE_PRESENT) == 0 {
        return 0
    }
    if (directory_entry & PAGE_HUGE) != 0 {
        let base: usize = align_down(directory_entry & PAGE_ADDRESS_MASK, HUGE_PAGE_SIZE)
        return base + (virtual_address & (HUGE_PAGE_SIZE - 1))
    }
    let table: usize = directory_entry & PAGE_ADDRESS_MASK
    let entry: usize = memory.read<usize>(table + page_table_index(virtual_address, 12) * 8)
    if (entry & PAGE_PRESENT) == 0 {
        return 0
    }
    return (entry & PAGE_ADDRESS_MASK) + (virtual_address & (PAGE_SIZE - 1))
}`;

const PAGE_TABLE_UNMAP = `pub unsafe fn page_table_unmap(root: usize, virtual_address: usize, release_physical: bool) -> usize {
    if !page_table_root_is_valid(root) || !virtual_address_is_canonical(virtual_address) || virtual_address % PAGE_SIZE != 0 {
        return 0
    }
    let pml4_index: usize = page_table_index(virtual_address, 39)
    let pdpt_index: usize = page_table_index(virtual_address, 30)
    let directory_index: usize = page_table_index(virtual_address, 21)
    let table_index: usize = page_table_index(virtual_address, 12)
    let pml4_entry: usize = memory.read<usize>(root + pml4_index * 8)
    if (pml4_entry & PAGE_PRESENT) == 0 || (pml4_entry & PAGE_HUGE) != 0 {
        return 0
    }
    let pdpt: usize = pml4_entry & PAGE_ADDRESS_MASK
    let pdpt_entry: usize = memory.read<usize>(pdpt + pdpt_index * 8)
    if (pdpt_entry & PAGE_PRESENT) == 0 || (pdpt_entry & PAGE_HUGE) != 0 {
        return 0
    }
    let directory: usize = pdpt_entry & PAGE_ADDRESS_MASK
    let directory_entry: usize = memory.read<usize>(directory + directory_index * 8)
    if (directory_entry & PAGE_PRESENT) == 0 || (directory_entry & PAGE_HUGE) != 0 {
        return 0
    }
    let table: usize = directory_entry & PAGE_ADDRESS_MASK
    let entry_address: usize = table + table_index * 8
    let entry: usize = memory.read<usize>(entry_address)
    if (entry & PAGE_PRESENT) == 0 {
        return 0
    }
    let physical: usize = entry & PAGE_ADDRESS_MASK
    if release_physical && frame_state_get(physical) != FRAME_STATE_ALLOCATED {
        return 0
    }
    memory.write<usize>(entry_address, 0)
    if page_table_current() == root {
        cpu.invalidate_page(virtual_address)
    }
    if release_physical {
        free_frame(physical)
    }
    page_table_release_empty_child(directory, directory_index, table)
    page_table_release_empty_child(pdpt, pdpt_index, directory)
    page_table_release_empty_child(root, pml4_index, pdpt)
    return physical
}`;

const PAGE_TABLE_DESTROY_AND_SELF_TEST = `pub unsafe fn page_table_destroy(root: usize) -> bool {
    if root == 0 || root == PML4_BASE || root % PAGE_SIZE != 0 {
        return false
    }
    if frame_state_get(root) != FRAME_STATE_PAGE_TABLE || page_table_current() == root {
        return false
    }
    let index: usize = 1
    while index < PAGE_TABLE_ENTRIES {
        if memory.read<usize>(root + index * 8) != 0 {
            return false
        }
        index += 1
    }
    let root_entry: usize = memory.read<usize>(root)
    if (root_entry & PAGE_PRESENT) == 0 || (root_entry & PAGE_HUGE) != 0 {
        return false
    }
    let pdpt: usize = root_entry & PAGE_ADDRESS_MASK
    if frame_state_get(pdpt) != FRAME_STATE_PAGE_TABLE {
        return false
    }
    index = 1
    while index < PAGE_TABLE_ENTRIES {
        if memory.read<usize>(pdpt + index * 8) != 0 {
            return false
        }
        index += 1
    }
    let pdpt_entry: usize = memory.read<usize>(pdpt)
    if (pdpt_entry & PAGE_PRESENT) == 0 || (pdpt_entry & PAGE_HUGE) != 0 {
        return false
    }
    let directory: usize = pdpt_entry & PAGE_ADDRESS_MASK
    if frame_state_get(directory) != FRAME_STATE_PAGE_TABLE {
        return false
    }
    index = 0
    while index < PAGE_TABLE_ENTRIES {
        let entry: usize = memory.read<usize>(directory + index * 8)
        if (entry & PAGE_PRESENT) == 0 || (entry & PAGE_HUGE) == 0 {
            return false
        }
        if (entry & PAGE_ADDRESS_MASK) != index * HUGE_PAGE_SIZE {
            return false
        }
        index += 1
    }
    free_page_table_frame(directory)
    free_page_table_frame(pdpt)
    free_page_table_frame(root)
    return true
}

pub unsafe fn memory_runtime_self_test() -> bool {
    let first: usize = alloc_frame()
    if first == 0 {
        return false
    }
    if !free_frame(first) {
        return false
    }
    let reused: usize = alloc_frame()
    if reused != first {
        return false
    }
    let root: usize = page_table_create()
    if root == 0 {
        free_frame(reused)
        return false
    }
    if !page_table_map(root, VM_SELF_TEST_ADDRESS, reused, PAGE_WRITABLE) {
        free_frame(reused)
        page_table_destroy(root)
        return false
    }
    if page_table_translate(root, VM_SELF_TEST_ADDRESS) != reused {
        page_table_unmap(root, VM_SELF_TEST_ADDRESS, false)
        free_frame(reused)
        page_table_destroy(root)
        return false
    }
    let previous: usize = page_table_current()
    if !page_table_activate(root) {
        page_table_unmap(root, VM_SELF_TEST_ADDRESS, false)
        free_frame(reused)
        page_table_destroy(root)
        return false
    }
    memory.write<u64>(VM_SELF_TEST_ADDRESS, VM_SELF_TEST_PATTERN)
    let observed: u64 = memory.read<u64>(VM_SELF_TEST_ADDRESS)
    if !page_table_activate(previous) {
        return false
    }
    if observed != VM_SELF_TEST_PATTERN {
        page_table_unmap(root, VM_SELF_TEST_ADDRESS, false)
        free_frame(reused)
        page_table_destroy(root)
        return false
    }
    if page_table_unmap(root, VM_SELF_TEST_ADDRESS, true) != reused {
        return false
    }
    return page_table_destroy(root)
}`;

const ALLOC_FRAME = `pub unsafe fn alloc_frame() -> usize {
    while FREE_FRAME_HEAD != 0 {
        let current: usize = FREE_FRAME_HEAD
        FREE_FRAME_HEAD = memory.read<usize>(current)
        if FREE_FRAME_COUNT > 0 {
            FREE_FRAME_COUNT -= 1
        }
        if frame_state_get(current) == FRAME_STATE_RELEASED {
            memory.write<usize>(current, 0)
            frame_state_set(current, FRAME_STATE_ALLOCATED)
            return current
        }
    }
    while true {
        if NEXT_FRAME + PAGE_SIZE <= FRAME_LIMIT {
            let current: usize = NEXT_FRAME
            NEXT_FRAME += PAGE_SIZE
            if !frame_is_reserved(current) {
                frame_state_set(current, FRAME_STATE_ALLOCATED)
                return current
            }
        } else {
            if !FRAME_MEMORY_MAP_ACTIVE {
                return 0
            }
            if !select_next_memory_map_region() {
                return 0
            }
        }
    }
    return 0
}`;

export function createKernelRuntimeSource(options = {}) {
  const manifest = createKernelArchitectureManifest(options);
  const hardening = hardeningConstants(manifest);
  let source = createVirtualMemoryKernelRuntimeSource(options);

  source = replaceOnce(
    source,
    'const PAGE_ADDRESS_MASK: usize = 0x000FFFFFFFFFF000\nconst ONE_GIB: usize = 0x40000000\nconst COM1: u16 = 0x3F8',
    hardening.source,
    'ownership and page constants',
  );
  source = replaceOnce(
    source,
    'unsafe fn frame_in_available_memory(address: usize) -> bool {',
    `${OWNERSHIP_FUNCTIONS}\n\nunsafe fn frame_in_available_memory(address: usize) -> bool {`,
    'ownership functions',
  );
  source = replaceBetween(source, 'pub unsafe fn free_frame_count() -> usize {', 'fn page_table_index(address: usize, shift: usize) -> usize {', FREE_FRAME_FUNCTIONS, 'owned frame release');
  source = replaceBetween(source, 'unsafe fn page_table_release_empty_child(parent: usize, index: usize, child: usize) {', 'pub unsafe fn page_table_create() -> usize {', RELEASE_EMPTY_FUNCTION, 'page-table child release');
  source = replaceBetween(source, 'pub unsafe fn page_table_create() -> usize {', 'pub unsafe fn page_table_current() -> usize {', PAGE_TABLE_CREATE, 'page-table creation');
  source = replaceBetween(source, 'pub unsafe fn page_table_activate(root: usize) -> bool {', 'pub unsafe fn page_table_map(root: usize, virtual_address: usize, physical_address: usize, flags: usize) -> bool {', PAGE_TABLE_ACTIVATE, 'page-table activation');
  source = replaceBetween(source, 'pub unsafe fn page_table_map(root: usize, virtual_address: usize, physical_address: usize, flags: usize) -> bool {', 'pub unsafe fn page_table_map_new(root: usize, virtual_address: usize, flags: usize) -> usize {', PAGE_TABLE_MAP, 'safe page mapping');
  source = replaceBetween(source, 'pub unsafe fn page_table_translate(root: usize, virtual_address: usize) -> usize {', 'pub unsafe fn page_table_unmap(root: usize, virtual_address: usize, release_physical: bool) -> usize {', PAGE_TABLE_TRANSLATE, 'safe address translation');
  source = replaceBetween(source, 'pub unsafe fn page_table_unmap(root: usize, virtual_address: usize, release_physical: bool) -> usize {', 'pub unsafe fn page_table_destroy(root: usize) -> bool {', PAGE_TABLE_UNMAP, 'safe unmapping');
  source = replaceBetween(source, 'pub unsafe fn page_table_destroy(root: usize) -> bool {', 'unsafe fn frame_is_reserved(address: usize) -> bool {', PAGE_TABLE_DESTROY_AND_SELF_TEST, 'page-table destruction and runtime self-test');
  source = replaceBetween(source, 'pub unsafe fn alloc_frame() -> usize {', 'unsafe fn heap_init(start: usize, bytes: usize) {', ALLOC_FRAME, 'owned frame allocation');
  source = replaceOnce(source, '    FREE_FRAME_COUNT = 0\n    NEXT_FRAME = align_up(start, PAGE_SIZE)', '    FREE_FRAME_COUNT = 0\n    frame_ownership_reset()\n    NEXT_FRAME = align_up(start, PAGE_SIZE)', 'fallback ownership reset');
  source = replaceOnce(source, '    FREE_FRAME_COUNT = 0\n    if !parse_multiboot_memory_map(boot_info) {', '    FREE_FRAME_COUNT = 0\n    frame_ownership_reset()\n    if !parse_multiboot_memory_map(boot_info) {', 'memory-map ownership reset');
  source = replaceOnce(source, '    heap_init(HEAP_BASE, HEAP_SIZE)', '    heap_init(SAFE_HEAP_BASE, SAFE_HEAP_SIZE)', 'ownership-reserved heap');

  const runSelfTest = options.memorySelfTest ?? Boolean(options.smoke);
  if (runSelfTest) {
    source = replaceOnce(
      source,
      '    heap_init(SAFE_HEAP_BASE, SAFE_HEAP_SIZE)\n    if boot_info == 0 {',
      `    heap_init(SAFE_HEAP_BASE, SAFE_HEAP_SIZE)
    let memory_runtime_ready: bool = memory_runtime_self_test()
    if memory_runtime_ready {
        serial_write_byte(0x56)
    } else {
        serial_write_byte(0x58)
        io.out32(0xF4, 17)
        cpu.halt()
    }
    if boot_info == 0 {`,
      'runtime memory self-test',
    );
  }
  return source;
}
