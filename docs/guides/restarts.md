# Restart Failed Processes

> Add a restart policy when a child process may fail transiently and the parent
> script should retry before treating the supervision run as terminal.

Restarts are disabled by default. Enable them per process with `restart: true`
or an explicit `RestartPolicy`.

## Use the Built-In Policy

Use `restart: true` when the defaults are acceptable:

```ts
import process from 'node:process'
import { supervise } from 'procband'

const proc = supervise({
  name: 'worker',
  command: process.execPath,
  args: ['-e', 'process.exit(1)'],
  restart: true,
})

const result = await proc
console.log(result.restarts, result.restartSuppressed)
```

The default policy restarts failed exits after `1000` milliseconds and suppresses
restart after more than `3` failed exits inside `30000` milliseconds.

## Set an Explicit Policy

Use an explicit policy when tests, examples, or short-lived scripts need faster
feedback:

```ts
import process from 'node:process'
import { supervise } from 'procband'

const proc = supervise({
  name: 'job',
  command: process.execPath,
  args: ['-e', 'process.exit(1)'],
  restart: {
    when: 'on-failure',
    delayMs: 25,
    maxFailures: 5,
    windowMs: 1000,
  },
})
```

With this policy, failed attempts are retried after `25` milliseconds. Once more
than `5` failures occur inside `1000` milliseconds, `procband` stops retrying
and resolves the terminal result with `restartSuppressed: true`.

## Wait for a Later Attempt

`waitFor()` watches future output across restart attempts, so it can wait for a
line that appears only after earlier attempts fail:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { supervise } from 'procband'

const stateDir = mkdtempSync(join(tmpdir(), 'procband-example-'))
const attemptFile = join(stateDir, 'attempt.txt')
writeFileSync(attemptFile, '0')

const script = [
  'const fs = await import("node:fs")',
  'const file = process.argv[1]',
  'let attempt = Number(fs.readFileSync(file, "utf8"))',
  'attempt += 1',
  'fs.writeFileSync(file, String(attempt))',
  'console.log(`attempt ${attempt}`)',
  'if (attempt < 3) process.exit(1)',
  'console.log("ready")',
].join(';')

const proc = supervise({
  name: 'job',
  command: process.execPath,
  args: ['-e', script, attemptFile],
  restart: {
    delayMs: 25,
    maxFailures: 5,
    windowMs: 1000,
  },
})

proc.match(/^attempt \d+$/, (event) => {
  console.log(`observed ${event.line}`)
})

await proc.waitFor('ready')
const result = await proc
```

The first two attempts can exit unsuccessfully, the third attempt can print
`ready`, and the final result includes the number of restart attempts that were
started.

## Pick `when` Deliberately

| `when`         | Restarts after                   | Use it when                                                                          |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `'on-failure'` | Non-zero exits and signal exits. | A clean exit means the work is done.                                                 |
| `'on-exit'`    | Any exit.                        | The child is expected to be long-lived and should be relaunched even after code `0`. |

`proc.kill()` disables future restarts before stopping the active process tree,
so deliberate shutdown does not start another attempt.
