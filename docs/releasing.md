# 发布与业务项目迁移

## 当前状态

- 版本：`0.1.0`。
- 包名：`@xiujin/oss-uploader`，归属 npm 组织 `xiujin`。
- npm Registry：`https://registry.npmjs.org/`。
- 公开发布；如需私有发布，应先调整发布配置及账号权限。
- `prepublishOnly` 会阻止占位包名发布；CI 不登录 npm，也不发布。

## 首次发布

1. 本库和 Seller 已配置正式包名 `@xiujin/oss-uploader`，`publishConfig.access` 为 `public`，registry 指向 npmjs.com，无需创建新的 scope 或修改 registry 来表示组织。
2. 执行 `pnpm check` 和 `npm pack --dry-run` 检查代码及发布内容；预期只有 `dist/`、README、LICENSE 和 package.json。
3. 使用有 `xiujin` 组织发布权限的个人 npm 账号登录，确认身份后发布：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/
```

按 npm 提示完成浏览器登录和发布验证。不要将账号 token 写入源码或提交到仓库。`npm publish` 会自动执行完整检查并构建。

`npm whoami` 返回个人用户名，不必是 `xiujin`；组织归属由包名的 `@xiujin/` 前缀决定。如果提示没有发布权限，应由组织管理员检查当前账号的组织角色及包发布权限。

发布成功后核对版本及安装结果：

```bash
npm view @xiujin/oss-uploader@0.1.0 version --registry=https://registry.npmjs.org/
```

在源码提交与发布产物对应后创建 `v0.1.0` tag；Git 提交、推送和 tag 由实际发布操作一并处理。

## 发布前 Seller 如何接入

Seller 暂时使用自身仓库内的 `vendor/xiujin-oss-uploader-0.1.0.tgz`，依赖形式为：

```json
{
  "@xiujin/oss-uploader": "file:vendor/xiujin-oss-uploader-0.1.0.tgz"
}
```

这是可随 Seller 仓库迁移的实际 npm 压缩包，不依赖本机相邻目录或 symlink。Seller 的 `uploadToOss` 导出及调用方保持原接口，内部工厂从包入口导入。工厂源码和通用测试已迁移到独立库；Seller 保留业务适配和组件回归测试。

正式发布后，在 Seller 中执行：

```bash
pnpm add @xiujin/oss-uploader@0.1.0 --registry=https://registry.npmjs.org/
```

适配层已经使用正式包名，无需再改导入。依赖切换成功后，删除 `vendor/xiujin-oss-uploader-0.1.0.tgz` 和临时接入说明，提交 package.json、锁文件和对应源码。运行上传回归测试、类型检查和目标环境构建，并在实际浏览器环境上传文件验证后端链路。

## 发布前刷新本地包

修改工厂后先递增版本（可使用 `0.1.1-local.0` 等预发布版本），在库仓库执行 `pnpm check`、`npm pack`。将新压缩包复制到 Seller 的 vendor 目录，使用包含新版本的文件名，然后执行 `pnpm add @xiujin/oss-uploader@file:vendor/新文件名.tgz` 更新依赖和锁文件。删除不再引用的旧压缩包，再运行 Seller 检查。不要覆盖同路径、同版本的压缩包，以免命中旧缓存或保留旧校验值。

## 后续版本

- 修复使用 patch，增加兼容能力使用 minor，不兼容接口变更使用 major；`0.x` 阶段需在变更说明中明确兼容性。
- npm 上同名同版本不能覆盖；发布前先更新版本并记录变更。
- 每次执行 `pnpm check`、检查包内容、更新业务项目并运行其回归验证。
- 库包不携带 Seller API、项目名、登录态、OSS 配置或长期密钥。
