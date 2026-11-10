/** 项目适配后的 OSS 表单上传目标；不包含项目凭证、接口响应码或最终结果。 */
export type TUploadTarget = {
  host: string
  formData: Record<string, string>
  /** 可选的签名有效期，Unix 毫秒；提供时必须有效且未过期。 */
  expiration?: number
  /** 可选的文件大小上限，字节；提供时必须为正数。 */
  maxFileSize?: number
}

export type TUploaderOptions<TSignature, TResult> = {
  getSignature: (file: File) => Promise<TSignature>
  getUploadTarget: (signature: TSignature) => TUploadTarget
  /** OSS 上传及回调成功后执行一次，失败直接抛出，不自动重试。 */
  getResult: (signature: TSignature) => Promise<TResult>
}

const UPLOAD_TIMEOUT = 600000

const validateUploadTarget = (target: TUploadTarget, file: File): void => {
  if (
    !target ||
    typeof target.host !== 'string' ||
    !target.host.trim() ||
    !target.formData ||
    typeof target.formData !== 'object' ||
    Array.isArray(target.formData)
  ) {
    throw new Error('OSS upload target is incomplete')
  }
  if (
    target.expiration !== undefined &&
    (!Number.isFinite(target.expiration) || target.expiration <= Date.now())
  ) {
    throw new Error('OSS upload expiration is invalid or expired')
  }
  if (
    target.maxFileSize !== undefined &&
    (!Number.isFinite(target.maxFileSize) ||
      target.maxFileSize <= 0 ||
      file.size > target.maxFileSize)
  ) {
    throw new Error('OSS upload size limit is invalid or exceeded')
  }
}

/** 浏览器 OSS 表单直传工厂；接口、鉴权和结果类型由项目接入层提供。 */
export const createUploader =
  <TSignature, TResult>(
    options: TUploaderOptions<TSignature, TResult>,
  ): ((file: File) => Promise<TResult>) =>
  async (file) => {
    if (!(file instanceof File) || file.size === 0)
      throw new Error('Upload file is empty or invalid')
    const signature = await options.getSignature(file)
    const target = options.getUploadTarget(signature)
    validateUploadTarget(target, file)

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
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    })
    // OSS 回调失败可能返回 203，不能仅依赖 response.ok。
    if (!response.ok || response.status === 203) {
      throw new Error(`OSS upload failed (HTTP ${response.status})`)
    }
    return options.getResult(signature)
  }
