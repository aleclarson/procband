# Documentation Overview

> Choose the right `procband` behavior before reaching for an API: readiness
> matching, failure observation, restart policy, and shutdown each change how a
> script should supervise its child process.

`procband` is for TypeScript scripts that need to run child processes with a
small amount of supervision. It is not a daemon, service manager, CLI runner, or
multi-process orchestrator.

## What It Adds

Each `supervise()` call wraps one child process and adds five behaviors on top
of Node.js `spawn()`:

| Behavior                       | Use it when                                                                |
| ------------------------------ | -------------------------------------------------------------------------- |
| Optional prefixed output       | Multiple child processes write to the same parent terminal.                |
| Future line matching           | The parent script must wait for a readiness line or react to logs.         |
| Optional restarts              | A transient failure should start another child attempt.                    |
| Process-tree shutdown          | Deliberate cleanup should stop descendants as well as the direct child.    |
| Unobserved failure propagation | A background failure should fail the parent script when nobody awaited it. |

```ts
import process from 'node:process'
import { supervise } from 'procband'

const proc = supervise({
  name: 'api',
  command: process.execPath,
  args: ['-e', 'console.log("ready")'],
})

await proc.waitFor('ready')
```

After `supervise()` runs, the child has already started and future output can be
matched.

## First Decisions

| Decision         | Default                                       | Change it when                                                             |
| ---------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| Process identity | `name` is inferred from `command`.            | The command path does not end in `/[-\w]+$/`, or logs need a stable label. |
| Output prefix    | Child output is labeled.                      | Pass `prefix: false` when the child should write raw output.               |
| Failure handling | Awaiting resolves to `ProcessResult`.         | Use `expectSuccess()` for command-runner steps that should reject.         |
| Matching scope   | `waitFor()` and `match()` watch both streams. | Pass `{ stream: 'stdout' }` or `{ stream: 'stderr' }` to narrow matching.  |
| Restart behavior | No restart.                                   | Pass `restart: true` or a policy for transient child failures.             |
| Stdin            | Disconnected.                                 | Pass `stdin: true` or a readable stream when the child needs input.        |

## Where to Go Next

| Page                                                 | Reader job                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| [Readiness and matching](guides/readiness.md)        | Wait for future output or subscribe to repeated matching lines.     |
| [Restart failed processes](guides/restarts.md)       | Configure retries with a failure-suppression guard.                 |
| [Foreground commands](guides/foreground-commands.md) | Make a supervised command reject on failed exit.                    |
| [Concepts and lifecycle](context.md)                 | Understand terminal state, shutdown, config boundaries, and errors. |

Runnable scripts in [`../examples/`](../examples/) cover the same workflows with
project-realistic child processes that can be checked by `pnpm docs:check`.
