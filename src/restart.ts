import type { RestartPolicy, Signals } from './types.js'

export type NormalizedRestartPolicy = Required<RestartPolicy> | null

const defaultRestartPolicy = Object.freeze({
  when: 'on-failure',
  delayMs: 1000,
  maxFailures: 3,
  windowMs: 30_000,
} as const satisfies Required<RestartPolicy>)

export class RestartController {
  readonly policy: NormalizedRestartPolicy
  restarts = 0
  restartSuppressed = false

  private restartFailures: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private cancelRestartDelay: (() => void) | null = null

  constructor(restart: boolean | RestartPolicy | undefined) {
    this.policy = normalizeRestartPolicy(restart)
  }

  shouldRestart(
    code: number | null,
    signal: Signals | null,
    restartDisabled: boolean,
    finalized: boolean,
  ): boolean {
    if (finalized || restartDisabled || !this.policy) {
      return false
    }

    if (this.policy.when === 'on-exit') {
      return true
    }

    return isFailedExit(code, signal)
  }

  prepareRestart(code: number | null, signal: Signals | null): boolean {
    if (!this.policy) {
      return false
    }

    if (isFailedExit(code, signal)) {
      const now = Date.now()
      this.restartFailures.push(now)
      this.restartFailures = this.restartFailures.filter(
        timestamp => now - timestamp <= this.policy!.windowMs,
      )

      if (this.restartFailures.length > this.policy.maxFailures) {
        this.restartSuppressed = true
        return false
      }
    }

    this.restarts += 1
    return true
  }

  waitForDelay(): Promise<boolean> {
    if (!this.policy || this.policy.delayMs <= 0) {
      return Promise.resolve(true)
    }

    return new Promise<boolean>(resolve => {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this.cancelRestartDelay = null
        resolve(true)
      }, this.policy!.delayMs)

      this.cancelRestartDelay = () => {
        if (this.restartTimer) {
          clearTimeout(this.restartTimer)
          this.restartTimer = null
        }
        this.cancelRestartDelay = null
        resolve(false)
      }
    })
  }

  cancelDelay() {
    this.cancelRestartDelay?.()
  }
}

function normalizeRestartPolicy(
  restart: boolean | RestartPolicy | undefined,
): NormalizedRestartPolicy {
  if (!restart) {
    return null
  }

  if (restart === true) {
    return { ...defaultRestartPolicy }
  }

  return {
    when: restart.when ?? defaultRestartPolicy.when,
    delayMs: restart.delayMs ?? defaultRestartPolicy.delayMs,
    maxFailures: restart.maxFailures ?? defaultRestartPolicy.maxFailures,
    windowMs: restart.windowMs ?? defaultRestartPolicy.windowMs,
  }
}

function isFailedExit(code: number | null, signal: Signals | null) {
  return signal != null || code !== 0
}
