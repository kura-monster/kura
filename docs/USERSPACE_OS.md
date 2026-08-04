# x86_64 userspace OS layer

The userspace layer extends the existing bootable scheduler kernel with Ring 3 execution and process services.

Implemented architecture support:

- user code/data GDT selectors and a 64-bit TSS;
- kernel syscall stack and `swapgs` entry path;
- `SYSCALL`/`SYSRET` MSR initialization;
- `iretq` userspace entry and CR3 address-space switch assembly;
- process records, PID allocation, process states, exit and reap;
- ELF64 validation and load-segment planning;
- canonical userspace range checks;
- file-descriptor syscall foundation;
- in-memory VFS with directories, files, open/read/write/seek/close;
- PCI configuration decoding and capability walking;
- VirtIO split-ring descriptor lifecycle;
- IPv4 packet encoding/validation, UDP datagrams and TCP connection states.

The generated kernel source is combined with the scheduler runtime and linked with four native objects: bootstrap, context switch, userspace entry assembly and Kura kernel code.

```bash
kr-userspace manifest
kr-userspace emit -o build/userspace.kr
kr-userspace kernel -o build/kernel-userspace.kr
kr-userspace assembly -o build/kura-userspace.S
kr-userspace build --out-dir build/userspace
```
