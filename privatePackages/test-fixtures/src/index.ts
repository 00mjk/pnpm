import { promisify } from 'util'
import fs = require('fs')
import path = require('path')
import ncpCB = require('ncp')

const ncp = promisify(ncpCB)

export async function copyFixture (fixtureName: string, dest: string) {
  const fixturePath = pathToLocalPkg(fixtureName)
  if (!fixturePath) throw new Error(`${fixtureName} not found`)
  return await ncp(fixturePath, dest)
}

export function pathToLocalPkg (pkgName: string) {
  let dir = __dirname
  const { root } = path.parse(dir)
  while (true) {
    const checkDir = path.join(dir, 'fixtures', pkgName)
    if (fs.existsSync(checkDir)) return checkDir
    if (dir === root) return null
    dir = path.dirname(dir)
  }
}
