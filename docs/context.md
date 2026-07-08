# Concepts and Lifecycle

> `procband` supervises one child process at a time; this page defines the
> wrapper lifecycle, restart boundary, shutdown behavior, and failure model that
> guide pages rely on.

## Core Model

Each `supervise(config)` call creates one supervised process. The returned
`ProcbandProcess` is both:

| Surface              | What it represents                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Child-process handle | The current active child attempt. Inherited fields such as `pid`, `stdin`, `stdout`, and `stderr` update across restarts. |
| Matching surface     | Future output lines observed by `match()` and `waitFor()`.                                                                |
| Shutdown surface     | `kill()` disables future restarts and stops the current child process tree.                                               |
| Thenable result      | `await proc` is equivalent to `await proc.wait()` and resolves to the terminal `ProcessResult`.                           |

```ts
import process from 'node:process'
import { supervise } from 'procband'

const proc = supervise({
  name: 'api',
  command: process.execPath,
  args: ['-e', 'console.log("ready")'],
})

await proc.waitFor('ready')
const result = await proc
```

After the readiness line is observed, `result` is available only when the
process is terminal and no restart delay or attempt remains.

## Lifecycle

1. `supervise(config)` validates the config and spawns the first child
   immediately.
2. Child `stdout` and `stderr` are decoded as UTF-8 text and split into lines.
3. Each line is written to the parent `process.stdout` or `process.stderr` with
   a process prefix unless `ProcessConfig.prefix` is `false`. `stderr` prefixes
   always use the reserved red color.
4. If `ProcessConfig.stderr` is provided, raw child `stderr` bytes are also
   written to that sink.
5. Matching subscribers receive future lines through `match()` callbacks or
   `waitFor()` promises.
6. When the child exits, `procband` either finalizes or schedules another child
   attempt according to the restart policy.
7. `await proc`, `await proc.wait()`, and `await proc.expectSuccess()` settle
   only after the supervised process is terminal.

Use this shape when one process must become ready before another starts:

```ts
import process from 'node:process'
import { supervise } from 'procband'

const api = supervise({
  name: 'api',
  command: process.execPath,
  args: ['-e', 'setTimeout(() => console.log("ready"), 20)'],
})

await api.waitFor('ready')

supervise({
  name: 'worker',
  command: process.execPath,
  args: ['-e', 'console.log("watching")'],
})
```

The worker starts after the API prints a future line containing `ready`.

## Matching

Matching is line-based and future-only. A subscription sees lines emitted after
the subscription is registered; it does not replay earlier output.

| Pattern  | Behavior                                                                     |
| -------- | ---------------------------------------------------------------------------- |
| String   | Matches when the observed line includes the string.                          |
| `RegExp` | Runs against the full observed line. `lastIndex` is reset before each match. |

Use `waitFor()` for one required line:

```ts
const event = await proc.waitFor(/^ready$/, {
  stream: 'stdout',
  timeoutMs: 5000,
})

console.log(event.process, event.line)
```

Use `match()` for repeated lines:

```ts
const unsubscribe = proc.match(
  /^attempt \d+$/,
  (event) => {
    console.log(`observed ${event.line}`)
  },
  { stream: 'stdout' },
)

unsubscribe()
```

`waitFor()` rejects when its timeout elapses or the process becomes terminal
before a matching future line appears. If a `match()` callback throws, only that
subscription is removed.

## Restarts

`restart: true` uses the built-in policy:

| Field         | Default        | Meaning                                                  |
| ------------- | -------------- | -------------------------------------------------------- |
| `when`        | `'on-failure'` | Restart only non-zero exits or signal exits.             |
| `delayMs`     | `1000`         | Wait this long before the next attempt.                  |
| `maxFailures` | `3`            | Suppress restart after more than this many failed exits. |
| `windowMs`    | `30000`        | Count failed exits inside this rolling window.           |

Pass an explicit policy when the defaults are too slow or too permissive:

