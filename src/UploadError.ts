export type TUploadStage = 'validation' | 'signature' | 'target' | 'upload' | 'result'

export type TUploadErrorCode =
  | 'INVALID_FILE'
  | 'INVALID_TIMEOUT'
  | 'INVALID_TARGET'
  | 'INVALID_EXPIRATION'
  | 'INVALID_SIZE_LIMIT'
  | 'FILE_TOO_LARGE'
  | 'SIGNATURE_FAILED'
  | 'TARGET_FAILED'
  | 'UPLOAD_FAILED'
  | 'CALLBACK_FAILED'
  | 'RESULT_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'

export type TUploadErrorOptions = {
  code: TUploadErrorCode
  stage: TUploadStage
  status?: number
  cause?: unknown
}

/** 可供业务提示与监控识别的上传错误；原始异常保存在 cause。 */
export class UploadError extends Error {
  readonly code: TUploadErrorCode
  readonly stage: TUploadStage
  readonly status?: number

  constructor(message: string, options: TUploadErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'UploadError'
    this.code = options.code
    this.stage = options.stage
    this.status = options.status
  }
}
