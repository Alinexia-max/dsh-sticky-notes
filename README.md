# dsh-sticky-notes（便签）

DSH 侧栏插件：左侧栏一个便签入口，点开在中间主区域显示便签面板。

- 包名 `@local/dsh-sticky-notes`，纯 JS、无构建步骤，作为**工作区里的普通插件包**编写。
- 安装方式：`plugin_manager` → `install_bundle`（目标是本目录的绝对路径 `E:\github\dsh-sticky-notes`）。
  不手写 profile 里的 `package.json` / `cordis.patch.yml`，也不在 profile 目录里跑 pnpm。

## 目录结构

```
dsh-sticky-notes/
  package.json          # dsh.bundle.patch + dsh.client + exports(client/mcp/locale/icon)
  cordis.patch.yml      # - insert: id sticky-notes, name @local/dsh-sticky-notes
  index.js              # Host 半边：webServer 路由 + 原生工具注册
  store.js              # 数据层：目录解析 / 读写 / 文件锁 / 版本号 / 字段清洗 / 快照（零依赖）
  export.js             # 导入 / 导出 / zip 打包 / 图片占用审计（零依赖）
  mcp.js                # MCP server（stdio，零依赖）：tools 增删改查 + resources
  client.js             # Client 半边：window.__ModuleLoader__ 注册侧栏图标 + 主面板
  locale/en.json        # 展示元数据 meta.title / meta.description
  locale/zh.json
  icon.svg              # 原始图标，随包分发
  smoke-test.mjs        # 宿半边离线冒烟测试（HTTP 路由 + 原生工具 + 快照/导出/导入）
  mcp-test.mjs          # MCP 协议层冒烟测试（真拉子进程走 stdio JSON-RPC）
  check-client.mjs      # 静态检查（loader 契约 / i18n / 主题 token / 工具面一致性 / Markdown 求值）
  references/verification.md  # 装进宿主后的人工核对清单（静态检查覆盖不到的部分）
  LICENSE               # MIT
  README.md
```

## 界面接入点

- `sidebar.panellist`（list）：注册 id `sticky-notes`、`order: 2`（插件 0、插件市场 1、计划任务 10 之间），
  只提供图标组件（owner props：`size`、`active`）；侧栏按钮、点击和标签文字由 shell 负责，主面板按同一 id 派发。
- `main`（keyed）：注册 key `sticky-notes`，渲染便签面板本体。主面板 slot 不提供外壳，页面自带头部与编辑区。

## 数据

- 默认数据目录 `$DSH_HOME/sticky-notes/`：`notes.json`（`{ version, notes, trash }`，临时文件 + rename 原子写，
  权限 0600）+ `assets/` 截图 + 迁移后留档的 `notes.corrupt-*.json` / `notes.migrated-*.json`。
- 存放目录可在界面里改（工具栏「目录」）：配置写在 `$DSH_HOME/sticky-notes/config.json`（`{ "dir": "绝对路径" | null }`，
  固定留在默认目录，否则搬走后就找不到配置了）。切换时把 `notes.json` 与 `assets/` 复制到新目录，
  目标已有 `notes.json` 则不覆盖，同时把老 `notes.json` 改名留档，避免切回默认目录时读到过期数据。
  只接受绝对路径（相对路径会跟着进程工作目录漂）。
