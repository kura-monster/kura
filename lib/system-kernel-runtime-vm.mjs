// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createKernelRuntimeSource as createMemoryMapKernelRuntimeSource,
  createX86_64BootstrapAssembly,
} from './system-kernel-runtime-memory-map.mjs';

export {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createX86_64BootstrapAssembly,
};

function replaceOnce(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Kernel runtime extension anchor not found: ${label}`);
  }
  return source.replace(search, replacement);
}

const VM_CONSTANTS = `const MULTIBOOT_MEMORY_ENTRY_MIN_SIZE: usize = 24
const PAGE_TABLE_ENTRIES: usize = 512
const PAGE_PRESENT: usize = 1
const PAGE_WRITABLE: usize = 2
const PAGE_USER: usize = 4
const PAGE_HUGE: usize = 0x80
const PAGE_ADDRESS_MASK: usize = 0x000FFFFFFFFFF000
const ONE_GIB: usize = 0x40000000
const COM1: u16 = 0x3F8`;

const VM_STATE = `static mut FRAME_MEMORY_MAP_ACTIVE: bool = false
static mut MEMORY_MAP_FIRST: usize = 0
static mut FREE_FRAME_HEAD: usize = 0
static mut FREE_FRAME_COUNT: usize = 0
static mut HEAP_NEXT: usize = HEAP_BASE`;

const VM_FUNCTIONS = `unsafe fn frame_in_available_memory(address: usize) -> bool {
    if address + PAGE_SIZE < address || address + PAGE_SIZE > IDENTITY_MAPPED_BYTES {
        return false
    }
    if !FRAME_MEMORY_MAP_ACTIVE {
        return address >= FRAME_START && address + PAGE_SIZE <= FRAME_END
    }
    let cursor: usize = MEMORY_MAP_FIRST
    while cursor + MEMORY_MAP_ENTRY_SIZE <= MEMORY_MAP_END {
        let base: usize = memory.read<usize>(cursor)
        let length: usize = memory.read<usize>(cursor + 8)
        let entry_type: u32 = memory.read<u32>(cursor + 16)
        if entry_type == MULTIBOOT_MEMORY_AVAILABLE && length >= PAGE_SIZE {
            let region_end: usize = base + length
            if region_end >= base {
                let start: usize = align_up(base, PAGE_SIZE)
                let end: usize = align_down(region_end, PAGE_SIZE)
                if address >= start && address + PAGE_SIZE <= end {
                    return true
                }
            }
        }
        cursor += MEMORY_MAP_ENTRY_SIZE
    }
    return false
}

unsafe fn free_frame_is_listed(address: usize) -> bool {
    let cursor: usize = FREE_FRAME_HEAD
    let checked: usize = 0
    while cursor != 0 && checked < FREE_FRAME_COUNT {
        if cursor == address {
            return true
        }
        cursor = memory.read<usize>(cursor)
        checked += 1
    }
    return false
}

pub unsafe fn free_frame_count() -> usize {
    return FREE_FRAME_COUNT
}

pub unsafe fn free_frame(address: usize) -> bool {
    if address == 0 || address % PAGE_SIZE != 0 {
        return false
    }
    if !frame_in_available_memory(address) || frame_is_reserved(address) {
        return false
    }
    if free_frame_is_listed(address) {
        return false
    }
    memory.write<usize>(address, FREE_FRAME_HEAD)
    FREE_FRAME_HEAD = address
    FREE_FRAME_COUNT += 1
    return true
}

fn page_table_index(address: usize, shift: usize) -> usize {
    return (address >> shift) & 0x1FF
}

unsafe fn page_table_is_empty(table: usize) -> bool {
    let index: usize = 0
    while index < PAGE_TABLE_ENTRIES {
        if memory.read<usize>(table + index * 8) != 0 {
            return false
        }
        index += 1
    }
    return true
}

unsafe fn page_table_release_empty_child(parent: usize, index: usize, child: usize) {
    if child != 0 && page_table_is_empty(child) {
        memory.write<usize>(parent + index * 8, 0)
        free_frame(child)
    }
}

pub unsafe fn page_table_create() -> usize {
    let root: usize = alloc_frame()
    if root == 0 {
        return 0
    }
    zero_region(root, PAGE_SIZE)
    let pdpt: usize = alloc_frame()
    if pdpt == 0 {
        free_frame(root)
        return 0
    }
    zero_region(pdpt, PAGE_SIZE)
    let directory: usize = alloc_frame()
    if directory == 0 {
        free_frame(pdpt)
        free_frame(root)
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
}

pub unsafe fn page_table_current() -> usize {
    return cpu.read_cr3() & PAGE_ADDRESS_MASK
}

pub unsafe fn page_table_activate(root: usize) -> bool {
    if root == 0 || root % PAGE_SIZE != 0 {
        return false
    }
    if (memory.read<usize>(root) & PAGE_PRESENT) == 0 {
        return false
    }
    cpu.write_cr3(root)
    return true
}

pub unsafe fn page_table_map(root: usize, virtual_address: usize, physical_address: usize, flags: usize) -> bool {
    if root == 0 || root % PAGE_SIZE != 0 {
        return false
    }
    if virtual_address % PAGE_SIZE != 0 || physical_address == 0 || physical_address % PAGE_SIZE != 0 {
        return false
    }
    let pml4_index: usize = page_table_index(virtual_address, 39)
    let pdpt_index: usize = page_table_index(virtual_address, 30)
    let directory_index: usize = page_table_index(virtual_address, 21)
    let table_index: usize = page_table_index(virtual_address, 12)
    let branch_flags: usize = PAGE_PRESENT | PAGE_WRITABLE | (flags & PAGE_USER)

    let pml4_entry_address: usize = root + pml4_index * 8
    let pml4_entry: usize = memory.read<usize>(pml4_entry_address)
    let pdpt: usize = 0
    let created_pdpt: bool = false
    if (pml4_entry & PAGE_PRESENT) != 0 {
        if (pml4_entry & PAGE_HUGE) != 0 {
            return false
        }
        pdpt = pml4_entry & PAGE_ADDRESS_MASK
    } else {
        pdpt = alloc_frame()
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
        directory = pdpt_entry & PAGE_ADDRESS_MASK
    } else {
        directory = alloc_frame()
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
        table = directory_entry & PAGE_ADDRESS_MASK
    } else {
        table = alloc_frame()
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
    memory.write<usize>(entry_address, physical_address | flags | PAGE_PRESENT)
    return true
}

pub unsafe fn page_table_map_new(root: usize, virtual_address: usize, flags: usize) -> usize {
    let frame: usize = alloc_frame()
    if frame == 0 {
        return 0
    }
    if !page_table_map(root, virtual_address, frame, flags) {
        free_frame(frame)
        return 0
    }
    return frame
}

pub unsafe fn page_table_translate(root: usize, virtual_address: usize) -> usize {
    if root == 0 || root % PAGE_SIZE != 0 {
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
}

pub unsafe fn page_table_unmap(root: usize, virtual_address: usize, release_physical: bool) -> usize {
    if root == 0 || virtual_address % PAGE_SIZE != 0 {
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
    memory.write<usize>(entry_address, 0)
    cpu.invalidate_page(virtual_address)
    if release_physical {
        free_frame(physical)
    }
    page_table_release_empty_child(directory, directory_index, table)
    page_table_release_empty_child(pdpt, pdpt_index, directory)
    page_table_release_empty_child(root, pml4_index, pdpt)
    return physical
}

pub unsafe fn page_table_destroy(root: usize) -> bool {
    if root == 0 || root == PML4_BASE || root % PAGE_SIZE != 0 {
        return false
    }
    if page_table_current() == root {
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
    free_frame(directory)
    free_frame(pdpt)
    free_frame(root)
    return true
}`;

export function createKernelRuntimeSource(options = {}) {
  let source = createMemoryMapKernelRuntimeSource(options);
  source = replaceOnce(
    source,
    'const MULTIBOOT_MEMORY_ENTRY_MIN_SIZE: usize = 24\nconst COM1: u16 = 0x3F8',
    VM_CONSTANTS,
    'VM constants',
  );
  source = replaceOnce(
    source,
    'static mut FRAME_MEMORY_MAP_ACTIVE: bool = false\nstatic mut HEAP_NEXT: usize = HEAP_BASE',
    VM_STATE,
    'VM state',
  );
  source = replaceOnce(
    source,
    'unsafe fn frame_allocator_init(start: usize, end: usize) {\n    FRAME_MEMORY_MAP_ACTIVE = false',
    'unsafe fn frame_allocator_init(start: usize, end: usize) {\n    FRAME_MEMORY_MAP_ACTIVE = false\n    MEMORY_MAP_FIRST = 0\n    FREE_FRAME_HEAD = 0\n    FREE_FRAME_COUNT = 0',
    'fallback allocator reset',
  );
  source = replaceOnce(
    source,
    '            MEMORY_MAP_CURSOR = tag + 16\n            MEMORY_MAP_END = tag_end',
    '            MEMORY_MAP_FIRST = tag + 16\n            MEMORY_MAP_CURSOR = MEMORY_MAP_FIRST\n            MEMORY_MAP_END = tag_end',
    'memory map start',
  );
  source = replaceOnce(
    source,
    'unsafe fn frame_allocator_init_from_multiboot(boot_info: usize) -> bool {\n    FRAME_MEMORY_MAP_ACTIVE = false',
    'unsafe fn frame_allocator_init_from_multiboot(boot_info: usize) -> bool {\n    FRAME_MEMORY_MAP_ACTIVE = false\n    MEMORY_MAP_FIRST = 0\n    FREE_FRAME_HEAD = 0\n    FREE_FRAME_COUNT = 0',
    'memory map allocator reset',
  );
  source = replaceOnce(
    source,
    'unsafe fn frame_is_reserved(address: usize) -> bool {',
    `${VM_FUNCTIONS}\n\nunsafe fn frame_is_reserved(address: usize) -> bool {`,
    'reclaiming allocator and page tables',
  );
  source = replaceOnce(
    source,
    'pub unsafe fn alloc_frame() -> usize {\n    while true {',
    `pub unsafe fn alloc_frame() -> usize {\n    if FREE_FRAME_HEAD != 0 {\n        let current: usize = FREE_FRAME_HEAD\n        FREE_FRAME_HEAD = memory.read<usize>(current)\n        if FREE_FRAME_COUNT > 0 {\n            FREE_FRAME_COUNT -= 1\n        }\n        memory.write<usize>(current, 0)\n        return current\n    }\n    while true {`,
    'free-list allocation',
  );
  return source;
}
