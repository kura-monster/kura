# Kura Kernel Scheduler

Kura's x86_64 kernel stack now includes synchronization, per-CPU state, calibrated timers, slab caches, kernel threads, and real cooperative context switching.

## Generate a scheduled kernel

```bash
kr-scheduler init my-os
cd my-os
kr-scheduler build kernel.kr --out-dir build/system
```

For a generated smoke kernel:

```bash
kr-scheduler smoke --cpus 4 --memory 256 --out-dir build/smoke
```

## Synchronization

The native compiler exposes sequentially consistent atomic operations:

```kr
unsafe {
    let old: u32 = atomic.compare_exchange<u32>(address, expected, desired)
    let ticket: u32 = atomic.fetch_add<u32>(address, 1)
    let value: u32 = atomic.load<u32>(address)
    atomic.store<u32>(address, value)
    atomic.fence()
}
```

The generated runtime builds fair ticket spinlocks on top of these operations. `spin_lock_irqsave` disables local interrupts before waiting and restores the previous interrupt state after unlock, preventing same-CPU interrupt deadlocks.

## Per-CPU state

Each discovered processor receives a 128-byte record containing:

- current task identifier
- preemption-disable depth
- pending-reschedule flag
- scheduler ticks
- context-switch count
- APIC identifier
- online state

The current CPU is resolved through the local APIC ID and the MADT-derived CPU table.

## Timer stack

The scheduler searches ACPI for the HPET table and validates its checksum. When HPET and the local APIC are available, HPET calibrates the local APIC timer and the timer is placed in periodic mode.

The PIT is configured as a fallback when HPET or local-APIC timer calibration is unavailable.

The timer interrupt decreases the active task's quantum and raises a per-CPU reschedule request. Context switching occurs at safe handoff points such as `scheduler_poll`, `scheduler_yield`, `thread_sleep`, and `thread_block`.

This stage intentionally avoids switching stacks directly from an x86 interrupt frame. Hard interrupt-return preemption will be added with the user-mode and full trap-frame layer.

## Kernel threads

```kr
unsafe {
    let task: u32 = spawn_kernel_thread(
        function.address(worker),
        1,
        0x8000,
    )

    thread_sleep(10)
    thread_wake(task)
    scheduler_yield()
}
```

New thread stacks are prepared for the x86_64 context-switch assembly. The switch routine preserves `rbp`, `rbx`, and `r12` through `r15`, saves the old stack pointer, loads the selected task's stack, and returns into `thread_bootstrap` for first execution.

Threads may be ready, running, blocked, sleeping, or dead. Sleeping threads are reactivated from scheduler ticks.

## Scheduler policy

The scheduler has four priority levels. Lower numeric values have higher priority. Tasks at the same priority are selected with round-robin cursors and receive a configurable tick quantum.

```bash
kr-scheduler emit --timer-hz 250 --quantum 8 -o kernel.kr
```

The task table currently contains 2,048 fixed task records, while stacks and dynamic kernel objects come from the kernel heap.

## Slab allocator

Seven slab classes cover objects from 32 through 2,048 bytes. Each class owns a ticket lock and a free-object chain. New slab pages are obtained from the physical-frame allocator and are directly accessible through the platform identity map.

```kr
unsafe {
    let object: usize = slab_alloc(128)
    slab_free(object, 128)
}
```

Larger allocations fall back to the coalescing kernel heap. Slab pages are retained by their cache in this stage; whole-page reclamation is planned for the memory-pressure layer.

## Build outputs

A scheduler build links three native objects:

```text
kernel.o
kura-bootstrap.o
kura-context-switch.o
```

The resulting ELF contains:

```text
kura_boot_entry
kernel_main
kura_ap_main
kura_context_switch
```

## JavaScript API

```js
import {
  createKernelSchedulerManifest,
  createKernelSchedulerSource,
  createContextSwitchAssembly,
  buildSchedulerKernel,
  parseAcpiHpet,
  TicketSpinLockModel,
  SlabAllocatorModel,
  PriorityRoundRobinSchedulerModel,
} from '@kura-lang/compiler/system/kernel-scheduler';
```

## Next layer

The next scheduler stage will add full trap-frame preemption, per-CPU run queues, work stealing, RCU-style deferred reclamation, user address spaces, syscall entry and exit, and ELF process loading.
