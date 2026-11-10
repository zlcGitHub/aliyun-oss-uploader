# OSS Uploader

不依赖 Vue、React 或业务请求封装的浏览器 OSS 表单直传工厂。运行时零第三方依赖，提供 ESM、CommonJS 和 TypeScript 类型声明。

包名为 `@xiujin/oss-uploader`，归属 npm 组织 `xiujin`。

## 安装

```bash
pnpm add @xiujin/oss-uploader
```

## 接入

接入项目提供签名接口、上传目标映射和结果查询；接口地址、项目标识、登录鉴权及接口响应解包由项目处理。

上传组件获取 File 后调用上传函数，并负责界面状态、文件列表和错误提示。各项目通过自己的 API 适配层创建上传函数，插件不绑定组件库或业务接口。

```ts
import { createUploader } from '@xiujin/oss-uploader'

type TSignature = {
  endpoint: string
  fields: Record<string, string>
  fileId: string
  queryToken: string
}

type TUploadedFile = { fileId: string; url: string }

type TFileApi = {
  sign: (file: File, signal?: AbortSignal) => Promise<TSignature>
  getFile: (fileId: string, queryToken: string, signal?: AbortSignal) => Promise<TUploadedFile>
}

export const createProjectUploader = (api: TFileApi) =>
  createUploader({
    timeoutMs: 120000, // OSS 传输超时；省略时为 10 分钟
    getSignature: (file, { signal }) => api.sign(file, signal),
    getUploadTarget: ({ endpoint, fields }) => ({
      host: endpoint,
      formData: fields,
    }),
    getResult: ({ fileId, queryToken }, { signal }) => api.getFile(fileId, queryToken, signal),
  })

// const upload = createProjectUploader(fileApi)
// const result = await upload(file) // File -> Promise<TUploadedFile>
```

`api.sign` 和 `api.getFile` 的实现应将 signal 转交给 fetch 或 axios。签名申请和结果查询的超时由接入项目设置。

AI 图片、视频等 Blob 应在调用边界转换为 File：

```ts
const file = new File([blob], 'generated-image.png', { type: blob.type })
```

## API

运行时导出 `createUploader` 和 `UploadError`，并提供对应类型声明：

```ts
type TUploadTarget = {
  host: string
  formData: Record<string, string>
  expiration?: number // Unix 毫秒，提供时必须尚未过期
  maxFileSize?: number // 字节，提供时必须为正数，文件可等于上限
}

type TUploadOptions = { signal?: AbortSignal }
type TUploaderContext = { signal?: AbortSignal }

type TUploaderOptions<TSignature, TResult> = {
  getSignature: (file: File, context: TUploaderContext) => Promise<TSignature>
  getUploadTarget: (signature: TSignature) => TUploadTarget
  getResult: (signature: TSignature, context: TUploaderContext) => Promise<TResult>
  timeoutMs?: number
}

// createUploader<TSignature, TResult>(options):
//   (file: File, options?: TUploadOptions) => Promise<TResult>
```

`TSignature` 和 `TResult` 由回调自动推断，也可显式指定。工厂不要求签名包含顶层 `key`、`fileId` 或 `accessToken`，也不要求结果包含 `url`。项目应在回调内校验自己的凭证及结果字段。

`timeoutMs` 必须为 1 到 2147483647 的整数，单位为毫秒。省略时为 600000。无效配置在创建工厂时同步抛出 `INVALID_TIMEOUT` 错误。

## 超时与取消

`timeoutMs` 只限制 OSS 传输阶段，传输结束后会清除计时器。签名申请和结果查询各自的超时由接入项目管理。

```ts
const controller = new AbortController()
const task = upload(file, { signal: controller.signal })

// 在上传组件的取消按钮或关闭弹窗回调中执行：
// controller.abort()

const result = await task // 取消时 reject 为 UploadError，code 为 ABORTED
```

取消信号作用于签名、目标映射、OSS 传输和结果查询阶段。提前取消时不会申请签名；执行中取消会立即使上传调用 reject，并停止后续步骤。每次上传单独管理计时器及 OSS 传输信号，可使用不同的 signal 独立取消并发上传。

`getSignature` 和 `getResult` 的第二个参数提供调用方传入的 signal。即使回调忽略 signal，插件也会结束当前调用并忽略迟到结果或异常；要中止回调内部的实际网络请求，需要将 signal 转交给请求客户端。

取消表示停止当前调用，不代表撤销已上传的对象或后端已经完成的操作。若在结果查询阶段取消，文件可能已经上传成功。

## 错误处理

上传失败会 reject 为 `UploadError`，包含以下字段：

- `code`：稳定的错误码，用于业务判断。
- `stage`：错误发生阶段。
- `status`：OSS HTTP 状态码，仅在相关 HTTP 错误中提供。
- `cause`：回调或网络原始异常，取消时为取消原因。

