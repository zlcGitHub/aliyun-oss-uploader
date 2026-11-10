# 发布与版本维护

## 发布配置

- npm 包名：`@xiujin/oss-uploader`，归属组织 `xiujin`。
- Registry：`https://registry.npmjs.org/`。
- 可见性：`public`，任何项目均可从 npm 安装。
- CI 执行检查；正式发布由有包发布权限的维护者手动执行。

## 准备版本

根据变更选择 patch、minor 或 major。`0.x` 阶段的不兼容变更应升级 minor，并明确说明迁移方式。

```bash
# 示例：递增修复版本，不自动创建 Git 提交或 tag。
npm version patch --no-git-tag-version
pnpm check
npm pack --dry-run
```

`pnpm check` 验证类型、上传行为、构建产物及实际压缩包安装。发布内容应只有 `dist/`、README、LICENSE 和 package.json。

## 手动发布

使用有该包发布权限的个人 npm 账号登录：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/
```

`npm whoami` 返回个人用户名，组织归属由包名中的 `@xiujin/` 前缀决定。账号应具备对应组织和包的发布权限，并按 npm 提示完成发布所需的 2FA 验证。

`npm publish` 会自动执行检查与构建。npm 不允许覆盖已发布的同名同版本，因此每次发布都必须使用新版本号。

## 确认发布结果

发布后确认正式版本和 `latest` 标签：

```bash
npm view @xiujin/oss-uploader version dist-tags --registry=https://registry.npmjs.org/
```

若 npm 返回正在处理的提示，等待处理完成后再确认 Registry 中的版本。若使用 `npm stage publish` 提交了暂存版本，则需完成对应暂存记录的审批。命令退出成功不等于新版本已经对外可安装。

在独立临时项目中从 npm 安装新版本，验证公开入口、类型声明和实际使用场景。完成验证后，将对应源码提交与版本 tag 对齐。

## 业务项目升级

接入项目从 npm 安装插件，并通过三个回调适配自身的签名、上传目标和结果查询接口。业务鉴权、接口响应解包、文件命名约定、UI 状态及错误提示由接入项目维护。

```bash
# 将 0.1.0 替换为目标版本。
pnpm add @xiujin/oss-uploader@0.1.0 --save-exact --registry=https://registry.npmjs.org/
```

升级时同步提交依赖声明和锁文件，运行项目的上传回归、类型检查及构建，并验证实际上传链路。插件自身的通用行为测试保留在本仓库维护。

## 发布前联调

需要在正式发布前验证接入时，可使用独立的预发布版本或通过 `npm pack` 生成本地压缩包。使用压缩包时，每次变更应递增版本并生成不同文件名，避免命中同路径、同版本的旧缓存。

本地联调依赖只用于验证；正式接入使用 npm 发布版本。插件保持通用上传协议，业务接口、项目凭证和组件实现由各接入方提供。
