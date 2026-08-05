# Kura Physical and Virtual Memory Runtime

This layer builds reusable physical-frame and x86_64 page-table management on top of the Multiboot2 memory-map allocator.

## Reclaiming physical frames

The generated kernel runtime maintains an intrusive singly linked free list. The first machine word of each released 4 KiB frame stores the address of the next released frame. This avoids a separate metadata allocation during early boot.

```kr
unsafe {
    let frame: usize = alloc_frame()
    let released: bool = free_frame(frame)
    let reusable: usize = free_frame_count()
}
```

`alloc_frame()` always consumes a released frame before advancing through undiscovered Multiboot2 memory-map regions. `free_frame()` rejects:

- zero or unaligned addresses
- addresses outside bootloader-declared available RAM
- addresses outside the current first-GiB identity map
- the reserved low kernel range
- frames overlapping the live Multiboot2 information block
- frames already present in the free list

The free list is reset whenever the physical allocator is initialized.

## Address-space handles

A page-table object is represented by the physical address of its PML4 root. `page_table_create()` allocates an independent PML4, PDPT, and page directory and installs a private identity mapping for the first GiB using 2 MiB pages. This keeps the kernel runtime executable after switching CR3.

```kr
unsafe {
    let space: usize = page_table_create()
    if space != 0 {
        page_table_activate(space)
    }
}
```

The runtime exposes:

```kr
pub unsafe fn page_table_create() -> usize
pub unsafe fn page_table_current() -> usize
pub unsafe fn page_table_activate(root: usize) -> bool
pub unsafe fn page_table_map(root: usize, virtual_address: usize, physical_address: usize, flags: usize) -> bool
pub unsafe fn page_table_map_new(root: usize, virtual_address: usize, flags: usize) -> usize
pub unsafe fn page_table_translate(root: usize, virtual_address: usize) -> usize
pub unsafe fn page_table_unmap(root: usize, virtual_address: usize, release_physical: bool) -> usize
pub unsafe fn page_table_destroy(root: usize) -> bool
```

## Mapping behavior

`page_table_map()` creates missing PDPT, page-directory, and page-table frames on demand. Newly created intermediate tables inherit the writable flag and the caller's user-accessible flag. Existing huge-page entries are never split implicitly; attempts to map through them fail.

`page_table_map_new()` allocates a physical frame and maps it in one operation. If mapping fails, the new physical frame is returned to the free list.

`page_table_translate()` resolves ordinary 4 KiB pages and existing 2 MiB or 1 GiB huge-page entries.

`page_table_unmap()` clears a 4 KiB leaf entry, invalidates the active TLB entry, optionally releases the mapped physical frame, and walks upward to reclaim empty page-table levels.

## Destroying an address space

`page_table_destroy()` succeeds only when:

- the root is not the bootstrap PML4
- the root is not currently active in CR3
- every dynamic mapping has been removed
- only the generated first-GiB identity map remains

It then releases the identity-map directory, PDPT, and PML4 frames back to the physical free list.

## Current limits

- page-table metadata frames must remain inside the first-GiB identity map
- map and unmap operate on 4 KiB leaves; huge entries are translated but not dynamically created or split
- there is no locking yet, so allocator and page-table mutation are single-core early-runtime operations
- there is no copy-on-write, shared address-space ownership, or userspace privilege-transition runtime yet
- the early heap remains a non-reclaiming bump allocator

The next memory layer should add synchronized frame allocation, huge-page splitting, reclaiming kernel heaps, and explicit kernel/user address-space ownership.
