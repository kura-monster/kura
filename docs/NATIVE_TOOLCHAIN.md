# Native Toolchain

Run the environment check first:

```bash
kr-system toolchain
```

## Required for ELF builds

One object generator:

- `llc`
- `clang`

One linker:

- `ld.lld`
- GNU `ld`

## Optional

- `qemu-system-x86_64` for virtual-machine execution
- `grub-mkrescue` for bootable ISO generation
- `llvm-objcopy` or `objcopy` for future binary-image stages

## Dry-run build planning

```bash
kr-system build kernel.kr --out-dir build/system --dry-run --json
```

This prints the exact tool commands and output paths without executing external tools.

## Generated files

A normal build produces:

```text
build/system/kernel.ll
build/system/kernel.o
build/system/kura-linker.ld
build/system/kernel.elf
```

An ISO build also produces:

```text
build/system/iso-root/
build/system/kernel.iso
```