```ts
const proc = supervise({
  name: 'job',
  command: process.execPath,
  args: ['-e', 'process.exit(1)'],
  restart: {
    delayMs: 25,
    maxFailures: 5,
    windowMs: 1000,
  },
})

const result = await proc
console.log(result.restarts, result.restartSuppressed)
```

If the child keeps failing inside the configured window, `restartSuppressed`
becomes `true` and the final failed result is returned.

## Shutdown

Use `proc.kill()` for deliberate shutdown from your own script:

```ts
const stopped = proc.kill('SIGTERM')
```

`kill()` disables future restarts and stops the active child process tree. For
`detached: true` children on Unix-like platforms, shutdown also signals the
detached child process group so same-group descendants are cleaned up even when
they are no longer reachable by parent PID.

> [!NOTE]
> `kill(0)` keeps the normal Node.js existence-check behavior. It does not stop
> supervision or disable restarts.

Parent cleanup installs `SIGINT` and `SIGTERM` handlers while live supervised
processes exist. Set `parentExitSignal` only when children require a specific
signal during parent-driven cleanup:

```ts
supervise({
  name: 'server',
  command: process.execPath,
  args: ['server.mjs'],
  parentExitSignal: 'SIGHUP',
})
```

`parentExitSignal` does not change the signal used by explicit `proc.kill()`
calls.

## Failure Model

`procband` separates terminal process failure from promise rejection:

| API                                    | Failed terminal exit                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `await proc`                           | Resolves to `ProcessResult`.                                                        |
| `proc.wait()`                          | Resolves to `ProcessResult`.                                                        |
| `proc.wait({ rejectOnFailure: true })` | Rejects with `ProcessExitError`.                                                    |
| `proc.expectSuccess()`                 | Rejects with `ProcessExitError`.                                                    |
| Unobserved process                     | Sets parent `process.exitCode` and starts stopping other live supervised processes. |

`ProcessExitError` includes the original config, final result, command, args,
exit code, and signal:

```ts
import { ProcessExitError } from 'procband'

try {
  await proc.expectSuccess()
} catch (error) {
  if (error instanceof ProcessExitError) {
    console.error(error.command, error.exitCode, error.signal)
  }
  throw error
}
```

## Configuration Boundaries

| Field      | Boundary                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `command`  | Required shell-free executable or command name passed to `spawn()`.                                              |
| `name`     | Optional stable process identifier. Defaults to the trailing `/[-\w]+$/` match from `command`.                   |
| `label`    | Optional human-facing output prefix. Defaults to `name`.                                                         |
| `prefix`   | Defaults to `true`. Set to `false` to write output and diagnostics without the process label prefix.             |
| `stdin`    | Defaults to disconnected. Use `true` for writable `proc.stdin`, or pass a readable stream to pipe automatically. |
| `stderr`   | Optional extra sink for raw child `stderr`; prefixed parent `stderr` output still happens.                       |
| `detached` | Passed through to `spawn()` and used during shutdown on Unix-like platforms.                                     |
| `color`    | Optional RGB prefix color for `stdout`; reserved `stderr` red cannot be used.                                    |

Invalid config, such as a missing `command`, a command without an inferable
fallback `name`, or a reserved color, throws synchronously from `supervise()`.

## Terminology

| Term                | Meaning                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Supervised process  | A `ProcbandProcess` wrapper plus its current child attempt.                                       |
| Child attempt       | One concrete spawned process instance inside a supervision run.                                   |
| Terminal            | No child is running and no restart will be started.                                               |
| Restart suppression | Automatic disabling of further restarts after too many failed exits inside the configured window. |
| Match               | A future observed output line that satisfies a string or regex pattern.                           |

## Non-Goals

- A standalone CLI
- Historical log replay
- Multi-process orchestration in one top-level API
- Shell command parsing
- Service-management features such as persistence, cron scheduling, or host
  restarts
