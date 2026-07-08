import { execFileSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile } from 'node:fs/promises'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessExitError, supervise, type ProcbandProcess } from '../src/index.js'

const activeProcesses = new Set<ProcbandProcess>()

let stdoutText = ''
let stderrText = ''
let initialProcessExitCode: typeof process.exitCode

describe('supervise', () => {
  beforeEach(() => {
    stdoutText = ''
    stderrText = ''
    initialProcessExitCode = process.exitCode
    process.exitCode = undefined

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
          proc.kill()
        } catch {}
        try {
          await proc.wait()
        } catch {}
      }),
    )

    process.exitCode = initialProcessExitCode
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
      exitCode: 0,
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
    expect(rawStderr).toMatchInlineSnapshot(`
      "warn
      "
    `)
    expect(stdoutText).toMatchInlineSnapshot(`
      "[38;2;1;2;3m[basic][39m ready
      "
    `)
    expect(stderrText).toMatchInlineSnapshot(`
      "[38;2;239;68;68m[basic][39m warn
      "
    `)
    expect(stripAnsi(stdoutText)).toMatchInlineSnapshot(`
      "[basic] ready
      "
    `)
    expect(stripAnsi(stderrText)).toMatchInlineSnapshot(`
      "[basic] warn
      "
    `)
  })

  it('falls back to a name derived from command', async () => {
    const expectedName = process.execPath.match(/[-\w]+$/)?.[0]
    expect(expectedName).toBeTruthy()

    const proc = track(
      supervise({
        command: process.execPath,
        args: ['-e', 'console.log("ready")'],
      }),
    )

    await expect(proc.waitFor('ready')).resolves.toMatchObject({
      process: expectedName,
      stream: 'stdout',
      line: 'ready',
    })

    await expect(proc.wait()).resolves.toEqual({
      name: expectedName,
      code: 0,
      exitCode: 0,
      signal: null,
      restarts: 0,
      restartSuppressed: false,
    })

    expect(
      stripAnsi(stdoutText).replace(`[${expectedName}]`, '[<command>]'),
    ).toMatchInlineSnapshot(`
      "[<command>] ready
      "
    `)
  })

  it('expectSuccess resolves successful exits', async () => {
    const proc = track(
      supervise({
        name: 'expected-success',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      }),
    )

    await expect(proc.expectSuccess()).resolves.toMatchObject({
      name: 'expected-success',
      exitCode: 0,
    })
  })

  it('rejects failed exits with ProcessExitError when requested', async () => {
    const config = {
      name: 'expected-failure',
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
    }
    const proc = supervise(config)

    let error: unknown
    try {
      await proc.wait({ rejectOnFailure: true })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ProcessExitError)
    const exitError = error as ProcessExitError
    expect(normalizeExecPath(exitError.message)).toMatchInlineSnapshot(
      `"Process "expected-failure" failed: <node> -e "process.exit(7)" exited with code 7"`,
    )
    expect(exitError.config).toBe(config)
    expect(exitError.command).toBe(process.execPath)
    expect(exitError.args).toEqual(['-e', 'process.exit(7)'])
    expect(exitError.code).toBe(7)
    expect(exitError.exitCode).toBe(7)
    expect(exitError.signal).toBeNull()
    expect(exitError.result).toEqual({
      name: 'expected-failure',
      code: 7,
      exitCode: 7,
      signal: null,
      restarts: 0,
      restartSuppressed: false,
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('rejects signal exits when success is expected', async () => {
    if (process.platform === 'win32') {
      return
    }

    const proc = supervise({
      name: 'expected-signal',
      command: process.execPath,
      args: ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
    })

    await proc.waitFor('ready')
    expect(proc.kill('SIGTERM')).toBe(true)

    let error: unknown
    try {
      await proc.expectSuccess()
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ProcessExitError)
    const exitError = error as ProcessExitError
    expect(normalizeExecPath(exitError.message)).toMatchInlineSnapshot(
      `"Process "expected-signal" failed: <node> -e "console.log(\\"ready\\"); setInterval(() => {}, 1000)" exited by signal SIGTERM (exit code 143)"`,
    )
    expect(exitError.code).toBeNull()
    expect(exitError.signal).toBe('SIGTERM')
    expect(exitError.exitCode).toBe(128 + constants.signals.SIGTERM)
    expect(exitError.result).toMatchObject({
      name: 'expected-signal',
      code: null,
      signal: 'SIGTERM',
    })
  })

  it('disables stdin by default', async () => {
    const proc = track(
      supervise({
        name: 'stdin-default',
        command: process.execPath,
        args: [
          '-e',
          [
            'process.stdin.setEncoding("utf8")',
            'let text = ""',
            'process.stdin.on("data", chunk => { text += chunk })',
            'process.stdin.on("end", () => console.log(`stdin:${JSON.stringify(text)}`))',
            'process.stdin.resume()',
          ].join(';'),
        ],
      }),
    )

    expect(proc.stdin).toBeNull()

    await expect(
      proc.waitFor('stdin:""', { timeoutMs: 1000 }),
    ).resolves.toMatchObject({
      process: 'stdin-default',
      stream: 'stdout',
      line: 'stdin:""',
    })

    await expect(proc.wait()).resolves.toMatchObject({
      name: 'stdin-default',
      exitCode: 0,
    })
  })

  it('exposes writable stdin when stdin is true', async () => {
    const proc = track(
      supervise({
        name: 'stdin-manual',
        command: process.execPath,
        args: [
          '-e',
          [
            'process.stdin.setEncoding("utf8")',
            'let text = ""',
            'process.stdin.on("data", chunk => { text += chunk })',
            'process.stdin.on("end", () => console.log(`stdin:${JSON.stringify(text)}`))',
            'process.stdin.resume()',
          ].join(';'),
        ],
        stdin: true,
      }),
    )

    expect(proc.stdin).not.toBeNull()
    proc.stdin?.end('hello from parent\n')

    await expect(
      proc.waitFor('stdin:"hello from parent\\n"', { timeoutMs: 1000 }),
    ).resolves.toMatchObject({
      process: 'stdin-manual',
      stream: 'stdout',
      line: 'stdin:"hello from parent\\n"',
    })

    await expect(proc.wait()).resolves.toMatchObject({
      name: 'stdin-manual',
      exitCode: 0,
    })
  })

  it('pipes a custom readable into child stdin', async () => {
    const stdin = new PassThrough()
    const proc = track(
      supervise({
        name: 'stdin-stream',
        command: process.execPath,
        args: [
          '-e',
          [
            'process.stdin.setEncoding("utf8")',
            'let text = ""',
            'process.stdin.on("data", chunk => { text += chunk })',
            'process.stdin.on("end", () => console.log(`stdin:${JSON.stringify(text)}`))',
            'process.stdin.resume()',
          ].join(';'),
        ],
        stdin,
      }),
    )

    stdin.end('hello from stream\n')

    await expect(
      proc.waitFor('stdin:"hello from stream\\n"', { timeoutMs: 1000 }),
    ).resolves.toMatchObject({
      process: 'stdin-stream',
      stream: 'stdout',
      line: 'stdin:"hello from stream\\n"',
    })

    await expect(proc.wait()).resolves.toMatchObject({
      name: 'stdin-stream',
      exitCode: 0,
    })
  })

  it('logs when a process exits before an ignored waitFor match is observed', async () => {
    const proc = track(
      supervise({
        name: 'missing-match',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      }),
    )

    proc.waitFor('ready')

    await expect(proc.wait()).resolves.toMatchObject({
      name: 'missing-match',
      exitCode: 0,
    })
    expect(stripAnsi(stderrText)).toMatchInlineSnapshot(`
      "[missing-match] Process "missing-match" exited before a matching line was observed
      "
    `)
  })

  it('still rejects awaited waitFor calls when the process exits first', async () => {
    const proc = track(
      supervise({
        name: 'awaited-missing-match',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      }),
    )

    await expect(proc.waitFor('ready')).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Process "awaited-missing-match" exited before a matching line was observed]`,
    )
    await expect(proc.wait()).resolves.toMatchObject({
      name: 'awaited-missing-match',
      exitCode: 0,
    })
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
      exitCode: 0,
      signal: null,
      restarts: 2,
      restartSuppressed: false,
    })

    expect(attempts).toEqual(['attempt 1', 'attempt 2', 'attempt 3'])
    await expect(readFile(counterFile, 'utf8')).resolves.toBe('3')
  })

  it('passes detached through to spawn', async () => {
    if (process.platform === 'win32') {
      return
    }

    const proc = track(
      supervise({
        name: 'detached',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        detached: true,
      }),
    )

    expect(proc.pid).toBeTruthy()
    expect(getProcessGroupId(proc.pid!)).toBe(proc.pid)

    expect(proc.kill()).toBe(true)
    await expect(proc.wait()).resolves.toMatchObject({
      name: 'detached',
    })
  })

  it('preserves kill(0) as an existence check', async () => {
    const proc = track(
      supervise({
        name: 'kill-zero',
        command: process.execPath,
        args: [
          '-e',
          [
            'setTimeout(() => console.log("still-running"), 75)',
            'setInterval(() => {}, 1000)',
          ].join(';'),
        ],
      }),
    )

    expect(proc.kill(0)).toBe(true)

    await expect(
      proc.waitFor('still-running', { timeoutMs: 1000 }),
    ).resolves.toMatchObject({
      process: 'kill-zero',
      stream: 'stdout',
      line: 'still-running',
    })

    expect(proc.kill()).toBe(true)
    await expect(proc.wait()).resolves.toMatchObject({
      ...expectedTerminationResult('kill-zero'),
      restarts: 0,
    })
  })

  it('kill() stops the spawned process tree', async () => {
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

    expect(proc.kill()).toBe(true)
    const result = await proc.wait()

    expect(result.name).toBe('tree')
    expect(result).toMatchObject(expectedTerminationResult('tree'))
    await waitForExit(pid)
  })

  it('kill() stops same-process-group descendants of detached children', async () => {
    if (process.platform === 'win32') {
      return
    }

    const sleeperScript = [
      'process.title = "procband-detached-regression-sleeper"',
      'setInterval(() => {}, 1000)',
    ].join(';')
    const spawnerScript = [
      'const { spawn } = await import("node:child_process")',
      `const sleeper = spawn(process.execPath, ["-e", ${JSON.stringify(sleeperScript)}], { stdio: "ignore" })`,
      'console.log(`sleeper:${sleeper.pid}`)',
      'sleeper.unref()',
    ].join(';')
    const rootScript = [
      'const { spawn } = await import("node:child_process")',
      `const spawner = spawn(process.execPath, ["-e", ${JSON.stringify(spawnerScript)}], { stdio: ["ignore", "pipe", "ignore"] })`,
      'spawner.stdout.setEncoding("utf8")',
      'spawner.stdout.on("data", chunk => process.stdout.write(chunk))',
      'spawner.on("close", () => console.log(`ready:${process.pid}`))',
      'setInterval(() => {}, 1000)',
    ].join(';')

    const proc = track(
      supervise({
        name: 'detached-tree',
        command: process.execPath,
        args: ['-e', rootScript],
        detached: true,
      }),
    )

    const sleeper = await proc.waitFor(/sleeper:(\d+)/)
    const sleeperPid = Number(sleeper.match?.[1])
    expect(Number.isInteger(sleeperPid)).toBe(true)
    await proc.waitFor(/ready:(\d+)/)

    expect(isAlive(sleeperPid)).toBe(true)
    expect(getProcessGroupId(sleeperPid)).toBe(proc.pid)

    expect(proc.kill()).toBe(true)
    await expect(proc.wait()).resolves.toMatchObject({
      name: 'detached-tree',
      signal: 'SIGTERM',
    })
    await waitForExit(sleeperPid)
  })

  it('stops live processes on parent SIGTERM', async () => {
    const script = [
      'const { spawn } = await import("node:child_process")',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      'console.log(`descendant:${child.pid}`)',
      'setInterval(() => {}, 1000)',
    ].join(';')

    const initialSigtermListeners = process.listeners('SIGTERM')
    const proc = track(
      supervise({
        name: 'term',
        command: process.execPath,
        args: ['-e', script],
      }),
    )

    expect(process.listeners('SIGTERM')).toHaveLength(
      initialSigtermListeners.length + 1,
    )

    const descendant = await proc.waitFor(/descendant:(\d+)/)
    const pid = Number(descendant.match?.[1])
    expect(Number.isInteger(pid)).toBe(true)
    expect(isAlive(pid)).toBe(true)

    await (
      proc as ProcbandProcess & {
        cleanupFromSignal(signal: NodeJS.Signals): Promise<void>
      }
    ).cleanupFromSignal('SIGTERM')

    const result = await proc.wait()
    expect(result).toMatchObject(expectedTerminationResult('term'))
    expect(process.listeners('SIGTERM')).toHaveLength(
      initialSigtermListeners.length,
    )

    await waitForExit(pid)
  })

  it('uses parentExitSignal for parent signal cleanup', async () => {
    const proc = track(
      supervise({
        name: 'parent-signal-override',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        parentExitSignal: 'SIGHUP',
      }),
    )

    await (
      proc as ProcbandProcess & {
        cleanupFromSignal(signal: NodeJS.Signals): Promise<void>
      }
    ).cleanupFromSignal('SIGTERM')

    await expect(proc.wait()).resolves.toMatchObject(
      expectedTerminationResult('parent-signal-override', 'SIGHUP'),
    )
  })

  it('uses parentExitSignal for parent exit cleanup', async () => {
    const proc = track(
      supervise({
        name: 'parent-exit-override',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        parentExitSignal: 'SIGHUP',
      }),
    )

    ;(
      proc as ProcbandProcess & {
        cleanupFromExit(): void
      }
    ).cleanupFromExit()

    await expect(proc.wait()).resolves.toMatchObject(
      expectedTerminationResult('parent-exit-override', 'SIGHUP'),
    )
  })

  it('propagates the first unobserved failure to the parent exit code', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      return undefined as never
    }) as typeof process.exit)

    const failing = supervise({
      name: 'fail',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(7), 20)'],
    })

    const sibling = supervise({
      name: 'peer',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })

    const siblingResult = await sibling.wait()

    expect(process.exitCode).toBe(7)
    expect(failing.exitCode).toBe(7)
    expect(siblingResult).toMatchObject(expectedTerminationResult('peer'))

    await new Promise(resolve => setImmediate(resolve))
    expect(exit).toHaveBeenCalledWith(7)
  })

  it('does not propagate failures for observed processes', async () => {
    const failing = supervise({
      name: 'observed',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(3), 20)'],
    })

    const sibling = supervise({
      name: 'peer',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })

    activeProcesses.add(sibling)

    try {
      await expect(failing.wait()).resolves.toMatchObject({
        name: 'observed',
        exitCode: 3,
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      expect(process.exitCode).toBeUndefined()
      expect(sibling.exitCode).toBeNull()
    } finally {
      try {
        sibling.kill()
      } catch {}
      await sibling.wait().catch(() => {})
      activeProcesses.delete(sibling)
    }
  })

  it('treats awaiting the process itself as observation', async () => {
    const failing = supervise({
      name: 'awaited',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(5), 20)'],
    })

    const sibling = supervise({
      name: 'peer',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })

    activeProcesses.add(sibling)

    try {
      await expect(failing).resolves.toMatchObject({
        name: 'awaited',
        exitCode: 5,
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      expect(process.exitCode).toBeUndefined()
      expect(sibling.exitCode).toBeNull()
    } finally {
      try {
        sibling.kill()
      } catch {}
      await sibling.wait().catch(() => {})
      activeProcesses.delete(sibling)
    }
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

function normalizeExecPath(value: string) {
  return value
    .replaceAll(JSON.stringify(process.execPath), '<node>')
    .replaceAll(process.execPath, '<node>')
}

function expectedTerminationResult(name: string, signal: NodeJS.Signals = 'SIGTERM') {
  if (process.platform === 'win32') {
    return {
      name,
      code: 1,
      exitCode: 1,
      signal: null,
    }
  }

  return {
    name,
    code: null,
    exitCode: 128 + constants.signals[signal as keyof typeof constants.signals],
    signal,
  }
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

function getProcessGroupId(pid: number) {
  return Number.parseInt(
    execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim(),
    10,
  )
}
