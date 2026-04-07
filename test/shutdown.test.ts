import { beforeEach, describe, expect, it, vi } from 'vitest'

const treeKill = vi.fn(async () => {})
const treeKillSync = vi.fn()

vi.mock('@alloc/tree-kill', () => ({
  default: treeKill,
  treeKillSync,
}))

describe('killTreeBestEffort', () => {
  beforeEach(() => {
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
})