- 环境变量 `DSH_HOME` 仍可用于整体搬迁 DSH 数据目录。
- 路由前缀 `/api/dsh-sticky-notes`：
  - `GET …/state` 读整份（含 `version`）；
  - `PUT …/notes/:id` 单条 upsert（`note` 必须是对象，否则 400——不这样的话一个字符串就能把正文清空）、
    `DELETE …/notes/:id?baseVersion=N` 单条删除；
  - `PUT …/state` 整份覆盖（兼容用，可选 `baseVersion`，超量、脏条目或重复 id 直接 400）；
  - `GET …/trash` 列回收站、`DELETE …/trash` 清空、`POST …/trash/:id/restore` 还原、`DELETE …/trash/:id` 彻底删除；
  - `POST …/assets` 传图（`image/png|jpeg|gif|webp`，≤8MB）、`GET …/assets/:name` 取图；
  - `GET …/snapshots` 列快照、`POST …/snapshots/:name/restore` 用快照回滚（写入前自动把当前状态另存一份；
    快照里没有 `notes` 数组时拒绝恢复，避免一个被改坏的文件把整板清空）；
  - `GET …/export?format=json|markdown&assets=0` 导出：JSON 备份可直接再导入，Markdown 带图片时打包成 zip；
  - `POST …/import` 导入，可带 `assets`（文件名 → base64）一起回填图片：
    - `mode: merge`（默认）逐条抢救，坏条目（非法 id、重复 id、非对象）跳过并计入响应里的 `dropped`；
      本地已满 200 条时**本地原有便签优先**：只有本地根本没有的新条目才占名额，名额用完的部分直接丢掉，
      单独计入响应里的 `overflow`（同时并入 `skipped`），面板会提示「超出上限未导入 N」。
      同 id 的更新不占名额，不受上限影响；
    - `mode: replace` 是破坏性整份覆盖，跟 `PUT /state` 一样严格，超量、脏条目或重复 id 直接 400；
    - 图片只在「真的会写盘」时才落盘（409 冲突、无任何改动时磁盘零写入），单次最多 500 张；
  - `GET …/storage` 图片占用报告（总数 / 大小 / 孤儿 / 断链数 / 新上传）、`DELETE …/storage` 清理孤儿图片。
    报告只回统计值，孤儿明细与断链文件名都留在服务端；清理在写锁内重新审计，
    且落盘不满 60 秒的图片不算孤儿（避免把「刚粘贴、引用还没写进文件」的图删掉）。
- 请求体上限：普通写接口 16MB，`/import` 单独放宽到 96MB（要装得下 base64 图片）。
- 并发：每次写都让文档 `version` 自增。写请求带 `baseVersion`，与当前版本不符返回 **409** 并把服务端整份
  数据回给客户端；客户端把「本端还没发出去的改动」叠到服务端状态上再重发，因此两个窗口同时开着不会互相吃掉改动。
  合并是**字段级**的：只把本端这次真正改过的字段（标题 / 正文 / 配色 / 尺寸 / 置顶）盖上去，
  两个窗口分别改同一条的标题和正文时两份改动都能留下。
  读-改-写在 Host 端串行排队，避免后写的整份盖掉先写的。
- 卸载兜底：关页面时若有未保存改动，会用 `PUT …/state` 整份补发一次，但**带 `baseVersion`**——
  期间别的窗口改过就让这次请求 409 掉，宁可丢掉最后几秒的改动，也不整份盖掉别人的数据。
- 跨进程：`store.js` 在数据目录里放一个 `.notes.lock`（`O_EXCL` 创建，5s 等锁超时、10s 判陈旧），
  面板与 MCP 进程同时写也不会互相覆盖。锁文件里写的是持有者 token，持锁期间每 2s 刷新一次 mtime——
  一次几十 MB 的导入不会因为「太久没动静」被别的进程当成陈旧锁回收；释放时只有 token 仍匹配才删，
  不会误删别人重建的新锁。**锁不支持重入**：在 `withDoc` / `restoreSnapshot` /
  `pruneAssets` 的 task 里再调另一个带锁函数，会排到当前任务之后等自己，5s 后以
  `error.state.busy`（503）失败；所以带锁函数之间不嵌套，内部只用不加锁的 `readState` / `readDoc`。
- 安全校验沿用本机已有插件的做法：校验 Host / Origin / `sec-fetch-site`，写接口额外要求自定义请求头
  `x-dsh-sticky-notes: 1`（JSON 接口还要 `application/json`），本路由不返回任何 CORS 头；note id 与
  asset 名都先过正则再拼路径。
- 服务端会收窄提交内容：最多 200 条、标题 200 字、正文 20000 字、`color` 只认
  `pink / yellow / mint / sky / violet`，可选的 `width` / `height` 夹到 220–720 / 180–720、`pinned` 只认 `true`，
  字段类型不对就归零。
- 整份覆盖的请求体上限 16MB（200 条 × 20000 字中文约 12MB），必须能装下内容上限，否则大内容会 413。
- 快照：每次写盘前把上一份轮转成 `notes.bak.1..3.json`；坏文件、迁移也各留一份
  （`notes.corrupt-*` / `notes.migrated-*`）。回滚前另存一份 `notes.pre-restore-<时间>.json`，
  只保留最近一份——同一份内容 `rotateSnapshots` 已经轮转进 `notes.bak.1`，多留只是给「恢复前」一个可读标签。
  界面「数据」弹窗能直接看到这些快照并一键回滚。
