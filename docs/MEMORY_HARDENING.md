# Kura Kernel Memory Hardening

This layer hardens the reclaiming frame allocator and x86_64 page-table runtime with explicit ownership tracking, input validation, and a boot-time execution test.

## Physical-frame ownership

The first portion of the configured early heap is reserved as a one-byte-per-frame ownership table for the currently identity-mapped first GiB. With 4 KiB pages, the table occupies 256 KiB. The ordinary bump heap begins at the next page-aligned address after this table.

Every tracked physical frame is in one of four states:

- `UNKNOWN`: not allocated by the runtime
- `ALLOCATED`: ordinary data frame returned by `alloc_frame()`
- `PAGE_TABLE`: frame owned by a PML4, PDPT, page directory, or page table
- `RELEASED`: frame currently linked into the intrusive free list

`alloc_frame()` changes a newly discovered or reused frame to `ALLOCATED`. Page-table construction upgrades frames through an internal `alloc_page_table_frame()` path. Public `free_frame()` accepts only `ALLOCATED` frames, while page-table frames can be returned only through the internal page-table release path.

This prevents:

- freeing an address that was never allocated
- freeing the same frame twice
- releasing a live page-table frame through the public API
- treating a released frame as still owned
- destroying a page-table root that is not runtime-managed

The ownership table is cleared whenever the physical allocator is initialized.

## Page-table validation

The runtime validates virtual addresses using the x86_64 48-bit canonical-address rule before mapping, translating, or unmapping them.

Leaf flags are restricted to:

- writable
- user accessible
- write-through
- cache disabled
- global
- no-execute

Callers cannot inject `present`, `huge`, address bits, or unknown bits through the public flags argument. Physical addresses must be page-aligned and fit inside the page-table physical-address mask.

When a user-accessible mapping is added beneath an existing branch, the `USER` bit is promoted through the existing PML4, PDPT, and page-directory entries. Supervisor-only identity-map branches remain protected by their lower-level entries.

`page_table_activate()` accepts only the bootstrap PML4 or a runtime-owned page-table root. `page_table_unmap()` invalidates a page only when the modified root is currently active; an eventual CR3 switch flushes inactive-address-space translations.

## Smoke execution test

Smoke kernels automatically call:

```kr
pub unsafe fn memory_runtime_self_test() -> bool
```

The test performs real runtime operations:

1. allocate a physical frame
2. release it and verify immediate free-list reuse
3. create an independent address space
4. map the reused frame at virtual address `0x40000000`
5. translate the mapping and verify its physical address
6. switch CR3 to the new address space
7. write and read a 64-bit pattern through the mapped virtual address
8. restore the previous CR3
9. unmap and release the physical frame
10. destroy the address space and reclaim its page-table frames

A successful test writes `V` to the serial/debug stream. A failure writes `X` and exits through the QEMU debug-exit port with code `0x11`. The normal smoke path still exits with code `0x10` after the test succeeds.

The regular JavaScript regression suite generates this complete Kura source and lowers it to LLVM IR. Running the smoke image through QEMU additionally executes the CR3 switch and mapped-memory read/write sequence.

## Current boundary

This hardening closes accidental frame release and malformed mapping inputs for the single-core early runtime. It does not yet provide:

- allocator locking or per-CPU caches
- cross-CPU TLB shootdown
- huge-page creation or splitting
- copy-on-write ownership
- reference-counted shared physical mappings
- reclaiming general-purpose kernel heap allocation
- memory above the current first-GiB metadata window

The next memory layer should add a synchronized allocator and TLB-shootdown protocol, then a reclaiming slab/buddy heap and huge-page splitting.