import { rm } from 'node:fs/promises'
import path from 'node:path'

const workspace = process.cwd()
const target = path.resolve(workspace, 'dist')
if (path.dirname(target) !== workspace || path.basename(target) !== 'dist') {
    throw new Error(`Refusing to clean unexpected output path: ${target}`)
}
await rm(target, { recursive: true, force: true })
