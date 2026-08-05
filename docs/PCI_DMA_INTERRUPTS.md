# PCI, DMA, IOMMU, MSI and MSI-X runtime

Kura's hardware layer now includes a deterministic runtime model and generated x86_64 kernel support for discovering devices, assigning resources, preparing DMA memory and routing message-signalled interrupts.

## PCI hierarchy

The host model implements:

- PCI configuration address encoding;
- multifunction device scanning;
- recursive bridge and secondary-bus traversal;
- class, subclass and programming-interface decoding;
- 32-bit, 64-bit and I/O BAR decoding;
- destructive BAR size probing with save and restore;
- aligned I/O, MMIO32 and MMIO64 resource assignment;
- deterministic driver matching and binding.

## DMA and IOMMU

`DmaAllocator` provides page-rounded contiguous allocations with alignment, ownership tags, freeing and coalescing. `IommuDomainModel` tracks page mappings, permissions, translation faults and invalidation records.

The generated Kura kernel source adds a bounded physical DMA pool and page allocator. It also establishes the interface used by a platform IOMMU implementation. The current kernel-side IOMMU function validates and records an identity-mapped DMA window; it does not yet program Intel VT-d or AMD-Vi hardware tables.

## MSI and MSI-X

The runtime provides:

- xAPIC MSI address and data encoding;
- vector ownership and allocation;
- MSI-X entry programming, masking and pending-bit behavior;
- shared interrupt handlers;
- interrupt-driven completion queues;
- EOI accounting.

The generated kernel includes vector allocation, MSI-X table writes and a hardware interrupt dispatch entry.

```bash
kr-hardware runtime-manifest --json
kr-hardware runtime-smoke
kr-hardware kernel -o kernel-hardware.kr
kr-hardware build --out-dir build/hardware
```

This stage validates resource management and links the runtime into the generated kernel ELF. Real-device completion still requires platform ACPI MCFG parsing, vendor IOMMU register programming, MSI-X capability mapping and boot tests on QEMU and physical hardware.
