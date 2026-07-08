# Foreground Commands

> Use `expectSuccess()` when a supervised child process represents a script step
> that must succeed before the parent script can continue.

`procband` normally resolves failed exits to `ProcessResult` because background
supervision often needs to inspect failures instead of throwing immediately.
Foreground command-runner steps usually want the opposite behavior.

## Reject Failed Exits

Use `expectSuccess()` when a non-zero exit or signal exit should reject:

```ts
import process from 'node:process'
import { ProcessExitError, supervise } from 'procband'

try {
  await supervise({
    name: 'db',
    command: 'pnpm',
    args: ['db', 'ensure'],
  }).expectSuccess()
} catch (error) {
  if (error instanceof ProcessExitError) {
    console.error(error.command, error.args, error.exitCode)
  }
  throw error
}
```

When the command exits successfully, the promise resolves to `ProcessResult`.
When it fails, `ProcessExitError` exposes the command, args, exit code, signal,
original config, and terminal result.

## Use `wait()` When the Choice Is Dynamic

`expectSuccess()` is equivalent to `wait({ rejectOnFailure: true })`. Use
`wait()` when a caller decides the behavior:

```ts
import process from 'node:process'
import { supervise } from 'procband'

const proc = supervise({
  name: 'check',
  command: process.execPath,
  args: ['-e', 'process.exit(1)'],
})

const result = await proc.wait({ rejectOnFailure: shouldThrow })
```

If `shouldThrow` is `false`, the failed exit resolves to `ProcessResult`. If it
is `true`, the same exit rejects with `ProcessExitError`.

## Let Background Failures Propagate

For background processes that should fail the parent script when nobody handles
their result, leave the process unobserved:

```ts
import process from 'node:process'
import { supervise } from 'procband'

supervise({
  name: 'worker',
  command: process.execPath,
  args: ['-e', 'setTimeout(() => process.exit(1), 60)'],
})
```

If this process reaches a failed terminal state and no code has awaited it or
called `wait()`, `procband` sets the parent `process.exitCode` and starts
stopping other live `procband` processes in the same parent script.

> [!IMPORTANT]
> Awaiting `proc` or calling `proc.wait()` marks the terminal result as
> observed. Once observed, default parent-exit propagation is suppressed for
> that process.
