import { UploadError } from './UploadError'
import type { TUploadErrorCode, TUploadStage } from './UploadError'

/** 项目适配后的 OSS 表单上传目标；不包含项目凭证、接口响应码或最终结果。 */
export type TUploadTarget = {
  host: string
  formData: Record<string, string>
  /** 可选的签名有效期，Unix 毫秒；提供时必须有效且未过期。 */
  expiration?: number
  /** 可选的文件大小上限，字节；提供时必须为正数。 */
  maxFileSize?: number
}

export type TUploadOptions = {
  /** 取消本次调用；签名及结果查询的底层请求需由回调转交 signal 才能中止。 */
  signal?: AbortSignal
}

export type TUploaderContext = {
  signal?: AbortSignal
}

export type TUploaderOptions<TSignature, TResult> = {
  getSignature: (file: File, context: TUploaderContext) => Promise<TSignature>
  getUploadTarget: (signature: TSignature) => TUploadTarget
  /** OSS 上传及回调成功后执行一次，失败直接抛出，不自动重试。 */
  getResult: (signature: TSignature, context: TUploaderContext) => Promise<TResult>
  /** OSS 传输阶段超时，毫秒；默认 600000，必须为 1 到 2147483647 的整数。 */
  timeoutMs?: number
}

const DEFAULT_UPLOAD_TIMEOUT = 600000
const MAX_TIMEOUT = 2147483647

const abortedError = (signal: AbortSignal | undefined, stage: TUploadStage): UploadError =>
  new UploadError('Upload was aborted', { code: 'ABORTED', stage, cause: signal?.reason })

/** 即使回调不消费 signal，也立即结束调用，并接住其后续结果或异常。 */
const runStage = async <T>(
  stage: TUploadStage,
  code: TUploadErrorCode,
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
  getAbortError: () => UploadError = () => abortedError(signal, stage),
): Promise<T> => {
  if (signal?.aborted) throw getAbortError()
  let onAbort: (() => void) | undefined
  try {
    const result = await new Promise<T>((resolve, reject) => {
      if (signal) {
        onAbort = () => reject(getAbortError())
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
          return
        }
      }
      try {
        Promise.resolve(operation()).then(resolve, reject)
      } catch (cause) {
        reject(cause)
      }
    })
    if (signal?.aborted) throw getAbortError()
    return result
  } catch (cause) {
    if (signal?.aborted) throw getAbortError()
    if (cause instanceof UploadError) throw cause
    const message = cause instanceof Error ? cause.message : `Upload ${stage} failed`
    throw new UploadError(message, { code, stage, cause })
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

const validateUploadTarget = (target: TUploadTarget, file: File): void => {
  if (
    !target ||
    typeof target.host !== 'string' ||
    !target.host.trim() ||
    !target.formData ||
    typeof target.formData !== 'object' ||
    Array.isArray(target.formData)
  ) {
    throw new UploadError('OSS upload target is incomplete', {
      code: 'INVALID_TARGET',
      stage: 'target',
    })
  }
  if (
    target.expiration !== undefined &&
    (!Number.isFinite(target.expiration) || target.expiration <= Date.now())
  ) {
    throw new UploadError('OSS upload expiration is invalid or expired', {
      code: 'INVALID_EXPIRATION',
      stage: 'target',
    })
  }
  if (
    target.maxFileSize !== undefined &&
    (!Number.isFinite(target.maxFileSize) || target.maxFileSize <= 0)
  ) {
    throw new UploadError('OSS upload size limit is invalid or exceeded', {
      code: 'INVALID_SIZE_LIMIT',
      stage: 'target',
    })
  }
  if (target.maxFileSize !== undefined && file.size > target.maxFileSize) {
    throw new UploadError('OSS upload size limit is invalid or exceeded', {
      code: 'FILE_TOO_LARGE',
      stage: 'target',
    })
  }
}

const postFile = async (
  target: TUploadTarget,
  file: File,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    await runStage(
      'upload',
      'UPLOAD_FAILED',
      async () => {
        const body = new FormData()
        Object.entries(target.formData).forEach(([key, value]) => {
          // 忽略已有 file 占位字段，真实文件始终只追加一次且位于最后。
          if (key !== 'file') body.append(key, value)
        })
        body.append('file', file, file.name)

        // 直传不携带业务鉴权；multipart boundary 由浏览器生成。
        const response = await fetch(target.host, {
          method: 'POST',
          body,
          credentials: 'omit',
          signal: controller.signal,
        })
        // OSS 回调失败可能返回 203，不能仅依赖 response.ok。
        if (!response.ok || response.status === 203) {
          throw new UploadError(`OSS upload failed (HTTP ${response.status})`, {
            code: response.status === 203 ? 'CALLBACK_FAILED' : 'UPLOAD_FAILED',
            stage: 'upload',
            status: response.status,
          })
        }
      },
      controller.signal,
      () =>
        timedOut
          ? new UploadError(`OSS upload timed out after ${timeoutMs} ms`, {
              code: 'TIMEOUT',
              stage: 'upload',
            })
          : abortedError(controller.signal, 'upload'),
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 浏览器 OSS 表单直传工厂；接口、鉴权和结果类型由项目接入层提供。 */
export const createUploader = <TSignature, TResult>(
  options: TUploaderOptions<TSignature, TResult>,
): ((file: File, uploadOptions?: TUploadOptions) => Promise<TResult>) => {
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_UPLOAD_TIMEOUT : options.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT) {
    throw new UploadError('OSS upload timeout must be an integer between 1 and 2147483647 ms', {
      code: 'INVALID_TIMEOUT',
      stage: 'validation',
    })
  }

  return async (file, { signal } = {}) => {
    if (typeof File === 'undefined' || !(file instanceof File) || file.size === 0) {
      throw new UploadError('Upload file is empty or invalid', {
        code: 'INVALID_FILE',
        stage: 'validation',
      })
    }
    const context: TUploaderContext = { signal }
    const signature = await runStage(
      'signature',
      'SIGNATURE_FAILED',
      () => options.getSignature(file, context),
      signal,
    )
    const target = await runStage(
      'target',
      'TARGET_FAILED',
      () => {
        const target = options.getUploadTarget(signature)
        validateUploadTarget(target, file)
        return target
      },
      signal,
    )
    await postFile(target, file, timeoutMs, signal)
    return runStage('result', 'RESULT_FAILED', () => options.getResult(signature, context), signal)
  }
}
