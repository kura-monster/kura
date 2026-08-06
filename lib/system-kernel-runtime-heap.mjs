// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createKernelRuntimeSource as createHardenedKernelRuntimeSource,
  createX86_64BootstrapAssembly,
} from './system-kernel-runtime-vm-native.mjs';

export {
  DEFAULT_KERNEL_MEMORY_LAYOUT,
  createKernelArchitectureManifest,
  createX86_64BootstrapAssembly,
};

function replaceOnce(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Kernel heap extension anchor not found: ${label}`);
  }
  return source.replace(search, replacement);
}

function replaceBetween(source, start, end, replacement, label) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) {
    throw new Error(`Kernel heap extension start anchor not found: ${label}`);
  }
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) {
    throw new Error(`Kernel heap extension end anchor not found: ${label}`);
  }
  return `${source.slice(0, startIndex)}${replacement}\n\n${source.slice(endIndex)}`;
}

const HEAP_STATE = `static mut HEAP_START: usize = 0
static mut HEAP_END: usize = 0
static mut HEAP_FREE_HEAD: usize = 0
static mut HEAP_TOTAL_BYTES: usize = 0
static mut HEAP_ALLOCATED_BYTES: usize = 0
static mut HEAP_ALLOCATION_COUNT: usize = 0`;

const HEAP_CONSTANTS = `const HEAP_ALIGNMENT: usize = 16
const HEAP_HEADER_SIZE: usize = 32
const HEAP_PREFIX_SIZE: usize = 16
const HEAP_FOOTER_SIZE: usize = 8
const HEAP_MIN_BLOCK_SIZE: usize = 64
const HEAP_FLAG_ALLOCATED: usize = 1
const HEAP_SIZE_MASK: usize = 0xFFFFFFFFFFFFFFF0
const HEAP_HEADER_MAGIC: usize = 0x4B485041
const HEAP_PREFIX_MAGIC: usize = 0x4B485052
const VM_SELF_TEST_ADDRESS: usize = 0x40000000`;

const HEAP_FUNCTIONS = `fn heap_alignment_is_valid(alignment: usize) -> bool {
    if alignment == 0 || alignment > PAGE_SIZE {
        return false
    }
    return (alignment & (alignment - 1)) == 0
}

unsafe fn heap_block_size(block: usize) -> usize {
    return memory.read<usize>(block) & HEAP_SIZE_MASK
}

unsafe fn heap_block_is_allocated(block: usize) -> bool {
    return (memory.read<usize>(block) & HEAP_FLAG_ALLOCATED) != 0
}

unsafe fn heap_block_is_valid(block: usize) -> bool {
    if block < HEAP_START || block + HEAP_MIN_BLOCK_SIZE < block || block + HEAP_MIN_BLOCK_SIZE > HEAP_END {
        return false
    }
    if block % HEAP_ALIGNMENT != 0 {
        return false
    }
    let size_flags: usize = memory.read<usize>(block)
    let size: usize = size_flags & HEAP_SIZE_MASK
    if size < HEAP_MIN_BLOCK_SIZE || size % HEAP_ALIGNMENT != 0 {
        return false
    }
    let block_end: usize = block + size
    if block_end < block || block_end > HEAP_END {
        return false
    }
    if memory.read<usize>(block + 8) != HEAP_HEADER_MAGIC {
        return false
    }
    return memory.read<usize>(block_end - HEAP_FOOTER_SIZE) == size_flags
}

unsafe fn heap_block_write(block: usize, size: usize, allocated: bool) {
    let size_flags: usize = size
    if allocated {
        size_flags = size_flags | HEAP_FLAG_ALLOCATED
    }
    memory.write<usize>(block, size_flags)
    memory.write<usize>(block + 8, HEAP_HEADER_MAGIC)
    memory.write<usize>(block + 16, 0)
    memory.write<usize>(block + 24, 0)
    memory.write<usize>(block + size - HEAP_FOOTER_SIZE, size_flags)
}

unsafe fn heap_free_insert(block: usize) {
    memory.write<usize>(block + 16, 0)
    memory.write<usize>(block + 24, HEAP_FREE_HEAD)
    if HEAP_FREE_HEAD != 0 {
        memory.write<usize>(HEAP_FREE_HEAD + 16, block)
    }
    HEAP_FREE_HEAD = block
}

unsafe fn heap_free_remove(block: usize) {
    let previous: usize = memory.read<usize>(block + 16)
    let next: usize = memory.read<usize>(block + 24)
    if previous != 0 {
        memory.write<usize>(previous + 24, next)
    } else {
        HEAP_FREE_HEAD = next
    }
    if next != 0 {
        memory.write<usize>(next + 16, previous)
    }
    memory.write<usize>(block + 16, 0)
    memory.write<usize>(block + 24, 0)
}

unsafe fn heap_address_to_block(address: usize) -> usize {
    if address < HEAP_START + HEAP_HEADER_SIZE + HEAP_PREFIX_SIZE || address >= HEAP_END {
        return 0
    }
    let prefix: usize = address - HEAP_PREFIX_SIZE
    if memory.read<usize>(prefix + 8) != HEAP_PREFIX_MAGIC {
        return 0
    }
    let block: usize = memory.read<usize>(prefix)
    if !heap_block_is_valid(block) || !heap_block_is_allocated(block) {
        return 0
    }
    let size: usize = heap_block_size(block)
    if address < block + HEAP_HEADER_SIZE + HEAP_PREFIX_SIZE || address >= block + size - HEAP_FOOTER_SIZE {
        return 0
    }
    if memory.read<usize>(block + 16) != address {
        return 0
    }
    return block
}

unsafe fn heap_init(start: usize, bytes: usize) {
    HEAP_START = align_up(start, HEAP_ALIGNMENT)
    let raw_end: usize = start + bytes
    if raw_end < start {
        HEAP_END = HEAP_START
    } else {
        HEAP_END = align_down(raw_end, HEAP_ALIGNMENT)
    }
    HEAP_FREE_HEAD = 0
    HEAP_TOTAL_BYTES = 0
    HEAP_ALLOCATED_BYTES = 0
    HEAP_ALLOCATION_COUNT = 0
    if HEAP_END <= HEAP_START || HEAP_END - HEAP_START < HEAP_MIN_BLOCK_SIZE {
        return
    }
    HEAP_TOTAL_BYTES = HEAP_END - HEAP_START
    heap_block_write(HEAP_START, HEAP_TOTAL_BYTES, false)
    heap_free_insert(HEAP_START)
}

pub unsafe fn heap_alloc(bytes: usize, alignment: usize) -> usize {
    if bytes == 0 {
        return 0
    }
    let align: usize = alignment
    if align == 0 {
        align = 1
    }
    if !heap_alignment_is_valid(align) {
        return 0
    }
    let required_base: usize = bytes + HEAP_HEADER_SIZE + HEAP_PREFIX_SIZE + HEAP_FOOTER_SIZE
    if required_base < bytes {
        return 0
    }
    let required_with_padding: usize = required_base + align - 1
    if required_with_padding < required_base {
        return 0
    }
    let required: usize = align_up(required_with_padding, HEAP_ALIGNMENT)
    if required < required_with_padding {
        return 0
    }
    let cursor: usize = HEAP_FREE_HEAD
    while cursor != 0 {
        if !heap_block_is_valid(cursor) || heap_block_is_allocated(cursor) {
            return 0
        }
        let next: usize = memory.read<usize>(cursor + 24)
        let block_size: usize = heap_block_size(cursor)
        if block_size >= required {
            let user: usize = align_up(cursor + HEAP_HEADER_SIZE + HEAP_PREFIX_SIZE, align)
            let user_end: usize = user + bytes
            if user_end < user {
                return 0
            }
            let used_raw: usize = user_end + HEAP_FOOTER_SIZE - cursor
            if used_raw < bytes {
                return 0
            }
            let used: usize = align_up(used_raw, HEAP_ALIGNMENT)
            if used > block_size {
                return 0
            }
            heap_free_remove(cursor)
            let allocated_size: usize = block_size
            let remaining: usize = block_size - used
            if remaining >= HEAP_MIN_BLOCK_SIZE {
                allocated_size = used
                let tail: usize = cursor + used
                heap_block_write(tail, remaining, false)
                heap_free_insert(tail)
            }
            heap_block_write(cursor, allocated_size, true)
            memory.write<usize>(cursor + 16, user)
            memory.write<usize>(cursor + 24, bytes)
            memory.write<usize>(user - HEAP_PREFIX_SIZE, cursor)
            memory.write<usize>(user - 8, HEAP_PREFIX_MAGIC)
            HEAP_ALLOCATED_BYTES += allocated_size
            HEAP_ALLOCATION_COUNT += 1
            return user
        }
        cursor = next
    }
    return 0
}

pub unsafe fn heap_alloc_zeroed(bytes: usize, alignment: usize) -> usize {
    let address: usize = heap_alloc(bytes, alignment)
    if address == 0 {
        return 0
    }
    let offset: usize = 0
    while offset + 8 <= bytes {
        memory.write<u64>(address + offset, 0)
        offset += 8
    }
    while offset < bytes {
        memory.write<u8>(address + offset, 0)
        offset += 1
    }
    return address
}

pub unsafe fn heap_usable_size(address: usize) -> usize {
    let block: usize = heap_address_to_block(address)
    if block == 0 {
        return 0
    }
    return block + heap_block_size(block) - HEAP_FOOTER_SIZE - address
}

pub unsafe fn heap_free(address: usize) -> bool {
    let block: usize = heap_address_to_block(address)
    if block == 0 {
        return false
    }
    let original_size: usize = heap_block_size(block)
    memory.write<usize>(address - HEAP_PREFIX_SIZE, 0)
    memory.write<usize>(address - 8, 0)
    if HEAP_ALLOCATED_BYTES >= original_size {
        HEAP_ALLOCATED_BYTES -= original_size
    } else {
        HEAP_ALLOCATED_BYTES = 0
    }
    if HEAP_ALLOCATION_COUNT > 0 {
        HEAP_ALLOCATION_COUNT -= 1
    }

    let merged_start: usize = block
    let merged_size: usize = original_size
    heap_block_write(merged_start, merged_size, false)

    let next: usize = merged_start + merged_size
    if next < HEAP_END && heap_block_is_valid(next) && !heap_block_is_allocated(next) {
        let next_size: usize = heap_block_size(next)
        heap_free_remove(next)
        merged_size += next_size
    }

    if merged_start > HEAP_START {
        let previous_flags: usize = memory.read<usize>(merged_start - HEAP_FOOTER_SIZE)
        let previous_size: usize = previous_flags & HEAP_SIZE_MASK
        if previous_size >= HEAP_MIN_BLOCK_SIZE && previous_size % HEAP_ALIGNMENT == 0 && previous_size <= merged_start - HEAP_START {
            let previous: usize = merged_start - previous_size
            if heap_block_is_valid(previous) && !heap_block_is_allocated(previous) && previous + previous_size == merged_start {
                heap_free_remove(previous)
                merged_start = previous
                merged_size += previous_size
            }
        }
    }

    heap_block_write(merged_start, merged_size, false)
    heap_free_insert(merged_start)
    return true
}

pub unsafe fn heap_realloc(address: usize, bytes: usize, alignment: usize) -> usize {
    if address == 0 {
        return heap_alloc(bytes, alignment)
    }
    if bytes == 0 {
        heap_free(address)
        return 0
    }
    let usable: usize = heap_usable_size(address)
    if usable == 0 {
        return 0
    }
    if bytes <= usable {
        return address
    }
    let replacement: usize = heap_alloc(bytes, alignment)
    if replacement == 0 {
        return 0
    }
    let copy_bytes: usize = usable
    let offset: usize = 0
    while offset + 8 <= copy_bytes {
        memory.write<u64>(replacement + offset, memory.read<u64>(address + offset))
        offset += 8
    }
    while offset < copy_bytes {
        memory.write<u8>(replacement + offset, memory.read<u8>(address + offset))
        offset += 1
    }
    heap_free(address)
    return replacement
}

pub unsafe fn heap_total_bytes() -> usize {
    return HEAP_TOTAL_BYTES
}

pub unsafe fn heap_allocated_bytes() -> usize {
    return HEAP_ALLOCATED_BYTES
}

pub unsafe fn heap_free_bytes() -> usize {
    if HEAP_ALLOCATED_BYTES > HEAP_TOTAL_BYTES {
        return 0
    }
    return HEAP_TOTAL_BYTES - HEAP_ALLOCATED_BYTES
}

pub unsafe fn heap_allocation_count() -> usize {
    return HEAP_ALLOCATION_COUNT
}

pub unsafe fn heap_largest_free_block() -> usize {
    let largest: usize = 0
    let cursor: usize = HEAP_FREE_HEAD
    let checked: usize = 0
    while cursor != 0 && checked <= HEAP_ALLOCATION_COUNT + 4096 {
        if !heap_block_is_valid(cursor) || heap_block_is_allocated(cursor) {
            return 0
        }
        let size: usize = heap_block_size(cursor)
        if size > largest {
            largest = size
        }
        cursor = memory.read<usize>(cursor + 24)
        checked += 1
    }
    return largest
}

pub unsafe fn heap_validate() -> bool {
    if HEAP_TOTAL_BYTES == 0 {
        return HEAP_START == HEAP_END && HEAP_FREE_HEAD == 0
    }
    let cursor: usize = HEAP_START
    let free_blocks: usize = 0
    let allocated_blocks: usize = 0
    let allocated_bytes: usize = 0
    let previous_free: bool = false
    while cursor < HEAP_END {
        if !heap_block_is_valid(cursor) {
            return false
        }
        let size: usize = heap_block_size(cursor)
        let allocated: bool = heap_block_is_allocated(cursor)
        if allocated {
            allocated_blocks += 1
            allocated_bytes += size
            previous_free = false
        } else {
            if previous_free {
                return false
            }
            free_blocks += 1
            previous_free = true
        }
        cursor += size
    }
    if cursor != HEAP_END || allocated_blocks != HEAP_ALLOCATION_COUNT || allocated_bytes != HEAP_ALLOCATED_BYTES {
        return false
    }
    let listed: usize = 0
    let free_cursor: usize = HEAP_FREE_HEAD
    while free_cursor != 0 {
        if !heap_block_is_valid(free_cursor) || heap_block_is_allocated(free_cursor) {
            return false
        }
        listed += 1
        if listed > free_blocks {
            return false
        }
        free_cursor = memory.read<usize>(free_cursor + 24)
    }
    return listed == free_blocks
}

pub unsafe fn heap_runtime_self_test() -> bool {
    if !heap_validate() {
        return false
    }
    let initial_free: usize = heap_free_bytes()
    let first: usize = heap_alloc(64, 16)
    let middle: usize = heap_alloc(128, 64)
    let zeroed: usize = heap_alloc_zeroed(48, 32)
    if first == 0 || middle == 0 || zeroed == 0 {
        return false
    }
    if first % 16 != 0 || middle % 64 != 0 || zeroed % 32 != 0 {
        return false
    }
    memory.write<u64>(first, 0x1111222233334444)
    memory.write<u64>(middle, 0x5555666677778888)
    if memory.read<u64>(zeroed) != 0 {
        return false
    }
    if !heap_free(middle) {
        return false
    }
    let reused: usize = heap_alloc(96, 64)
    if reused != middle {
        return false
    }
    let grown: usize = heap_realloc(first, 256, 16)
    if grown == 0 || memory.read<u64>(grown) != 0x1111222233334444 {
        return false
    }
    if !heap_free(zeroed) || !heap_free(reused) || !heap_free(grown) {
        return false
    }
    if !heap_validate() || heap_allocation_count() != 0 || heap_allocated_bytes() != 0 {
        return false
    }
    return heap_free_bytes() == initial_free && heap_largest_free_block() == initial_free
}`;

export function createKernelRuntimeSource(options = {}) {
  let source = createHardenedKernelRuntimeSource(options);
  source = replaceOnce(
    source,
    'const VM_SELF_TEST_ADDRESS: usize = 0x40000000',
    HEAP_CONSTANTS,
    'heap constants',
  );
  source = replaceOnce(
    source,
    'static mut HEAP_NEXT: usize = HEAP_BASE\nstatic mut HEAP_END: usize = HEAP_BASE + HEAP_SIZE',
    HEAP_STATE,
    'heap state',
  );
  source = replaceBetween(
    source,
    'unsafe fn heap_init(start: usize, bytes: usize) {',
    'unsafe fn exception_stop(code: u8) -> never {',
    HEAP_FUNCTIONS,
    'reclaiming heap implementation',
  );

  const runSelfTest = options.heapSelfTest ?? Boolean(options.smoke);
  if (runSelfTest) {
    source = replaceOnce(
      source,
      '    if boot_info == 0 {',
      `    let heap_runtime_ready: bool = heap_runtime_self_test()
    if heap_runtime_ready {
        serial_write_byte(0x48)
    } else {
        serial_write_byte(0x59)
        io.out32(0xF4, 18)
        cpu.halt()
    }
    if boot_info == 0 {`,
      'heap runtime self-test',
    );
  }
  return source;
}
