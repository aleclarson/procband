# Readiness and Matching

> Use future line matching when a parent script must wait for a child process to
> announce readiness or react to repeated output without buffering log history.

Matching starts when you call `waitFor()` or `match()`. Earlier output is not
replayed, so create the supervised process and register the wait before the line
you need can be missed.

## Wait for One Line

Use `waitFor()` when the next step cannot start until the child prints a known
line:

```ts
import process from 'node:process'
import { supervise } from 'procband'

const api = supervise({
  name: 'api',
  command: process.execPath,
  args: [
    '-e',
    [
      'console.log("booting")',
      'setTimeout(() => console.log("ready"), 20)',
      'setInterval(() => {}, 1000)',
    ].join(';'),
  ],
})

const event = await api.waitFor('ready', {
  stream: 'stdout',
  timeoutMs: 5000,
})

console.log(`api is ${event.line}`)
```

The wait resolves with the first future `stdout` line that contains `ready`.
When `timeoutMs` elapses first, or the process exits before a matching line is
observed, the wait rejects.

## Match Repeated Lines

Use `match()` when the child may print the same kind of line many times:

```ts
const unsubscribe = api.match(
  /^warn:/,
  (event) => {
    console.log(`observed ${event.stream}: ${event.line}`)
  },
  { stream: 'stderr' },
)

// Later, when this script no longer needs warning callbacks:
unsubscribe()
```

Each subscription is independent. If one callback throws, that subscription is
removed and other subscriptions keep running.

## Choose a Pattern

| Pattern     | Best for                             | Result detail                                      |
| ----------- | ------------------------------------ | -------------------------------------------------- |
| `'ready'`   | Simple substring checks.             | `event.match` is `null`.                           |
| `/^ready$/` | Exact line shape or captured values. | `event.match` contains the `RegExp.exec()` result. |

```ts
const event = await api.waitFor(/^listening on (\d+)$/)
const port = Number(event.match?.[1])
```

The regular expression runs against the full observed line without the trailing
newline.

## Start Another Process After Readiness

This pattern keeps sequencing explicit: wait for the first process, then start
the dependent process.

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

After the API prints `ready`, the worker starts and its output is prefixed
separately.
