# Native hardware-driver foundation

Kura's x86_64 kernel layer now includes executable driver foundations and host-side models for storage, USB, networking, and graphics.

## NVMe

- controller and namespace Identify decoding;
- admin and I/O queue models with command-ID ownership and completion phase bits;
- 64-byte command encoding;
- read/write command construction;
- PRP1, PRP2, and PRP-list planning;
- MMIO controller disable, queue setup, enable, and ready-state polling in generated Kura kernel code.

## USB xHCI and HID

- generic 16-byte TRB encoding and decoding;
- producer/consumer cycle-state ring model with Link TRBs;
- device, configuration, interface, endpoint, and HID descriptor parsing;
- boot-protocol keyboard and mouse report decoding;
- xHCI halt, reset, command-ring programming, and run sequence in generated kernel code.

## VirtIO-Net

- feature negotiation;
- modern/legacy network header encoding;
- bounded transmit and receive queues;
- completion accounting and link state;
- legacy PCI I/O initialization and receive/transmit queue PFN setup in generated kernel code.

## Framebuffer

- XRGB8888, BGRX8888, and RGB565 surfaces;
- checked pixel access, rectangle fill, overlap-safe blitting, and deterministic checksums;
- kernel framebuffer configuration and volatile pixel writes.

```bash
kr-hardware manifest --json
kr-hardware emit -o hardware.kr
kr-hardware kernel -o kernel-hardware.kr
kr-hardware build --out-dir build/hardware
kr-hardware smoke
```

`kr-hardware kernel` integrates scheduler, Ring 3 userspace, syscall setup, and driver initialization into one bootable source. The generated boot path now calls both `init_userspace(GDT_BASE)` and `init_hardware_drivers()` before application processors are started.

The current stage supplies standards-correct data structures, queue state machines, register initialization, and a linkable kernel. Full device discovery, MSI-X interrupt routing, DMA isolation through an IOMMU, and hardware-vendor-specific GPU acceleration remain later stages.
