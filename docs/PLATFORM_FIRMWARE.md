# ACPI, PCIe ECAM and IOMMU platform firmware

Kura now parses and validates ACPI RSDP v1/v2, RSDT/XSDT roots, MCFG, DMAR and IVRS tables. The host model provides physical-memory table discovery, PCIe ECAM addressing, standard and extended PCI capability walking, MSI-X BAR mapping, Intel VT-d root/context planning and AMD-Vi device-table planning.

The generated x86_64 kernel discovers ACPI through Multiboot2 ACPI tags, validates checksums, selects XSDT or RSDT, reads the first MCFG segment, uses ECAM configuration accesses with legacy PCI fallback, walks MSI-X capabilities and discovers DMAR/IVRS remapping units. It prepares a page-aligned IOMMU root through the DMA allocator and exposes VT-d/AMD-Vi enable paths.

```bash
kr-hardware firmware-manifest --json
kr-hardware firmware-smoke
kr-hardware qemu-smoke --out-dir build/hardware-qemu-smoke
```

The QEMU smoke command builds the complete scheduler/userspace/hardware kernel, creates a GRUB ISO and boots through Multiboot2 into the 64-bit kernel. The deterministic smoke checkpoint now continues through Multiboot2 memory discovery, validates the ACPI root, locates the MCFG table, and only then exits. Device MMIO is still not touched by the smoke checkpoint. ACPI, ECAM, MSI-X and IOMMU behavior is validated separately by executable models, generated-source checks and linked ELF symbols. Real Intel VT-d and AMD-Vi validation still requires machines or virtual platforms exposing those units; the parser and register plans do not imply that every vendor implementation has been exercised.

## QEMU checkpoint contract

The successful checkpoint writes serial byte `0x41` and exits through `isa-debug-exit` only after both `acpi_root_table()` and `acpi_find_table(MCFG)` return non-zero addresses. Failure writes `0x45` and uses a distinct exit code. This verifies GRUB, Multiboot2 ACPI tags, long mode, paging, boot-info parsing, ACPI checksums and MCFG discovery without relying on emulated device register behavior.
