import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

proc.match(/^attempt \d+$/, event => {
  console.log(`observed ${event.line}`)
})

await proc.waitFor('ready')
const result = await proc

console.log(result)
rmSync(stateDir, { recursive: true, force: true })
