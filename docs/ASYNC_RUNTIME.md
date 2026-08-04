# Async runtime and structured concurrency

Kura's async layer has two parts:

1. an AST state-machine planner that assigns a resumable state to every `await` point and emits a native polling ABI plan;
2. a host runtime with executors, cancellation, channels and synchronization primitives.

Included runtime objects:

- `KuraExecutor` with bounded concurrency and task lifecycle events;
- `CancellationToken` and linked cancellation;
- `TaskGroup` structured concurrency;
- bounded or unbounded `AsyncChannel`;
- cancellation-safe `AsyncMutex` and `AsyncSemaphore`;
- cancellable sleep and timeout helpers;
- native future layout and poll-function generation.

```bash
kr-async manifest examples/language/async-complete.kr --json
kr-async native-plan examples/language/async-complete.kr
kr-async smoke
```

Every native async function receives a future structure containing state, status, cancellation state, waker pointer and live locals. Await locations become explicit polling states rather than native stack suspension.
