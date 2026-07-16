import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createPrefixStream } from '../src/index.js'

describe('createPrefixStream', () => {
  it('prefixes complete and partial lines across arbitrary chunk boundaries', async () => {
    const stream = createPrefixStream({ label: 'db', color: [1, 2, 3] })
    const output = collect(stream)
    const utf8 = Buffer.from('one\r\ntw😀o\n\nlast')

    stream.write(utf8.subarray(0, 8))
    stream.write(utf8.subarray(8, 11))
    stream.end(utf8.subarray(11))

    expect(stripAnsi(await output)).toBe('[db] one\n[db] tw😀o\n[db] \n[db] last')
  })

  it('emits nothing for empty input', async () => {
    const stream = createPrefixStream({ label: 'empty', color: [1, 2, 3] })
    const output = collect(stream)

    stream.end()

    await expect(output).resolves.toBe('')
  })

  it('uses the shared palette when no color is provided', async () => {
    const first = createPrefixStream({ label: 'first' })
    const second = createPrefixStream({ label: 'second' })
    const firstOutput = collect(first)
    const secondOutput = collect(second)

    first.end('line\n')
    second.end('line\n')

    expect(await firstOutput).not.toBe(await secondOutput)
  })

  it('validates explicit colors', () => {
    expect(() => createPrefixStream({ label: 'db', color: [256, 0, 0] })).toThrow(
      'PrefixStreamOptions.color must contain integer RGB values between 0 and 255',
    )
    expect(() => createPrefixStream({ label: 'db', color: [239, 68, 68] })).toThrow(
      'PrefixStreamOptions.color cannot use the reserved stderr color',
    )
  })
})

async function collect(stream: NodeJS.ReadableStream) {
  let output = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    output += chunk
  })
  await once(stream, 'end')
  return output
}

function stripAnsi(value: string) {
  return value.replaceAll(/\u001B\[[0-9;]*m/g, '')
}