- 读盘分「结构损坏」与「字段脏」两种处理：只有**根本不是合法 JSON**（或没有 `notes` 数组）才改名留档
  （`notes.corrupt-<时间>.json`，响应带 `recovered` 与 `backup`）；结构没问题的，用 `salvageNotes()`
  逐条抢救——坏条目、重复 id、超出 200 条的部分直接丢掉，数量通过 `GET …/state` 的 `dropped` 回报，
  界面会提示「已跳过无法识别的便签」。**读接口不再因为字段问题把整份文件改名。**
- note id 必须匹配 `^[A-Za-z0-9._-]{1,128}$` 才会入库（它同时出现在 URL 路径与 MCP 资源 URI 里）；
  `mode: merge` 导入时遇到非法 id 的条目按「跳过」处理并计入 `dropped`，其余合法条目照常入库；
  `mode: replace` 与 `PUT /state` 是严格入口，一条非法 id 就让整次请求 400、不落盘。

## 模型接入（MCP 与原生工具）

两条入口共用 `store.js`，数据语义与工具名完全一致（`notes_*`）。

### MCP server（stdio，任何 MCP 客户端都能接）

`mcp.js` 是零依赖的 stdio MCP server，实现 `tools` 与 `resources` 两个能力
（`initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call` /
`resources/list` / `resources/read`），换行分隔的 JSON-RPC 2.0，stdout 只输出协议消息。
协议版本优先回 `2025-11-25`，客户端报别的版本时按 MCP 约定回自己支持的最新版本，不拒绝握手。

DSH（在 profile 的 patch 里加一条）：

```yaml
- id: mcp-sticky-notes
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: notes
    transport: stdio
    command: node
    args: ['E:\\github\\dsh-sticky-notes\\mcp.js']
    # DSH 只把白名单内的环境变量传给子进程：自定义过 DSH_HOME 时必须在这里显式传。
    # env: { DSH_HOME: 'D:\\path\\to\\.dsh' }
```

也可以用 `dsh-mcp-manager` 的「添加服务器」：stdio + command `node` + args 指向 `mcp.js`。
Cursor / Claude Desktop 等客户端的 `mcpServers` 条目同理。

| 工具 | 作用 |
|---|---|
| `notes_list` | 列出/搜索（`query`、`limit`、`includeBody`），拿 id；返回 `pinned` |
| `notes_get` | 读单条全文 |
| `notes_create` | 新建（`title`、`body`、`color`、`pinned`） |
| `notes_update` | 改标题/正文/配色/置顶，`mode: append` 追加正文 |
| `notes_delete` | 软删除，进回收站 |
| `notes_trash_list` | 列回收站 |
| `notes_restore` | 还原 |
| `notes_purge` | 彻底删除单条（需 `confirm: true`） |
| `notes_empty_trash` | 清空回收站（需 `confirm: true`） |

每条便签同时是一个资源：`resources/list` 列出 `notes://<id>`，`resources/read` 读回
`text/markdown`（标题为空时只给正文）。适合把某张便签整份塞进模型上下文，而不用先 `notes_get`。

### 原生工具（DSH 内直接用，不配 MCP 也行）

`index.js` 在 `apply` 里用 `ctx.tools.register` 注册同名工具（鸭子类型定义，不 import `@deepseek-ai/dsh-tools`）；
宿主没挂 `tools` 服务就安静跳过，不影响面板。两条都开时模型会同时看到 `notes_list` 与 `mcp__notes__notes_list`，功能等价。

### 面板与外部改动

面板在窗口聚焦、重新可见时按 `version` 对齐一次，可见期间每 20 秒兜底轮询；本端还有未保存改动时不接管，
交给保存流程的 409 合并逻辑。

## 界面

贴纸墙风格：每条便签就是一张彩色圆角小窗（配色见 client.js 的 `PAPERS` 与 CSS 的 `dsn:palette` 区块），
顶部标题栏左边是可直接改的标题（留空时用正文首行当标题），右边是图钉（置顶）、`···`（换纸色 / 插入表格 / 删除）和 `×`
（直接删除，底部弹出撤销条）。

纸面默认按**预览态**渲染正文：管道表格直接显示成表格、`- [ ]` 是复选框、图片显示为缩略图，
不再看到 `| a | b |` 这类原文。点正文任意处即切到原始文本，光标落在点击的那一行；
Esc 或点卡片外面回到预览，卡片与工具栏都不再放切换按钮。
右下角可拖拽改大小，尺寸随数据保存。暗色主题下自动换成压暗纸色 + 浅色墨字。

## 功能

