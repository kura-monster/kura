# Kura Reclaiming Kernel Heap

This layer replaces the early one-way bump allocator with a reclaiming boundary-tag heap while preserving the existing `heap_alloc(bytes, alignment)` entry point.

## Block layout

Every heap block is aligned to 16 bytes and contains:

```text
+0x00  size and allocation flags
+0x08  header magic
+0x10  allocated user pointer or free-list previous pointer
+0x18  requested size or free-list next pointer
...    aligned payload and optional alignment padding
end-8  boundary-tag footer matching the size and flags
```

Allocated pointers also have a 16-byte prefix immediately before the returned address. The prefix stores the owning block address and a magic value. This allows `heap_free()` and `heap_realloc()` to validate that the supplied pointer is exactly the pointer returned by the allocator rather than an interior address.

The minimum block size is 64 bytes. Requested alignments must be powers of two between 1 byte and the architecture page size.

## Allocation

`heap_alloc()` performs a first-fit search through an intrusive doubly linked free list. When a free block is larger than required, the allocator splits an aligned tail block when the remainder is at least the minimum block size.

The public heap API is:

```kr
pub unsafe fn heap_alloc(bytes: usize, alignment: usize) -> usize
pub unsafe fn heap_alloc_zeroed(bytes: usize, alignment: usize) -> usize
pub unsafe fn heap_usable_size(address: usize) -> usize
pub unsafe fn heap_free(address: usize) -> bool
pub unsafe fn heap_realloc(address: usize, bytes: usize, alignment: usize) -> usize
pub unsafe fn heap_total_bytes() -> usize
pub unsafe fn heap_allocated_bytes() -> usize
pub unsafe fn heap_free_bytes() -> usize
pub unsafe fn heap_allocation_count() -> usize
pub unsafe fn heap_largest_free_block() -> usize
pub unsafe fn heap_validate() -> bool
pub unsafe fn heap_runtime_self_test() -> bool
```

`heap_alloc_zeroed()` clears exactly the requested payload. `heap_realloc()` preserves the old allocation when the current usable area is large enough; otherwise it allocates a replacement, copies the previous usable payload, and releases the old block only after the replacement succeeds.

## Freeing and coalescing

`heap_free()` validates:

- the pointer is inside the configured heap
- the allocation prefix magic is present
- the referenced block header and footer agree
- the block is currently allocated
- the pointer exactly matches the pointer recorded in the block header

The prefix is cleared during release, so a repeated release is rejected. The allocator then merges an adjacent free successor and predecessor using the boundary tags. The resulting block is inserted at the head of the free list.

`heap_validate()` walks the physical block sequence and the free list. It checks block boundaries, header/footer agreement, the no-adjacent-free-block coalescing invariant, allocation counters, allocated-byte accounting, free-list membership count, and free-list cycles.

## Smoke execution test

Smoke kernels automatically run `heap_runtime_self_test()` after the physical-memory and page-table self-test. It performs real heap operations:

1. validate the initial single free block
2. allocate three differently aligned blocks
3. verify zeroed allocation
4. release the middle block
5. verify first-fit reuse of the released address
6. grow an allocation through `heap_realloc()` and verify copied data
7. release all allocations in a fragmentation-producing order
8. verify complete predecessor/successor coalescing
9. verify zero live allocations and restoration of the original free-byte count

Success writes `H` to the serial/debug stream. Failure writes `Y` and exits through the QEMU debug-exit port with code `0x12`. The normal smoke exit remains `0x10` after all memory tests succeed.

## Current boundary

The allocator is suitable for the current single-core early kernel. It does not yet provide:

- synchronization across CPUs or interrupt contexts
- per-CPU small-object caches
- slab size classes and constructor/destructor hooks
- direct page-backed expansion beyond the configured contiguous heap range
- guard pages or heap address randomization
- quarantine, poisoning, or use-after-free diagnostics

The next layer should introduce allocator locking and interrupt-safe critical sections, followed by slab caches for small kernel objects and page-backed large allocations.