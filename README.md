# procband

## Purpose

`procband` supervises subprocesses from TypeScript. It prefixes child output,
matches future log lines, waits for terminal exit, optionally restarts failed
processes, and tree-kills descendants during shutdown.

## Installation

```sh
pnpm add procband
```

## Quick Example

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
console.log(result)
```

## Documentation Map

- Concepts and lifecycle: [docs/context.md](docs/context.md)
- Minimal usage example: [examples/basic-usage.ts](examples/basic-usage.ts)
- Restart example: [examples/restart-on-failure.ts](examples/restart-on-failure.ts)
- Exact exported signatures: [dist/index.d.mts](dist/index.d.mts)
