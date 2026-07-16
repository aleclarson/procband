import { StringDecoder } from 'node:string_decoder'
import { Transform } from 'node:stream'
import { formatPrefixedLine, resolveProcessColor, validateProcessColor } from './colors.js'
import type { PrefixStreamOptions, RgbColor } from './types.js'

/**
 * Create a transform that prefixes arbitrary output with a procband label.
 *
 * The transform buffers incomplete lines and UTF-8 sequences across chunks.
 * CRLF input is normalized to LF, matching supervised process output, and a
 * final unterminated line is emitted when the writable side ends.
 *
 * @param options Label and optional prefix color.
 * @returns A backpressure-aware Node.js transform stream.
 * @throws When `options.color` is invalid or uses procband's reserved stderr
 * color.
 * @example
 * ```ts
 * import { createPrefixStream } from 'procband'
 *
 * const output = createPrefixStream({ label: 'postgres' })
 * output.pipe(process.stdout)
 * postgres.stdout.pipe(output)
 * ```
 */
export function createPrefixStream(options: PrefixStreamOptions): Transform {
  validateProcessColor(options.color, 'PrefixStreamOptions.color')
  return new PrefixTransform(options.label, resolveProcessColor(options.color))
}

class PrefixTransform extends Transform {
  private readonly decoder = new StringDecoder('utf8')
  private readonly label: string
  private readonly color: RgbColor
  private bufferedText = ''

  constructor(label: string, color: RgbColor) {
    super()
    this.label = label
    this.color = color
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.consume(this.decoder.write(chunk))
    callback()
  }

  override _flush(callback: (error?: Error | null) => void) {
    this.consume(this.decoder.end())
    if (this.bufferedText.length > 0) {
      this.push(formatPrefixedLine(this.label, this.color, this.bufferedText, false))
      this.bufferedText = ''
    }
    callback()
  }

  private consume(decodedText: string) {
    let text = this.bufferedText + decodedText
    let newlineIndex = text.indexOf('\n')

    while (newlineIndex >= 0) {
      const rawLine = text.slice(0, newlineIndex)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      this.push(formatPrefixedLine(this.label, this.color, line, true))
      text = text.slice(newlineIndex + 1)
      newlineIndex = text.indexOf('\n')
    }

    this.bufferedText = text
  }
}
