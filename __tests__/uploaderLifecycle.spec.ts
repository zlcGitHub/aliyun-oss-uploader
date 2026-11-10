import { createUploader, UploadError } from '../src/index'
import type { TUploaderContext, TUploadTarget } from '../src/index'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createFile = (name = 'photo.png') => new File(['image'], name, { type: 'image/png' })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

let fetchMock = vi.fn()
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.useRealTimers())

const setup = (timeoutMs?: number) => {
  const signature = { id: 'file-001' }
  const getSignature = vi.fn(async (_file: File, _context: TUploaderContext) => signature)
  const getUploadTarget = vi.fn(
    ({ id }: typeof signature): TUploadTarget => ({
      host: 'https://bucket.example.com',
      formData: { key: id },
    }),
  )
  const getResult = vi.fn(
    async (signature: { id: string }, _context: TUploaderContext) => signature,
  )
  const upload = createUploader({ getSignature, getUploadTarget, getResult, timeoutMs })
  return { upload, signature, getSignature, getUploadTarget, getResult }
}

describe('上传超时与资源清理', () => {
  it.each([0, -1, 0.5, Number.NaN, Infinity, 2147483648])(
    '在创建工厂时拒绝无效超时 %s',
    (timeoutMs) => {
      expect(() => setup(timeoutMs)).toThrow(UploadError)
      try {
        setup(timeoutMs)
      } catch (error) {
        expect(error).toMatchObject({ code: 'INVALID_TIMEOUT', stage: 'validation' })
      }
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('使用自定义超时，即使传输未处理 signal 也能结束调用', async () => {
    vi.useFakeTimers()
    const started = deferred<void>()
    fetchMock.mockImplementation(() => {
      started.resolve()
      return new Promise(() => {})
    })
    const { upload, getResult } = setup(1000)
    const task = upload(createFile())
    const rejected = expect(task).rejects.toMatchObject({
      name: 'UploadError',
      code: 'TIMEOUT',
      stage: 'upload',
    })
    await started.promise
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(getResult).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('OSS 成功后清除超时，不影响接入方管理的结果查询', async () => {
    vi.useFakeTimers()
    const started = deferred<void>()
    const result = deferred<{ id: string }>()
    const { upload, signature, getResult } = setup(100)
    getResult.mockImplementation(() => {
      started.resolve()
      return result.promise
    })
    const task = upload(createFile())
    await started.promise
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)
    result.resolve(signature)
    await expect(task).resolves.toEqual(signature)
  })

  it.each([204, 403])('OSS 返回 HTTP %s 后清理计时器和外部取消监听', async (status) => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({ ok: status < 300, status })
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, 'addEventListener')
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const task = setup().upload(createFile(), { signal: controller.signal })
    if (status < 300) await task
    else await expect(task).rejects.toMatchObject({ status })
    expect(vi.getTimerCount()).toBe(0)
    for (const [type, callback] of added.mock.calls) {
      expect(removed).toHaveBeenCalledWith(type, callback)
    }
    controller.abort()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false)
  })

  it('不依赖 AbortSignal.timeout 或 AbortSignal.any', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      throw new Error('Unsupported')
    })
    const any = vi.spyOn(AbortSignal, 'any').mockImplementation(() => {
      throw new Error('Unsupported')
    })
    await expect(setup().upload(createFile())).resolves.toEqual({ id: 'file-001' })
    expect(timeout).not.toHaveBeenCalled()
    expect(any).not.toHaveBeenCalled()
  })
})

