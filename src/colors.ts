import type { Writable } from 'node:stream'
import ansiStyles from 'ansi-styles'
import type { RgbColor } from './types.js'

const prefixPalette = [
  [99, 102, 241],
  [14, 165, 233],
  [6, 182, 212],
  [16, 185, 129],
  [132, 204, 22],
  [245, 158, 11],
  [249, 115, 22],
  [236, 72, 153],
  [168, 85, 247],
  [139, 92, 246],
] as const satisfies readonly RgbColor[]

export const stderrColor = [239, 68, 68] as const satisfies RgbColor

let nextPaletteIndex = 0

export function resolveProcessColor(color?: RgbColor): RgbColor {
  if (color) {
    return [...color] as RgbColor
  }

  const paletteColor = prefixPalette[nextPaletteIndex % prefixPalette.length]
  nextPaletteIndex += 1
  return [...paletteColor] as RgbColor
}

export function validateProcessColor(color?: RgbColor) {
  if (!color) {
    return
  }

  const [red, green, blue] = color
  for (const value of [red, green, blue]) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(
        'ProcessConfig.color must contain integer RGB values between 0 and 255',
      )
    }
  }

  if (
    red === stderrColor[0] &&
    green === stderrColor[1] &&
    blue === stderrColor[2]
  ) {
    throw new Error('ProcessConfig.color cannot use the reserved stderr color')
  }
}

export function writePrefixedLine(
  target: Writable,
  label: string,
  color: RgbColor,
  line: string,
  appendNewline: boolean,
) {
  target.write(formatPrefix(label, color) + line + (appendNewline ? '\n' : ''))
}

export function formatPrefix(label: string, color: RgbColor) {
  return `${ansiStyles.color.ansi16m(...color)}[${label}]${ansiStyles.color.close} `
}
