import { createUploader } from '../src/index'
import type { TUploadTarget } from '../src/index'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createFile = () => new File(['image'], 'photo.png', { type: 'image/png' })
let fetchMock = vi.fn()
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.useRealTimers())

const setup = (
  target: TUploadTarget = { host: 'https://bucket.example.com', formData: { key: 'photo.png' } },
) => {
  const signature = { upload: target, context: 'project-specific-context' }
  const getSignature = vi.fn().mockResolvedValue(signature)
  const getUploadTarget = vi.fn(() => target)
  const getResult = vi.fn().mockResolvedValue({ location: 'https://cdn.example.com/photo.png' })
  const upload = createUploader({ getSignature, getUploadTarget, getResult })
  return { upload, signature, getSignature, getUploadTarget, getResult }
}

describe('通用 OSS 表单上传', () => {
  it('接受项目自定义签名和结果结构，不要求顶层 key、凭证、有效期和大小限制', async () => {
    const { upload, signature, getSignature, getUploadTarget, getResult } = setup()
    const file = createFile()
    await expect(upload(file)).resolves.toEqual({ location: 'https://cdn.example.com/photo.png' })
    expect(getSignature).toHaveBeenCalledWith(file, { signal: undefined })
    expect(getUploadTarget).toHaveBeenCalledWith(signature)
    expect(getResult).toHaveBeenCalledExactlyOnceWith(signature, { signal: undefined })
    const [host, config] = fetchMock.mock.calls[0]
    expect(host).toBe('https://bucket.example.com')
    expect(config).toMatchObject({ method: 'POST', credentials: 'omit' })
    expect(config.headers).toBeUndefined()
    expect(config.signal).toBeInstanceOf(AbortSignal)
    const body = config.body as FormData
    expect(body.get('key')).toBe('photo.png')
    const postedFile = body.get('file') as File
    expect(postedFile.name).toBe(file.name)
    expect(postedFile.type).toBe(file.type)
    expect(await postedFile.text()).toBe(await file.text())
  })

  it('保留签名字段，用真实文件覆盖已有 file 字段并最后追加', async () => {
    const target = {
      host: 'https://bucket.example.com',
      formData: { key: 'photo.png', file: 'placeholder', policy: 'signed-policy' },
    }
    await setup(target).upload(createFile())
    const body = fetchMock.mock.calls[0][1].body as FormData
    const entries: [string, FormDataEntryValue][] = []
    body.forEach((value, key) => entries.push([key, value]))
    expect(entries.slice(0, -1)).toEqual([
      ['key', 'photo.png'],
      ['policy', 'signed-policy'],
    ])
    expect(entries.at(-1)?.[0]).toBe('file')
    expect(body.getAll('file')).toHaveLength(1)
    expect(target.formData.file).toBe('placeholder')
  })

  it('没有可选约束时也接受不含 key 的签名字段，将协议验证交给 OSS', async () => {
    await setup({
      host: 'https://bucket.example.com',
      formData: { policy: 'signed-policy' },
    }).upload(createFile())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { expiration: Date.now() - 1000 },
    { expiration: Number.NaN },
    { maxFileSize: 1 },
    { maxFileSize: 0 },
    { maxFileSize: Number.POSITIVE_INFINITY },
  ])('已提供的可选约束 %j 不满足时阻止传输', async (constraints) => {
    const { upload, getResult } = setup({
      host: 'https://bucket.example.com',
      formData: {},
      ...constraints,
    })
    await expect(upload(createFile())).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getResult).not.toHaveBeenCalled()
  })

  it('有效期和大小限制合法时允许等于大小上限的文件', async () => {
    const file = createFile()
    await setup({
      host: 'https://bucket.example.com',
      formData: {},
      expiration: Date.now() + 60000,
      maxFileSize: file.size,
    }).upload(file)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { host: '', formData: {} },
    { host: '   ', formData: {} },
    { host: 'https://bucket.example.com', formData: null },
    { host: 'https://bucket.example.com', formData: [] },
  ])('上传目标缺少必要结构时不发起传输：%j', async (target) => {
    const { upload } = setup(target as unknown as TUploadTarget)
    await expect(upload(createFile())).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('空文件不申请签名', async () => {
    const { upload, getSignature } = setup()
    await expect(upload(new File([], 'empty.png'))).rejects.toThrow()
    expect(getSignature).not.toHaveBeenCalled()
  })

  it.each([null, 'photo.png', new Blob(['image'])])('非 File 输入不申请签名：%s', async (input) => {
    const { upload, getSignature } = setup()
    await expect(upload(input as unknown as File)).rejects.toThrow(
      'Upload file is empty or invalid',
    )
    expect(getSignature).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('上传超时后直接失败，不查询结果或重新上传', async () => {
    vi.useFakeTimers()
    let started!: () => void
    const uploadStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    fetchMock.mockImplementation(() => {
      started()
      return new Promise(() => {})
    })
    const { upload, getResult } = setup()
    const task = upload(createFile())
    const rejected = expect(task).rejects.toMatchObject({ code: 'TIMEOUT', stage: 'upload' })
    await uploadStarted
    await vi.advanceTimersByTimeAsync(599999)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getResult).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('并发上传的签名和结果保持各自关联，允许后发请求先完成', async () => {
    let finishFirst: (signature: { key: string }) => void = () => {
      throw new Error('First signature has not been requested')
    }
    const getResult = vi.fn(async ({ key }: { key: string }) => ({ key }))
    const upload = createUploader({
      getSignature: (file: File) =>
        file.name === 'first.png'
          ? new Promise<{ key: string }>((resolve) => {
              finishFirst = resolve
            })
          : Promise.resolve({ key: file.name }),
      getUploadTarget: ({ key }) => ({ host: 'https://bucket.example.com', formData: { key } }),
      getResult,
    })
    const first = upload(new File(['first'], 'first.png'))
    await expect(upload(new File(['second'], 'second.png'))).resolves.toEqual({ key: 'second.png' })
    finishFirst({ key: 'first.png' })
    await expect(first).resolves.toEqual({ key: 'first.png' })
    expect(getResult.mock.calls.map(([signature]) => signature.key)).toEqual([
      'second.png',
      'first.png',
    ])
    expect(
      fetchMock.mock.calls.map(([, options]) => (options.body as FormData).get('key')),
    ).toEqual(['second.png', 'first.png'])
  })

  it('签名申请失败时不上传和查询结果', async () => {
    const { upload, getSignature, getResult } = setup()
    getSignature.mockRejectedValue(new Error('Signature failed'))
    await expect(upload(createFile())).rejects.toThrow('Signature failed')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getResult).not.toHaveBeenCalled()
  })

  it.each([203, 403, 500])('OSS 返回 HTTP %s 时不查询结果、不重新上传', async (status) => {
    fetchMock.mockResolvedValue({ ok: status < 300, status })
    const { upload, getResult } = setup()
    await expect(upload(createFile())).rejects.toThrow(`HTTP ${status}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getResult).not.toHaveBeenCalled()
  })

  it('OSS 网络错误保留原始消息且不查询结果', async () => {
    fetchMock.mockRejectedValue(new Error('Network failed'))
    const { upload, getResult } = setup()
    await expect(upload(createFile())).rejects.toThrow('Network failed')
    expect(getResult).not.toHaveBeenCalled()
  })

  it('结果查询失败时不重试和重复上传', async () => {
    const { upload, getSignature, getResult } = setup()
    getResult.mockRejectedValue(new Error('Result unavailable'))
    await expect(upload(createFile())).rejects.toThrow('Result unavailable')
    expect(getResult).toHaveBeenCalledTimes(1)
    expect(getSignature).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