```ts
import { UploadError } from '@xiujin/oss-uploader'

try {
  const result = await upload(file)
} catch (error) {
  if (error instanceof UploadError) {
    // 使用 error.code 和 error.stage 决定业务提示。
    // error.status 提供 OSS HTTP 状态；error.cause 保留原始异常。
  }
  throw error
}
```

| code                 | stage        | 含义                          |
| -------------------- | ------------ | ----------------------------- |
| `INVALID_FILE`       | `validation` | 输入不是当前窗口的非空 File   |
| `INVALID_TIMEOUT`    | `validation` | 创建工厂时提供了无效超时      |
| `INVALID_TARGET`     | `target`     | 上传地址或表单结构无效        |
| `INVALID_EXPIRATION` | `target`     | 签名有效期无效或已过期        |
| `INVALID_SIZE_LIMIT` | `target`     | 大小上限无效                  |
| `FILE_TOO_LARGE`     | `target`     | 文件超过大小上限              |
| `SIGNATURE_FAILED`   | `signature`  | 签名申请回调失败              |
| `TARGET_FAILED`      | `target`     | 上传目标映射回调失败          |
| `UPLOAD_FAILED`      | `upload`     | 网络错误或 OSS HTTP 失败      |
| `CALLBACK_FAILED`    | `upload`     | OSS 返回回调失败状态 HTTP 203 |
| `RESULT_FAILED`      | `result`     | 最终结果查询回调失败          |
| `TIMEOUT`            | `upload`     | OSS 传输超时                  |
| `ABORTED`            | 当前阶段     | 调用方取消上传                |

同时导出 `TUploadErrorCode`、`TUploadStage` 和 `TUploadErrorOptions`，方便业务声明错误处理类型。

## 上传行为

1. 验证输入为非空 File，然后申请签名。
2. 映射并校验上传地址、表单对象及已提供的有效期和大小限制。
3. 原样追加签名表单字段；忽略已有 `file` 占位字段，将真实文件最后追加一次。
4. 用 fetch POST 至 OSS，使用 `credentials: 'omit'`，不添加业务鉴权头或手动设置 multipart boundary。
5. OSS 返回成功状态且状态码不是 203 后，执行一次 `getResult` 并返回其结果。

不会自动重试、轮询或重复上传。工厂不补文件后缀、不生成 UID、不拼接 Object Key；Object Key 和签名字段由服务端生成。若业务请求封装会合并同名签名请求，接入层需自行为每次申请生成唯一文件名。

当前版本不提供进度、分片或断点续传。

## 环境与服务端要求

- 上传在浏览器中执行，需要 File、FormData、fetch 和 AbortController；超时使用可清理计时器，不依赖 `AbortSignal.timeout` 或 `AbortSignal.any`。构建不会自动补齐 Web API。
- 模块导入及创建工厂不读取浏览器对象，可在 SSR 模块中导入；应在客户端调用上传函数。
- File 应与上传函数位于同一窗口上下文。普通文件选择、拖拽和粘贴上传通常满足这一要求；页面嵌在 iframe 内且在该 iframe 内完成上传，也不受影响。若直接传递另一个窗口创建的 File，可在调用边界使用当前窗口的 `new File([sourceFile], sourceFile.name, { type: sourceFile.type, lastModified: sourceFile.lastModified })` 转换。
- Node.js `>=22.12.0` 和 pnpm `10.33.0` 用于本仓库开发及验证；本库的使用目标是浏览器。
- 后端提供 OSS 表单签名；AccessKey 等长期密钥保留在服务端。
- OSS Bucket 的 CORS 必须允许业务站点发起 POST。业务签名、查询接口的鉴权和 CORS 由接入项目处理。
- 使用回调确认机制时，后端应保证 OSS 成功响应后可单次查询到上传结果；结果尚未就绪时本库直接失败。

## 从 0.1 升级到 0.2

`upload(file)` 和只声明原有一个参数的接入回调继续可用。需要取消时，通过 `upload(file, { signal })` 传入信号，并在接入回调中使用新增的第二个参数。

异常统一为 `UploadError`，标准 Error 的 message 保留，原始对象放入 cause。若已有代码依赖原始异常的类型或引用，应改为检查 cause；建议使用 code 和 stage 进行业务判断。

## 开发与发布

```bash
pnpm install --frozen-lockfile
pnpm type-check
pnpm test
pnpm build
pnpm check:package
```

`pnpm check` 执行类型检查、行为测试和压缩包验证。压缩包验证会将真实 `.tgz` 离线安装到临时项目，检查 ESM / CommonJS、两种模块的类型声明、上传行为、取消、超时及发布文件白名单。测试使用模拟网络，不访问实际 OSS。

GitHub Actions 仅执行检查，不执行发布。维护者发布流程见 [docs/releasing.md](https://github.com/zlcGitHub/aliyun-oss-uploader/blob/main/docs/releasing.md)。
