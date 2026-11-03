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

- 默认数据目录 `$DSH_HOME/sticky-notes/`：`notes.json`（`{ version, notes }`，临时文件 + rename 原子写，
  权限 0600）+ `assets/` 截图 + 迁移后留档的 `notes.corrupt-*.json` / `notes.migrated-*.json`。
- 存放目录可在界面里改（工具栏「目录」）：配置写在 `$DSH_HOME/sticky-notes/config.json`（`{ "dir": "绝对路径" | null }`，
  固定留在默认目录，否则搬走后就找不到配置了）。切换时把 `notes.json` 与 `assets/` 复制到新目录，
  目标已有 `notes.json` 则不覆盖，同时把老 `notes.json` 改名留档，避免切回默认目录时读到过期数据。
  只接受绝对路径（相对路径会跟着进程工作目录漂）。
- 环境变量 `DSH_HOME` 仍可用于整体搬迁 DSH 数据目录。
- 路由前缀 `/api/dsh-sticky-notes`：
  - `GET …/state` 读整份（含 `version`）；
  - `PUT …/notes/:id` 单条 upsert、`DELETE …/notes/:id?baseVersion=N` 单条删除；
  - `PUT …/state` 整份覆盖（导入/兼容用，可选 `baseVersion`）；
  - `POST …/assets` 传图（`image/png|jpeg|gif|webp`，≤8MB）、`GET …/assets/:name` 取图。
- 并发：每次写都让文档 `version` 自增。写请求带 `baseVersion`，与当前版本不符返回 **409** 并把服务端整份
  数据回给客户端；客户端把「本端还没发出去的改动」叠到服务端状态上再重发，因此两个窗口同时开着不会互相吃掉改动。
  读-改-写在 Host 端串行排队，避免后写的整份盖掉先写的。
- 安全校验沿用本机已有插件的做法：校验 Host / Origin / `sec-fetch-site`，写接口额外要求自定义请求头
  `x-dsh-sticky-notes: 1`（JSON 接口还要 `application/json`），本路由不返回任何 CORS 头；note id 与
  asset 名都先过正则再拼路径。
- 服务端会收窄提交内容：最多 200 条、标题 200 字、正文 20000 字、`color` 只认
  `pink / yellow / mint / sky / violet`，可选的 `width` / `height` 夹到 220–720 / 180–720，字段类型不对就归零。
- 整份覆盖的请求体上限 16MB（200 条 × 20000 字中文约 12MB），必须能装下内容上限，否则大内容会 413。
- `notes.json` 解析失败时先改名为 `notes.corrupt-<时间>.json` 留档，再按空数据返回（响应带
  `recovered: true` 与 `backup`），避免插件永久卡在「加载失败」。

## 界面

贴纸墙风格：每条便签就是一张彩色圆角小窗（配色见 client.js 的 `PAPERS` 与 CSS 的 `dsn:palette` 区块），
顶部标题栏左边是可直接改的标题（留空时用正文首行当标题），右边是 `···`（换纸色 / 删除）和 `×`（直接删除，
底部弹出撤销条）。整块纸面就是正文，右下角可拖拽改大小，尺寸随数据保存。暗色主题下自动换成压暗纸色 + 浅色墨字。

## 功能

- 新建 / 编辑（标题 + 正文）/ 删除 + 撤销 / 换纸色 / 拖拽改尺寸 / 拖拽排序
  （拖动时整张卡片作为拖影跟随指针，原位置卡片变淡；按指针在目标卡片左/右半决定插前还是插后，
  落点有竖条提示，重排走 FLIP 位移动画；搜索状态下禁用拖拽）
- 存放目录可在界面切换，自动迁移便签与图片，可一键恢复默认
- 搜索（标题 + 正文，显示每条命中次数）、排序（手动 / 创建时间 / 最近编辑 / 标题）
- 正文里 `Tab` 缩进两格、`Shift+Tab` 回退；URL 自动做成可点胶囊；粘贴截图会上传到 `assets/` 并在卡片底部显示缩略图
- 逐条保存 + 文档版本号：多窗口同时编辑会提示「已合并」，不会互相覆盖
- 防抖自动保存（600ms）、失败退避重试（1s→15s）、手动重试、关闭页面时 keepalive 补发
- 新建后自动聚焦标题、切走时自动清理空白便签、满 200 条禁用新建
- 快捷键：`Alt+N` 新建、`Ctrl/⌘+F` 搜索、`Ctrl/⌘+S` 立即保存（`Ctrl+N` 会被浏览器抢走，故用 Alt）
- 空状态快捷键提示 / 加载失败重试 / 保存状态 `aria-live` / 中英双语 / 跟随明暗主题

## 自检

```powershell
cd E:\github\dsh-sticky-notes
node smoke-test.mjs      # 49/49：单条增删改、409 冲突、鉴权、路径穿越、图片、坏文件恢复、目录切换与迁移
node check-client.mjs    # 27/27：loader 契约、i18n 全覆盖、主题 token、配色白名单、路由一致性、无 HTML 注入
```

客户端半边的**视觉与交互**目前只做了静态检查：工作区里没有 React/ReactDOM 可用，未安装前也没有真实
slot 环境可跑。安装后按 `references/verification.md` 在现有页面里核对样式与明暗主题。
