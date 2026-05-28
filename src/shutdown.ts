import type { ChildProcess } from 'node:child_process'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import treeKill, { treeKillSync } from '@alloc/tree-kill'
import type { KillSignal } from './types.js'

export interface CleanupTarget {
  cleanupFromExit(): void
  cleanupFromSignal(signal: NodeJS.Signals): Promise<void>
}

export interface StopChildOptions {
  detached?: boolean
}

const liveTargets = new Set<CleanupTarget>()
let parentCleanupInstalled = false
let handlingSignal = false

export function registerCleanupTarget(target: CleanupTarget) {
  liveTargets.add(target)
  installParentCleanup()
}

export function unregisterCleanupTarget(target: CleanupTarget) {
  liveTargets.delete(target)
  if (liveTargets.size === 0) {
    uninstallParentCleanup()
  }
}

export function killTreeBestEffort(
  child: ChildProcess,
  signal?: KillSignal,
  options: StopChildOptions = {},
) {
  if (options.detached) {
    try {
      killProcessGroup(child, signal)
    } catch {}
  }

  try {
    treeKillSync(child, signal)
  } catch {}
}

export async function stopChildTree(
  child: ChildProcess,
  close: Promise<unknown>,
  isClosed: () => boolean,
  signal: KillSignal,
  killAfterMs: number,
  options: StopChildOptions = {},
) {
  if (options.detached) {
    killProcessGroup(child, signal)
  }

  try {
    await treeKill(child, signal)
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error
    }
  }

  const exitedGracefully = await Promise.race([
    close.then(() => true),
    delay(killAfterMs, false),
  ])

  if (!exitedGracefully && !isClosed()) {
    if (options.detached) {
      killProcessGroup(child, 'SIGKILL')
    }

    try {
      await treeKill(child, 'SIGKILL')
    } catch (error) {
      if (!isMissingProcessError(error)) {
        throw error
      }
    }

    await close
  }
}

function killProcessGroup(child: ChildProcess, signal?: KillSignal) {
  if (process.platform === 'win32' || !child.pid) {
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error
    }
  }
}

function installParentCleanup() {
  if (parentCleanupInstalled) {
    return
  }

  parentCleanupInstalled = true
  process.on('SIGINT', onParentSigint)
  process.on('SIGTERM', onParentSigterm)
  process.on('exit', onParentExit)
}

function uninstallParentCleanup() {
  if (!parentCleanupInstalled) {
    return
  }

  parentCleanupInstalled = false
  process.off('SIGINT', onParentSigint)
  process.off('SIGTERM', onParentSigterm)
  process.off('exit', onParentExit)
}

function onParentExit() {
  for (const target of [...liveTargets]) {
    target.cleanupFromExit()
  }
}

function onParentSigint() {
  onParentSignal('SIGINT')
}

function onParentSigterm() {
  onParentSignal('SIGTERM')
}

function onParentSignal(signal: NodeJS.Signals) {
  if (handlingSignal) {
    return
  }

  handlingSignal = true
  const handler = signal === 'SIGINT' ? onParentSigint : onParentSigterm
  const pending = [...liveTargets].map(target => target.cleanupFromSignal(signal))

  void Promise.allSettled(pending).finally(() => {
    handlingSignal = false
    process.off(signal, handler)

    if (process.listenerCount(signal) === 0) {
      process.kill(process.pid, signal)
      return
    }

    process.on(signal, handler)
  })
}

function isMissingProcessError(error: unknown) {
  return (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    error.code === 'ESRCH'
  )
}