describe('上传取消', () => {
  it('提前取消时不申请签名，并保留取消原因', async () => {
    const controller = new AbortController()
    const reason = new Error('User cancelled')
    controller.abort(reason)
    const { upload, getSignature, getResult } = setup()
    await expect(upload(createFile(), { signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
      stage: 'signature',
      cause: reason,
    })
    expect(getSignature).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getResult).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)(
    '签名阶段取消后忽略迟到的 %s，停止后续上传',
    async (outcome) => {
      const controller = new AbortController()
      const pending = deferred<{ id: string }>()
      const { upload, signature, getSignature, getUploadTarget, getResult } = setup()
      getSignature.mockReturnValue(pending.promise)
      const file = createFile()
      const task = upload(file, { signal: controller.signal })
      expect(getSignature).toHaveBeenCalledWith(file, { signal: controller.signal })
      controller.abort()
      await expect(task).rejects.toMatchObject({ code: 'ABORTED', stage: 'signature' })
      if (outcome === 'resolve') pending.resolve(signature)
      else pending.reject(new Error('Late signature failure'))
      await Promise.resolve()
      expect(getUploadTarget).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(getResult).not.toHaveBeenCalled()
    },
  )

  it('映射目标时取消，不开始 OSS 上传', async () => {
    const controller = new AbortController()
    const { upload, getUploadTarget } = setup()
    getUploadTarget.mockImplementation(() => {
      controller.abort()
      return { host: 'https://bucket.example.com', formData: {} }
    })
    await expect(upload(createFile(), { signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
      stage: 'target',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('OSS 传输中取消后中止 signal、清理超时，并忽略迟到响应', async () => {
    vi.useFakeTimers()
    const started = deferred<void>()
    const pending = deferred<{ ok: boolean; status: number }>()
    fetchMock.mockImplementation(() => {
      started.resolve()
      return pending.promise
    })
    const controller = new AbortController()
    const reason = new Error('Dialog closed')
    const { upload, getResult } = setup()
    const task = upload(createFile(), { signal: controller.signal })
    await started.promise
    controller.abort(reason)
    await expect(task).rejects.toMatchObject({ code: 'ABORTED', stage: 'upload', cause: reason })
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve({ ok: true, status: 204 })
    await Promise.resolve()
    expect(getResult).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('结果查询阶段取消后忽略迟到的 %s', async (outcome) => {
    const controller = new AbortController()
    const started = deferred<void>()
    const pending = deferred<{ id: string }>()
    const { upload, signature, getResult } = setup()
    getResult.mockImplementation(() => {
      started.resolve()
      return pending.promise
    })
    const task = upload(createFile(), { signal: controller.signal })
    await started.promise
    expect(getResult).toHaveBeenCalledWith(signature, { signal: controller.signal })
    controller.abort()
    await expect(task).rejects.toMatchObject({ code: 'ABORTED', stage: 'result' })
    if (outcome === 'resolve') pending.resolve(signature)
    else pending.reject(new Error('Late query failure'))
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getResult).toHaveBeenCalledTimes(1)
  })

  it('取消一个并发上传不会中断另一个上传', async () => {
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    const firstResponse = deferred<{ ok: boolean; status: number }>()
    const secondResponse = deferred<{ ok: boolean; status: number }>()
    fetchMock.mockImplementation((_host, options: RequestInit) => {
      const body = options.body as FormData
      if (body.get('key') === 'first.png') {
        firstStarted.resolve()
        return firstResponse.promise
      }
      secondStarted.resolve()
      return secondResponse.promise
    })
    const { upload, getSignature, getResult } = setup()
    getSignature.mockImplementation(async (file) => ({ id: file.name }))
    const controller = new AbortController()
    const first = upload(createFile('first.png'), { signal: controller.signal })
    const second = upload(createFile('second.png'))
    await Promise.all([firstStarted.promise, secondStarted.promise])
    controller.abort()
    await expect(first).rejects.toMatchObject({ code: 'ABORTED', stage: 'upload' })
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false)
    secondResponse.resolve({ ok: true, status: 204 })
    await expect(second).resolves.toEqual({ id: 'second.png' })
    expect(getResult).toHaveBeenCalledTimes(1)
    firstResponse.resolve({ ok: true, status: 204 })
  })
})

describe('结构化错误', () => {
  it('File 不可用时返回输入错误，导入和创建工厂仍可执行', async () => {
    const file = createFile()
    vi.stubGlobal('File', undefined)
    const { upload } = setup()
    await expect(upload(file)).rejects.toMatchObject({ code: 'INVALID_FILE', stage: 'validation' })
  })

  it.each([
    ['signature', 'SIGNATURE_FAILED'],
    ['target', 'TARGET_FAILED'],
    ['upload', 'UPLOAD_FAILED'],
    ['result', 'RESULT_FAILED'],
  ] as const)('%s 阶段失败时保留原始 Error 为 cause', async (stage, code) => {
    const cause = new Error(`${stage} failed`)
    const { upload, getSignature, getUploadTarget, getResult } = setup()
    if (stage === 'signature') getSignature.mockRejectedValue(cause)
    if (stage === 'target')
      getUploadTarget.mockImplementation(() => {
        throw cause
      })
    if (stage === 'upload') fetchMock.mockRejectedValue(cause)
    if (stage === 'result') getResult.mockRejectedValue(cause)
    const error = await upload(createFile()).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(UploadError)
    expect(error).toMatchObject({ name: 'UploadError', code, stage, cause, message: cause.message })
  })

  it('非 Error 异常也保留 cause', async () => {
    const cause = { serviceCode: 'SIGN_UNAVAILABLE' }
    const { upload, getSignature } = setup()
    getSignature.mockRejectedValue(cause)
    await expect(upload(createFile())).rejects.toMatchObject({
      code: 'SIGNATURE_FAILED',
      stage: 'signature',
      cause,
    })
  })

  it.each([
    [{ host: '', formData: {} }, 'INVALID_TARGET'],
    [{ host: 'https://bucket.example.com', formData: {}, expiration: 0 }, 'INVALID_EXPIRATION'],
    [{ host: 'https://bucket.example.com', formData: {}, maxFileSize: 0 }, 'INVALID_SIZE_LIMIT'],
    [{ host: 'https://bucket.example.com', formData: {}, maxFileSize: 1 }, 'FILE_TOO_LARGE'],
  ] as const)('对不合法的上传约束返回具体错误码 %s', async (target, code) => {
    const { upload, getUploadTarget } = setup()
    getUploadTarget.mockReturnValue(target)
    await expect(upload(createFile())).rejects.toMatchObject({ code, stage: 'target' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [203, 'CALLBACK_FAILED'],
    [403, 'UPLOAD_FAILED'],
    [500, 'UPLOAD_FAILED'],
  ] as const)('HTTP %s 错误包含状态码，不执行结果查询', async (status, code) => {
    fetchMock.mockResolvedValue({ ok: status < 300, status })
    const { upload, getResult } = setup()
    await expect(upload(createFile())).rejects.toMatchObject({ code, stage: 'upload', status })
    expect(getResult).not.toHaveBeenCalled()
  })
})
