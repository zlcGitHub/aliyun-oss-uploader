import { readFileSync } from 'node:fs'

const { name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

if (name === '@npm-account/oss-uploader') {
  console.error('发布前请将 package.json 的占位包名改为你有发布权限的 npm 包名，详见 docs/releasing.md。')
  process.exit(1)
}
