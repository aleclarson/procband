import type { ProcessConfig, ProcessResult } from './types.js'

/**
 * Error thrown when a process was expected to exit successfully but did not.
 */
export class ProcessExitError extends Error {
  readonly config: ProcessConfig
  readonly result: ProcessResult
  readonly command: string
  readonly args: readonly string[]
  readonly code: number | null
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null

  constructor(config: ProcessConfig, result: ProcessResult) {
    super(formatProcessExitMessage(config, result))

    this.name = 'ProcessExitError'
    this.config = config
    this.result = result
    this.command = config.command
    this.args = [...(config.args ?? [])]
    this.code = result.code
    this.exitCode = result.exitCode
    this.signal = result.signal
  }
}

function formatProcessExitMessage(config: ProcessConfig, result: ProcessResult) {
  const command = formatCommand(config)
  const prefix = `Process "${result.name}" failed: ${command}`

  if (result.signal) {
    return `${prefix} exited by signal ${result.signal} (exit code ${result.exitCode})`
  }

  if (result.code != null) {
    return `${prefix} exited with code ${result.code}`
  }

  return `${prefix} exited unsuccessfully (exit code ${result.exitCode})`
}

function formatCommand(config: ProcessConfig) {
  return [config.command, ...(config.args ?? [])].map(formatCommandPart).join(' ')
}

function formatCommandPart(value: string) {
  if (/^[\w./:=@%+,-]+$/.test(value)) {
    return value
  }

  return JSON.stringify(value)
}
