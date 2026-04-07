import process from 'node:process'
import { supervise } from 'procband'

const api = supervise({
  name: 'api',
  command: process.execPath,
  args: [
    '-e',
    [
      'console.log("booting")',
      'setTimeout(() => console.log("ready"), 20)',
      'setInterval(() => {}, 1000)',
    ].join(';'),
  ],
})

await api.waitFor('ready')

supervise({
  name: 'worker',
  command: process.execPath,
  args: [
    '-e',
    [
      'console.log("watching")',
      'setTimeout(() => process.exit(1), 60)',
    ].join(';'),
  ],
})
