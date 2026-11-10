import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'oss-uploader-package-'))

const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

try {
  run('pnpm', ['build'])
  // 构建已完成，避免 pack 的生命周期日志混入 JSON 输出。
  const [packed] = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryDirectory]),
  )
  const packedFiles = packed.files.map(({ path }) => path)
  for (const required of ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts', 'README.md', 'LICENSE', 'package.json']) {
    assert.ok(packedFiles.includes(required), `Missing package file: ${required}`)
  }
  assert.ok(packedFiles.every((path) => path.startsWith('dist/') || ['README.md', 'LICENSE', 'package.json'].includes(path)), 'Unexpected file in npm package')
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, 'Core must have no runtime dependencies')

  writeFileSync(join(temporaryDirectory, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(temporaryDirectory, packed.filename)], temporaryDirectory)

  for (const [extension, load] of [
    ['mjs', `await import(${JSON.stringify(manifest.name)})`],
    ['cjs', `require(${JSON.stringify(manifest.name)})`],
  ]) {
    const consumer = `
const assert = ${extension === 'mjs' ? "(await import('node:assert/strict')).default" : "require('node:assert/strict')"};
const BrowserFile = globalThis.File;
delete globalThis.File;
const { createUploader } = ${load};
globalThis.File = BrowserFile;
(async () => {
  let resultCalls = 0;
  globalThis.fetch = async (host, options) => {
    assert.equal(host, 'https://bucket.example.com');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body.get('key'), 'uploads/photo.png');
    assert.equal(options.body.get('file').name, 'photo.png');
    return { ok: true, status: 204 };
  };
  const upload = createUploader({
    getSignature: async () => ({ id: 'file-001' }),
    getUploadTarget: () => ({ host: 'https://bucket.example.com', formData: { key: 'uploads/photo.png' } }),
    getResult: async ({ id }) => { resultCalls++; return { id }; },
  });
  assert.deepEqual(await upload(new File(['image'], 'photo.png')), { id: 'file-001' });
  assert.equal(resultCalls, 1);
  globalThis.fetch = async () => ({ ok: true, status: 203 });
  await assert.rejects(upload(new File(['image'], 'photo.png')), /HTTP 203/);
  assert.equal(resultCalls, 1);
})().catch((error) => { console.error(error); process.exitCode = 1; });
`
    const consumerPath = join(temporaryDirectory, `consumer.${extension}`)
    writeFileSync(consumerPath, consumer)
    run(process.execPath, [consumerPath], temporaryDirectory)
  }

  const typeConsumer = `
import { createUploader } from ${JSON.stringify(manifest.name)}
import type { TUploadTarget, TUploaderOptions } from ${JSON.stringify(manifest.name)}
type TSignature = { id: string }
type TResult = { location: string }
const target: TUploadTarget = { host: 'https://bucket.example.com', formData: {} }
const options: TUploaderOptions<TSignature, TResult> = {
  getSignature: async (file) => ({ id: file.name }),
  getUploadTarget: (signature) => ({ ...target, formData: { key: signature.id } }),
  getResult: async (signature) => ({ location: signature.id }),
}
const upload = createUploader(options)
const result: Promise<TResult> = upload(new File(['image'], 'photo.png'))
// @ts-expect-error 上传入参必须是 File，不能是文件名。
upload('photo.png')
// @ts-expect-error 自定义结果类型不能被推断成任意类型。
const invalidResult: Promise<{ wrong: number }> = result
`
  for (const extension of ['mts', 'cts']) {
    writeFileSync(join(temporaryDirectory, `consumer.${extension}`), typeConsumer)
  }
  const tsc = join(root, 'node_modules/typescript/bin/tsc')
  run(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', 'consumer.mts', 'consumer.cts'], temporaryDirectory)
  console.log(`Package verified: ${manifest.name}@${manifest.version}; ESM, CommonJS, types, upload behavior and file allowlist passed.`)
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
