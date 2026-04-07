import { PassThrough } from 'node:stream'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import ansiStyles from 'ansi-styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { supervise, type ProcbandProcess } from '../src/index.js'

const stderrColor = [239, 68, 68] as const
const activeProcesses = new Set<ProcbandProcess>()

let stdoutText = ''
let stderrText = ''

describe('supervise', () => {
  beforeEach(() => {
    stdoutText = ''
    stderrText = ''

    vi.spyOn(process.stdout, 'write').mockImplementation(
      ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), cb?: () => void) => {
        stdoutText += decodeWriteChunk(chunk, encoding)
        if (typeof encoding === 'function') {
          encoding()
        } else {
          cb?.()
        }
        return true
      }) as typeof process.stdout.write,
    )

    vi.spyOn(process.stderr, 'write').mockImplementation(
      ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), cb?: () => void) => {
        stderrText += decodeWriteChunk(chunk, encoding)
        if (typeof encoding === 'function') {
          encoding()
        } else {
          cb?.()
        }
        return true
      }) as typeof process.stderr.write,
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()

    const pending = [...activeProcesses]
    activeProcesses.clear()

    await Promise.allSettled(
      pending.map(async proc => {
        try {
          await proc.stop({ killAfterMs: 200 })
        } catch {}
        try {
          await proc.wait()
        } catch {}
      }),
    )
  })

  it('matches output, awaits exit, and tees raw stderr output', async () => {
    const stderrSink = new PassThrough()
    let rawStderr = ''
    stderrSink.setEncoding('utf8')
    stderrSink.on('data', chunk => {
      rawStderr += chunk
    })

    const proc = track(
      supervise({
        name: 'basic',
        color: [1, 2, 3],
        command: process.execPath,
        args: [
          '-e',
          [
            'console.log("ready")',
            'console.error("warn")',
          ].join(';'),
        ],
        stderr: stderrSink,
      }),
    )

    const matches: string[] = []
    const unsubscribe = proc.match('ready', event => {
      matches.push(`${event.stream}:${event.line}`)
    })
    const warn = proc.waitFor('warn', { stream: 'stderr' })

    const result = await proc
    unsubscribe()
    unsubscribe()

    expect(result).toEqual({
      name: 'basic',
      code: 0,
      signal: null,
      restarts: 0,
      restartSuppressed: false,
    })
    expect(matches).toEqual(['stdout:ready'])
    await expect(warn).resolves.toMatchObject({
      process: 'basic',
      stream: 'stderr',
      line: 'warn',
      match: null,
    })
    expect(rawStderr).toBe('warn\n')
    expect(stdoutText).toContain(ansiStyles.color.ansi16m(1, 2, 3))
    expect(stderrText).toContain(ansiStyles.color.ansi16m(...stderrColor))
    expect(stripAnsi(stdoutText)).toContain('[basic] ready\n')
    expect(stripAnsi(stderrText)).toContain('[basic] warn\n')
  })

  it('restarts on failure until success and reports restart count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'procband-restart-'))
    const counterFile = join(dir, 'attempt.txt')

    const script = [
      'const fs = await import("node:fs")',
      'const file = process.argv[1]',
      'let attempt = 0',
      'try { attempt = Number(fs.readFileSync(file, "utf8")) } catch {}',
      'attempt += 1',
      'fs.writeFileSync(file, String(attempt))',
      'console.log(`attempt ${attempt}`)',
      'if (attempt < 3) process.exit(1)',
      'console.log("ready")',
    ].join(';')

    const proc = track(
      supervise({
        name: 'restart',
        command: process.execPath,
        args: ['-e', script, counterFile],
        restart: {
          delayMs: 20,
          maxFailures: 5,
          windowMs: 1000,
        },
      }),
    )

    const attempts: string[] = []
    proc.match(/^attempt \d+$/, event => {
      attempts.push(event.line)
    })

    await expect(proc.waitFor('ready')).resolves.toMatchObject({
      process: 'restart',
      stream: 'stdout',
      line: 'ready',
    })

    await expect(proc.wait()).resolves.toEqual({
      name: 'restart',
      code: 0,
      signal: null,
      restarts: 2,
      restartSuppressed: false,
    })

    expect(attempts).toEqual(['attempt 1', 'attempt 2', 'attempt 3'])
    await expect(readFile(counterFile, 'utf8')).resolves.toBe('3')
  })

  it('stops the spawned process tree', async () => {
    const script = [
      'const { spawn } = await import("node:child_process")',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      'console.log(`descendant:${child.pid}`)',
      'setInterval(() => {}, 1000)',
    ].join(';')

    const proc = track(
      supervise({
        name: 'tree',
        command: process.execPath,
        args: ['-e', script],
      }),
    )

    const descendant = await proc.waitFor(/descendant:(\d+)/)
    const pid = Number(descendant.match?.[1])
    expect(Number.isInteger(pid)).toBe(true)
    expect(isAlive(pid)).toBe(true)

    await proc.stop({ killAfterMs: 200 })
    const result = await proc.wait()

    expect(result.name).toBe('tree')
    await waitForExit(pid)
  })
})

function track(proc: ProcbandProcess) {
  activeProcesses.add(proc)
  proc.wait().finally(() => {
    activeProcesses.delete(proc)
  })
  return proc
}

function decodeWriteChunk(
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | (() => void),
) {
  if (typeof chunk === 'string') {
    return chunk
  }

  return Buffer.from(chunk).toString(
    typeof encoding === 'string' ? encoding : 'utf8',
  )
}

function stripAnsi(value: string) {
  return value.replace(/\u001B\[[0-9;]*m/g, '')
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error != null &&
      'code' in error &&
      error.code === 'ESRCH'
    ) {
      return false
    }
    throw error
  }
}

async function waitForExit(pid: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for pid ${pid} to exit`)
}
