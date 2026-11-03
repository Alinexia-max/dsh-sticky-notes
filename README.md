# dsh-sticky-notes（便签）

DSH 侧栏插件：左侧栏一个便签入口，点开在中间主区域显示便签面板。

- 包名 `@local/dsh-sticky-notes`，纯 JS、无构建步骤，作为**工作区里的普通插件包**编写。
- 安装方式：`plugin_manager` → `install_bundle`（目标是本目录的绝对路径 `E:\github\dsh-sticky-notes`）。
  不手写 profile 里的 `package.json` / `cordis.patch.yml`，也不在 profile 目录里跑 pnpm。

## 目录结构

```
dsh-sticky-notes/
  package.json          # dsh.bundle.patch + dsh.client + exports(client/locale/icon)
  cordis.patch.yml      # - insert: id sticky-notes, name @local/dsh-sticky-notes
  index.js              # Host 半边：webServer 路由 + JSON 文件存储
  client.js             # Client 半边：window.__ModuleLoader__ 注册侧栏图标 + 主面板
  locale/en.json        # 展示元数据 meta.title / meta.description
  locale/zh.json
  icon.svg              # 原始图标，随包分发
  smoke-test.mjs        # 宿半边离线冒烟测试（不依赖 cordis）
  check-client.mjs      # 客户端静态检查（loader 契约 / i18n / 主题 token）
  README.md
```

## 界面接入点

- `sidebar.panellist`（list）：注册 id `sticky-notes`、`order: 2`（插件 0、插件市场 1、计划任务 10 之间），
  只提供图标组件（owner props：`size`、`active`）；侧栏按钮、点击和标签文字由 shell 负责，主面板按同一 id 派发。
- `main`（keyed）：注册 key `sticky-notes`，渲染便签面板本体。主面板 slot 不提供外壳，页面自带头部与编辑区。

## 数据

- Host 端 `$DSH_HOME/sticky-notes/notes.json`（临时文件 + rename 原子写，权限 0600）。
- 路由前缀 `/api/dsh-sticky-notes`：`GET …/state` 读全部、`PUT …/state` 整份覆盖保存。
- 安全校验沿用本机已有插件的做法：校验 Host / Origin / `sec-fetch-site`，写接口额外要求自定义请求头
  `x-dsh-sticky-notes: 1` 与 `application/json`，本路由不返回任何 CORS 头。
- 服务端会收窄提交内容：最多 200 条、标题 200 字、正文 20000 字、`color` 只认
  `pink / yellow / mint / sky / violet`，字段类型不对就归零，非法 JSON 返回 400。

## 界面

贴纸墙风格：每条便签就是一张彩色圆角小窗（配色见 client.js 的 `PAPERS` 与 CSS 的 `dsn:palette` 区块），
顶部标题栏左边是可直接改的标题，右边是 `···`（换纸色 / 删除）和 `×`（两次点击确认删除），下方整块纸面就是正文。

## v1 功能

新建 / 编辑（标题 + 正文）/ 删除（二次确认）/ 换纸色 / 防抖自动保存（600ms）/ 保存状态提示 /
空状态 / 加载失败重试 / 中英双语 / 纸色随数据持久化。

## 自检

```powershell
cd E:\github\dsh-sticky-notes
node smoke-test.mjs      # 14/14：路由、落盘、鉴权、参数校验、纸色持久化
node check-client.mjs    # 19/19：loader id、注册 key、i18n 全覆盖、主题 token、配色白名单一致性
```

客户端半边的**视觉与交互**目前只做了静态检查：工作区里没有 React/ReactDOM 可用，未安装前也没有真实
slot 环境可跑。安装后按 `references/verification.md` 在现有页面里核对样式与明暗主题。
