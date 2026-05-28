import process from 'node:process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const treeKill = vi.fn(async (_child?: unknown, _signal?: unknown) => {})
const treeKillSync = vi.fn((_child?: unknown, _signal?: unknown) => {})

vi.mock('@alloc/tree-kill', () => ({
  default: treeKill,
  treeKillSync,
}))

describe('killTreeBestEffort', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    treeKill.mockClear()
    treeKillSync.mockClear()
  })

  it('uses treeKillSync for exit-time cleanup', async () => {
    const { killTreeBestEffort } = await import('../src/shutdown.js')
    const child = {
      kill: vi.fn(() => true),
      pid: 123,
    }

    killTreeBestEffort(child as never, 'SIGTERM')

    expect(treeKillSync).toHaveBeenCalledWith(child, 'SIGTERM')
    expect(treeKill).not.toHaveBeenCalled()
  })

  it('signals detached Unix process groups before exit-time tree cleanup', async () => {
    if (process.platform === 'win32') {
      return
    }

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { killTreeBestEffort } = await import('../src/shutdown.js')
    const child = {
      kill: vi.fn(() => true),
      pid: 123,
    }

    killTreeBestEffort(child as never, 'SIGTERM', { detached: true })

    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM')
    expect(treeKillSync).toHaveBeenCalledWith(child, 'SIGTERM')
  })
})

describe('stopChildTree', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    treeKill.mockClear()
    treeKillSync.mockClear()
  })

  it('escalates detached Unix process groups after graceful timeout', async () => {
    if (process.platform === 'win32') {
      return
    }

    let closeChild!: () => void
    const close = new Promise<void>((resolve) => {
      closeChild = resolve
    })
    treeKill.mockImplementation(async (_child, signal) => {
      if (signal === 'SIGKILL') {
        closeChild()
      }
    })

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { stopChildTree } = await import('../src/shutdown.js')
    const child = {
      kill: vi.fn(() => true),
      pid: 123,
    }

    await stopChildTree(child as never, close, () => false, 'SIGTERM', 1, { detached: true })

    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-123, 'SIGKILL')
    expect(treeKill).toHaveBeenCalledWith(child, 'SIGTERM')
    expect(treeKill).toHaveBeenCalledWith(child, 'SIGKILL')
  })
})
