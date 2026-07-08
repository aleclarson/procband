# procband

> Supervise subprocesses from TypeScript when a script needs prefixed output,
> readiness matching, restart policy, and process-tree shutdown without becoming
> a standalone process manager.

`procband` wraps one child process per `supervise()` call. It starts the child
immediately, prefixes `stdout` and `stderr`, lets your script wait for future
log lines, and resolves to a final `ProcessResult` when no more restart attempt
will run.

## Install

```sh
pnpm add procband
```

## First Process

Use `waitFor()` when the next step depends on output that the child will print
after supervision starts:

```ts
import process from 'node:process'
import { supervise } from 'procband'

const proc = supervise({
  name: 'worker',
  command: process.execPath,
  args: ['-e', 'console.log("ready")'],
})

const ready = await proc.waitFor('ready')
console.log(`matched ${ready.line}`)

const result = await proc
console.log(result.exitCode)
```

The child output is written to the parent process with a `worker` prefix, the
readiness wait resolves when a future line contains `ready`, and `await proc`
returns the terminal result.

## Choose the Failure Behavior

By default, a failed terminal exit resolves to `ProcessResult`. Use this when a
supervisor script needs to inspect the outcome:

```ts
import process from 'node:process'
import { supervise } from 'procband'

const result = await supervise({
  name: 'job',
  command: process.execPath,
  args: ['-e', 'process.exit(1)'],
})

if (result.exitCode !== 0) {
  console.error(`job failed with ${result.exitCode}`)
}
```

Use `expectSuccess()` for foreground command-runner steps where a failed exit
should reject:

```ts
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

If your script never awaits the process or calls `wait()`, an unobserved failed
terminal exit sets the parent `process.exitCode` and starts stopping other live
`procband` processes in the same parent script.

## Documentation

Start with the page that matches the decision in front of you:

| Page                                                      | Use it when                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| [Docs overview](docs/index.md)                            | You need the moving parts, boundaries, and next page to read.    |
| [Readiness and matching](docs/guides/readiness.md)        | A script must wait for output or react to repeated log lines.    |
| [Restart failed processes](docs/guides/restarts.md)       | A child can fail transiently and should be retried with limits.  |
| [Foreground commands](docs/guides/foreground-commands.md) | A script step should reject when a command exits unsuccessfully. |
| [Concepts and lifecycle](docs/context.md)                 | You need lifecycle, shutdown, error, and invariant details.      |

Runnable examples live in [`examples/`](examples/). Exact public signatures are
generated from the TypeScript source and published through
[`dist/index.d.mts`](dist/index.d.mts).
