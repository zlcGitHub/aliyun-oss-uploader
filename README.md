# OSS Uploader

不依赖 Vue、React 或业务请求封装的浏览器 OSS 表单直传工厂。运行时零第三方依赖，提供 ESM、CommonJS 和 TypeScript 类型声明。

当前版本为 `0.1.0`，包名为 `@xiujin/oss-uploader`，归属 npm 组织 `xiujin`。首次发布由有该组织发布权限的个人账号手动执行。

## 安装

正式发布后：

```bash
pnpm add @xiujin/oss-uploader
```

发布前可在本仓库生成压缩包，再在接入项目安装该文件：

```bash
pnpm install --frozen-lockfile
pnpm check
npm pack
```

```bash
# 在接入项目执行；替换为实际生成的压缩包路径。
pnpm add /absolute/path/xiujin-oss-uploader-0.1.0.tgz
```

## 接入

接入项目提供签名接口、上传目标映射和结果查询；接口地址、项目标识、登录鉴权及接口响应解包由项目处理。

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
  sign: (file: File) => Promise<TSignature>
  getFile: (fileId: string, queryToken: string) => Promise<TUploadedFile>
}

export const createProjectUploader = (api: TFileApi) =>
  createUploader({
    getSignature: (file) => api.sign(file),
    getUploadTarget: ({ endpoint, fields }) => ({
      host: endpoint,
      formData: fields,
    }),
    getResult: ({ fileId, queryToken }) => api.getFile(fileId, queryToken),
  })

// const upload = createProjectUploader(fileApi)
// const result = await upload(file) // File -> Promise<TUploadedFile>
```

AI 图片、视频等 Blob 应在调用边界转换为 File：

```ts
const file = new File([blob], 'generated-image.png', { type: blob.type })
```

## API

公开导出 `createUploader`、`TUploadTarget` 和 `TUploaderOptions`：

```ts
type TUploadTarget = {
  host: string
  formData: Record<string, string>
  expiration?: number // Unix 毫秒，提供时必须尚未过期
  maxFileSize?: number // 字节，提供时必须为正数，文件可等于上限
}

type TUploaderOptions<TSignature, TResult> = {
  getSignature: (file: File) => Promise<TSignature>
  getUploadTarget: (signature: TSignature) => TUploadTarget
  getResult: (signature: TSignature) => Promise<TResult>
}

// createUploader<TSignature, TResult>(options): (file: File) => Promise<TResult>
```

`TSignature` 和 `TResult` 由回调自动推断，也可显式指定。工厂不要求签名包含顶层 `key`、`fileId` 或 `accessToken`，也不要求结果包含 `url`。项目应在回调内校验自己的凭证及结果字段。

## 上传行为

1. 验证输入为非空 File，然后申请签名。
2. 映射并校验上传地址、表单对象及已提供的有效期和大小限制。
3. 原样追加签名表单字段；忽略已有 `file` 占位字段，将真实文件最后追加一次。
4. 用 `fetch` POST 至 OSS，超时为 10 分钟。请求使用 `credentials: 'omit'`，不添加业务鉴权头或手动设置 multipart boundary。
5. OSS 返回成功状态且状态码不是 203 后，执行一次 `getResult` 并返回其结果。

签名、上传、结果查询任一步失败都会使上传 Promise reject。HTTP 203 视为 OSS 回调失败。不会自动重试、轮询或重复上传。签名申请和结果查询的超时由接入项目配置；10 分钟限制仅作用于 OSS 传输。

当前版本不提供进度、取消、分片或断点续传。工厂不补文件后缀、不生成 UID、不拼接 Object Key；Object Key 和签名字段由服务端生成。若业务请求封装会合并同名签名请求，接入层需自行为每次申请生成唯一文件名。

## 环境与服务端要求

- 上传在浏览器中执行，需要 `File`、`FormData`、`fetch`、`AbortSignal.timeout`；旧浏览器需由接入项目提供相应兼容处理。构建不会自动补齐 Web API。
- 模块导入及创建工厂不读取浏览器对象，可在 SSR 模块中导入；应在客户端调用上传函数。
- Node.js `>=22.12.0` 和 pnpm `10.33.0` 用于本仓库开发及验证；本库的使用目标是浏览器。
- 后端提供 OSS 表单签名；AccessKey 等长期密钥保留在服务端。
- OSS Bucket 的 CORS 必须允许业务站点发起 POST。业务签名、查询接口的鉴权和 CORS 由接入项目处理。
- 使用回调确认机制时，后端应保证 OSS 成功响应后可单次查询到上传结果；结果尚未就绪时本库直接失败。

## 开发与发布

```bash
pnpm install --frozen-lockfile
pnpm type-check
pnpm test
pnpm build
pnpm check:package
```

`pnpm check` 执行类型检查、行为测试和压缩包验证。压缩包验证会将真实 `.tgz` 离线安装到临时项目，检查 ESM / CommonJS、两种模块的类型声明、上传行为及发布文件白名单。测试使用模拟网络，不访问实际 OSS。

GitHub Actions 仅执行检查，不执行发布。发布流程及 Seller 迁移说明见源码仓库的 [docs/releasing.md](https://github.com/zlcGitHub/aliyun-oss-uploader/blob/main/docs/releasing.md)。

本库提取自 TeemDrop Seller 提交 `0f3085a9c51652919914af55ba53038de1755703` 的通用工厂；Seller 业务适配层继续保留在业务项目中。
