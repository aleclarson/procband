import process from 'node:process'
import { supervise } from 'procband'

const proc = supervise({
  name: 'worker',
  command: process.execPath,
  args: [
    '-e',
    [
      'console.log("booting")',
      'setTimeout(() => console.log("ready"), 20)',
      'setTimeout(() => console.error("warn"), 40)',
      'setTimeout(() => process.exit(0), 60)',
    ].join(';'),
  ],
})

const unsubscribe = proc.match(
  'warn',
  event => {
    console.log(`observed ${event.stream}: ${event.line}`)
  },
  { stream: 'stderr' },
)

const ready = await proc.waitFor('ready')
console.log(`matched ${ready.line}`)

const result = await proc
unsubscribe()

console.log(result)
