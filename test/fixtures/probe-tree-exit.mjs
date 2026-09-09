import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const marker = process.argv[2]
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
})
writeFileSync(marker, String(child.pid))
process.exit(0)
