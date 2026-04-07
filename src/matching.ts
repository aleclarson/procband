import type {
  MatchCallback,
  MatchEvent,
  MatchOptions,
  MatchPattern,
  MatchStream,
  Unsubscribe,
  WaitForOptions,
} from './types.js'

type MatchSubscription =
  | {
      active: boolean
      kind: 'callback'
      pattern: MatchPattern
      stream: MatchStream
      onMatch: MatchCallback
    }
  | {
      active: boolean
      kind: 'promise'
      pattern: MatchPattern
      stream: MatchStream
      resolve: (event: MatchEvent) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout | null
    }

export class MatchRegistry {
  private readonly subscriptions = new Set<MatchSubscription>()
  private closedError: Error | null = null
  private readonly processName: string

  constructor(processName: string) {
    this.processName = processName
  }

  match(
    pattern: MatchPattern,
    onMatch: MatchCallback,
    options?: MatchOptions,
  ): Unsubscribe {
    if (this.closedError) {
      return () => {}
    }

    const subscription: MatchSubscription = {
      active: true,
      kind: 'callback',
      pattern,
      stream: options?.stream ?? 'both',
      onMatch,
    }

    this.subscriptions.add(subscription)

    return () => {
      this.unsubscribe(subscription)
    }
  }

  waitFor(
    pattern: MatchPattern,
    options?: WaitForOptions,
  ): Promise<MatchEvent> {
    if (this.closedError) {
      return Promise.reject(this.closedError)
    }

    return new Promise<MatchEvent>((resolve, reject) => {
      const subscription: MatchSubscription = {
        active: true,
        kind: 'promise',
        pattern,
        stream: options?.stream ?? 'both',
        resolve: event => {
          this.unsubscribe(subscription)
          resolve(event)
        },
        reject: error => {
          this.unsubscribe(subscription)
          reject(error)
        },
        timer: null,
      }

      if (options?.timeoutMs != null) {
        subscription.timer = setTimeout(() => {
          subscription.reject(
            new Error(
              `Timed out waiting for a match from process "${this.processName}"`,
            ),
          )
        }, options.timeoutMs)
      }

      this.subscriptions.add(subscription)
    })
  }

  emit(stream: 'stdout' | 'stderr', line: string) {
    if (this.closedError) {
      return
    }

    const baseEvent = createMatchEvent(this.processName, stream, line)

    for (const subscription of [...this.subscriptions]) {
      if (!subscription.active || !matchesStream(subscription.stream, stream)) {
        continue
      }

      const match = matchPattern(subscription.pattern, line)
      if (!match.matched) {
        continue
      }

      const event: MatchEvent = {
        ...baseEvent,
        match: match.value,
      }

      if (subscription.kind === 'callback') {
        try {
          subscription.onMatch(event)
        } catch {
          this.unsubscribe(subscription)
        }
        continue
      }

      subscription.resolve(event)
    }
  }

  close(error: Error) {
    if (this.closedError) {
      return
    }

    this.closedError = error

    for (const subscription of [...this.subscriptions]) {
      if (subscription.kind === 'promise') {
        subscription.reject(error)
      } else {
        this.unsubscribe(subscription)
      }
    }
  }

  private unsubscribe(subscription: MatchSubscription) {
    if (!subscription.active) {
      return
    }

    subscription.active = false
    if (subscription.kind === 'promise' && subscription.timer) {
      clearTimeout(subscription.timer)
      subscription.timer = null
    }
    this.subscriptions.delete(subscription)
  }
}

function createMatchEvent(
  processName: string,
  stream: 'stdout' | 'stderr',
  line: string,
): MatchEvent {
  return {
    process: processName,
    stream,
    line,
    match: null,
    timestamp: Date.now(),
  }
}

function matchesStream(expected: MatchStream, actual: 'stdout' | 'stderr') {
  return expected === 'both' || expected === actual
}

function matchPattern(
  pattern: MatchPattern,
  line: string,
): { matched: boolean; value: RegExpExecArray | null } {
  if (typeof pattern === 'string') {
    return { matched: line.includes(pattern), value: null }
  }

  pattern.lastIndex = 0
  const match = pattern.exec(line)
  return { matched: match != null, value: match }
}