- 新建 / 编辑（标题 + 正文）/ 删除 + 撤销 / 换纸色 / 拖拽改尺寸 / 拖拽排序
  （拖动时整张卡片作为拖影跟随指针，原位置卡片变淡；按指针在目标卡片左/右半决定插前还是插后，
  落点有竖条提示，重排走 FLIP 位移动画；搜索状态下禁用拖拽）
- 置顶：卡片头部的图钉按钮一键置顶/取消，置顶的便签在所有排序方式下都排在最前，并带常驻抬起阴影；
  拖到置顶区或普通区会自动跟着换组
- 表格：正文里写 Markdown 管道表格（`| a | b |` 表头 + `| --- | --- |` 分隔行）会在卡片内渲染成真表格，
  点单元格就地编辑并写回正文（Enter 提交、Esc 放弃）；从 Excel 复制一块区域粘贴会自动转成表格，
  `···` 菜单里也有「插入表格」补一张 3×3 空表。
  表格与待办都完整渲染、不折叠，行数多了就在预览区里滚动
- 正文里的 `- [ ]` / `- [x]` 待办在卡片内渲染成复选框，点一下就写回正文；脚部显示完成度
- 回收站：删除先进回收站（最多 30 条 / 30 天），可还原、彻底删除、清空（清空要点两次）
- 存放目录可在界面切换，自动迁移便签与图片，可一键恢复默认
- 外部改动（MCP server / 另一个窗口）会在窗口聚焦或 20 秒轮询内对齐，不覆盖本端未保存的编辑
- 搜索（标题 + 正文，显示每条命中次数）、排序（手动 / 创建时间 / 最近编辑 / 标题）
- Markdown 子集：管道表格、待办、`#` 标题、`**粗体**` / `*斜体*` / 行内代码、
  `[文字](url)`、围栏代码块、`-` / `1.` 列表，都在预览里渲染成真元素，不引第三方解析库
- 数据与备份（「数据」弹窗，三件事一个入口）：
  - 快照历史：列出自动轮转与留档快照（时间 / 条数 / 大小），一键回滚；回滚前自动把当前状态另存一份
  - 导入导出：导出 JSON 备份、导出 Markdown（带图片时打包成 zip）、导入 JSON 按 id 合并
  - 图片占用：总数 / 大小 / 孤儿 / 断链，一键清掉没有任何便签引用的图片
- 正文里 `Tab` 缩进两格、`Shift+Tab` 回退；URL 自动做成可点胶囊（正文里已成链接的不重复出胶囊）
- 图片：粘贴截图或直接把图片文件拖到卡片上都会上传到 `assets/` 并在卡片底部显示缩略图
- 逐条保存 + 文档版本号：多窗口同时编辑会提示「已合并」，不会互相覆盖；
  合并在字段级进行，两个窗口分别改同一条的标题和正文也能都留下
- 防抖自动保存（600ms）、失败退避重试（1s→15s）、手动重试、关闭页面时 keepalive 补发
- 新建后自动聚焦标题、切走时自动清理空白便签、满 200 条禁用新建
- 快捷键：`Alt+N` 新建、`Ctrl/⌘+F` 搜索、`Ctrl/⌘+S` 立即保存（`Ctrl+N` 会被浏览器抢走，故用 Alt）
- 空状态快捷键提示 / 加载失败重试 / 保存状态 `aria-live` / 中英双语 / 跟随明暗主题

## 自检

```powershell
cd E:\github\dsh-sticky-notes
node check-client.mjs          # loader 契约、i18n、主题 token、配色白名单、路由/工具面一致性、Markdown 求值
node smoke-test.mjs            # HTTP 路由、409 冲突、鉴权、路径穿越、图片、坏文件恢复、目录迁移、快照/导出/导入
node mcp-test.mjs              # 真拉两个子进程走 stdio JSON-RPC（握手 / tools / resources / 错误码 / 跨进程写锁）
node mcp.js --self-test        # MCP 工具面在临时目录里的增删改查、置顶与确认门槛
```

`npm test` 会把上面四步串起来跑；CI（`.github/workflows/test.yml`）在 Ubuntu / Windows × Node 20 / 22 上跑同一套。

客户端半边的**视觉与交互**仍然只能做静态检查：工作区里没有 React/ReactDOM，未安装前也没有真实 slot 环境。
`check-client.mjs` 会把 `dsn:body` 区块（表格 / 待办 / 行内标记 / 分块）整块求值跑一遍，
但样式、拖拽、弹窗、明暗主题必须装进宿主才看得见——照着 `references/verification.md` 走一遍即可。
