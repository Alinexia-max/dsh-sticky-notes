// 静态检查：loader 契约、i18n key 完整性、主题 token 白名单、注册 id 一致性、
// 路由/工具面一致性、配色三处同步、正文纯函数（表格/待办/Markdown）整块求值。
// 视觉与交互仍然只能装进宿主看，清单在 references/verification.md。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (name) => readFile(join(root, name), 'utf8')

const client = await read('client.js')
const index = await read('index.js')
const store = await read('store.js')
const mcp = await read('mcp.js')
const exporter = await read('export.js')
const pkg = JSON.parse(await read('package.json'))

const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` -> ${String(detail)}`}`)
}

// 1. loader 契约：id 必须等于包名
const idMatch = client.match(/__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'([^']+)'/)
check('loader id equals package name', idMatch !== null && idMatch[1] === pkg.name, idMatch && idMatch[1])

// 2. factory 返回 inject + apply
check('factory returns { inject, apply }', /return \{\s*\n\s*inject: \['slots', 'locale'\],\s*\n\s*apply\(ctx\)/.test(client))
check('no harness client package require', !/require\('@deepseek-ai\//.test(client))
check('no iframe / document.body writes', !/createElement\('iframe'|document\.body/.test(client))

// 3. 侧栏与主面板使用同一个 id
const panelId = client.match(/const PANEL_ID = '([^']+)'/)
check('PANEL_ID declared', Boolean(panelId), panelId && panelId[0])
check('panellist id === main key', panelId !== null && client.includes("id: PANEL_ID") && client.includes('key: PANEL_ID'))

// 4. i18n：t('x') 用到的 key 在中英文字典里都有
const used = new Set()
// 直接调用与 ref 里的延迟调用都要算；只认 t('x') 会漏掉 tRef.current('x')。
for (const match of client.matchAll(/(?:\bt|tRef\.current)\('([a-zA-Z]+)'\)/g)) used.add(match[1])
// 表驱动文案（PAPERS 的 label、SORTS 的 label、SNAPSHOT_KINDS 的取值）也走 t()，一并算进来。
// `(?<!aria-)` 防止把 aria-label 的字面量误当成 i18n key。
for (const match of client.matchAll(/(?<!aria-)\b(?:label|auto|preRestore|corrupt|migrated): '([a-zA-Z]+)'/g)) {
  used.add(match[1])
}
const zhStart = client.indexOf('zh: {')
const enStart = client.indexOf('en: {')
const cssStart = client.indexOf('const CSS', enStart)
// 切片锚点一旦改名，下面几条断言会拿空集合互相比较、静默通过，先确认三处都在。
check('dictionary blocks are locatable', zhStart > 0 && enStart > zhStart && cssStart > enStart, {
  zhStart,
  enStart,
  cssStart,
})
if (zhStart < 0 || enStart <= zhStart || cssStart <= enStart) {
  console.error('\nthe zh/en dictionary blocks could not be sliced — i18n assertions would be meaningless.')
  process.exit(1)
}
const zhBlock = client.slice(zhStart, enStart)
const enBlock = client.slice(enStart, cssStart)
const keyOf = (block) => new Set([...block.matchAll(/^\s{8}([a-zA-Z]+):/gm)].map((m) => m[1]))
const zhKeys = keyOf(zhBlock)
const enKeys = keyOf(enBlock)
const missingZh = [...used].filter((key) => !zhKeys.has(key))
const missingEn = [...used].filter((key) => !enKeys.has(key))
check(`zh dictionary covers ${used.size} keys`, missingZh.length === 0, missingZh)
check(`en dictionary covers ${used.size} keys`, missingEn.length === 0, missingEn)
check('zh/en key sets match', zhKeys.size === enKeys.size && [...zhKeys].every((key) => enKeys.has(key)), `${zhKeys.size} vs ${enKeys.size}`)
// 反向检查：字典里留着没人用的 key，说明删功能时忘了删文案。
const unusedKeys = [...zhKeys].filter((key) => !used.has(key))
check('no unused dictionary keys', unusedKeys.length === 0, unusedKeys)

// 5. 主题 token 必须来自 Theme.listTokens，不许自造
const allowed = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])
const usedTokens = new Set([...client.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))
// --dsn-* 是插件自有的纸张变量，其余必须来自 DSH 主题。
const unknown = [...usedTokens].filter((token) => !allowed.has(token) && !token.startsWith('--dsn-'))
check(`theme tokens ${usedTokens.size}/${allowed.size} known`, unknown.length === 0, unknown)

// 6. 颜色字面量只允许出现在 dsn:palette 区块（便签纸本身就是要上色），其余不得硬编码颜色
const paletteStart = client.indexOf('/* dsn:palette:begin')
const paletteEnd = client.indexOf('/* dsn:palette:end')
const hasPalette = paletteStart >= 0 && paletteEnd > paletteStart
const paletteBlock = hasPalette ? client.slice(paletteStart, paletteEnd) : ''
const outsidePalette = hasPalette ? client.slice(0, paletteStart) + client.slice(paletteEnd) : client
const colorLiterals = [...outsidePalette.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)].map((m) => m[0])
check('colors only inside the dsn palette block', hasPalette && colorLiterals.length === 0, colorLiterals)
check('palette defines paper / head / ink tokens', /--dsn-paper:/.test(paletteBlock) && /--dsn-paper-head:/.test(paletteBlock) && /--dsn-ink:/.test(paletteBlock), 'missing token')

// 7. 便签配色三处一致：CSS 类、客户端 PAPERS、Host 端白名单
const cssPapers = [...new Set([...paletteBlock.matchAll(/\.dsn-paper-([a-z]+)\s*\{/g)].map((m) => m[1]))]
const papersBlock = client.match(/const PAPERS = \[([\s\S]*?)\n    \]/)
const clientPapers = papersBlock ? [...papersBlock[1].matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]) : []
const hostColors = store.match(/const PAPER_COLORS = new Set\(\[([^\]]*)\]\)/)
const hostPapers = hostColors ? [...hostColors[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : []
const sameSet = (a, b) => a.length === b.length && a.length > 0 && a.every((item) => b.includes(item))
check('paper colors CSS === client PAPERS', sameSet(cssPapers, clientPapers), `${cssPapers} vs ${clientPapers}`)
check('paper colors client === host whitelist', sameSet(clientPapers, hostPapers), `${clientPapers} vs ${hostPapers}`)
const darkPapers = [...new Set([...paletteBlock.matchAll(/data-tone="dark"\]\s+\.dsn-paper-([a-z]+)/g)].map((m) => m[1]))]
check('dark tone covers every paper', sameSet(darkPapers, cssPapers), `${darkPapers} vs ${cssPapers}`)

// 8. 客户端路由与宿主前缀一致
const prefixLiteral = "const API_PREFIX = '/api/dsh-sticky-notes'"
check('api prefix matches host', client.includes(prefixLiteral) && index.includes(prefixLiteral), 'prefix mismatch')
check('client builds routes from the prefix', client.includes('`${API_PREFIX}/state`') && client.includes('`${NOTES_PATH}/'), 'route literal drift')
check('host exposes per-note routes', index.includes('`${NOTES_PATH}/`') && index.includes('handleNote'), 'missing notes route')
check('host exposes asset routes', index.includes('handleAssetUpload') && index.includes('handleAssetGet'), 'missing asset route')
check('host exposes config routes', index.includes('handleConfigGet') && index.includes('handleConfigSet'), 'missing config route')
check('client talks to the config route', client.includes('CONFIG_PATH') && client.includes('openStorage'), 'missing storage ui')

// 9. 正文是纯文本，不许出现 dangerouslySetInnerHTML 之类的注入口子
check('no dangerouslySetInnerHTML', !/dangerouslySetInnerHTML/.test(client))
check('inputs capped by maxLength', /maxLength: MAX_TITLE/.test(client) && /maxLength: MAX_NOTE_BODY/.test(client))

// 10. dsh 清单齐备
check('dsh.bundle.patch declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('dsh.client.platform web', pkg.dsh?.client?.platform === 'web')
check('package exports ./client', Boolean(pkg.exports?.['./client']))
check('package exports ./icon', Boolean(pkg.exports?.['./icon']))

// 11. 数据层与 MCP server 保持零依赖：只允许 node 内置模块与本地文件
const externalImports = (source) =>
  [...source.matchAll(/from '([^']+)'/g)]
    .map((match) => match[1])
    .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('./'))
check('store.js imports only node builtins', externalImports(store).length === 0, externalImports(store))
check('mcp.js imports only node builtins and local files', externalImports(mcp).length === 0, externalImports(mcp))
check('index.js imports only node builtins and local files', externalImports(index).length === 0, externalImports(index))
check('export.js imports only node builtins and local files', externalImports(exporter).length === 0, externalImports(exporter))
check(
  'asset size cap is defined once in store.js',
  store.includes('const MAX_ASSET_BYTES = 8 * 1024 * 1024') &&
    !/const MAX_ASSET_BYTES/.test(index) &&
    !/const MAX_ASSET_BYTES/.test(exporter),
  'duplicated asset size cap',
)

// 12. 分发清单与包入口
check('files ship store.js and mcp.js', ['store.js', 'mcp.js'].every((name) => pkg.files?.includes(name)), pkg.files)
check('package exports ./mcp', pkg.exports?.['./mcp'] === './mcp.js', pkg.exports?.['./mcp'])

// 13. 三条入口共享同一套工具面：MCP server + DSH 原生工具 + 后台对齐
const toolNames = [
  'notes_list',
  'notes_get',
  'notes_create',
  'notes_update',
  'notes_delete',
  'notes_restore',
  'notes_purge',
  'notes_trash_list',
  'notes_empty_trash',
]
check(
  'mcp server exposes every note tool',
  toolNames.every((toolName) => mcp.includes(`name: '${toolName}'`)),
  toolNames.filter((toolName) => !mcp.includes(`name: '${toolName}'`)),
)
// 手工维护的名字清单最容易漂移（之前就漏过两个），所以直接跟 mcp.js 里的定义对账。
const mcpToolNames = [...mcp.matchAll(/name: '(notes_[a-z_]+)'/g)].map((match) => match[1])
check(
  'tool surface has no drift',
  mcpToolNames.length === toolNames.length && mcpToolNames.every((name) => toolNames.includes(name)),
  `mcp.js defines ${mcpToolNames.length}: ${mcpToolNames.join(',')}`,
)
check(
  'host registers the native note tools',
  index.includes('notesTools()') && index.includes('tools.register(definition)') && index.includes("toolsOf(ctx)"),
  'native tool wiring missing',
)
check(
  'client syncs external changes',
  client.includes('syncIfStale') && client.includes("addEventListener('visibilitychange'"),
  'missing background sync',
)
check('client poll interval is bounded', /SYNC_INTERVAL = \d{4,6}/.test(client), 'missing SYNC_INTERVAL')
check(
  'client can pin notes above the rest',
  client.includes('function pinRank') && client.includes("'data-pinned'") && client.includes('GlyphPin'),
  'missing pinned UI',
)

// 14. 正文语义（待办 + 表格 + 预览分块）：marker 区块直接求值跑一遍（和 CSS 的 dsn:palette 一个路数）
const bodyBegin = client.indexOf('/* dsn:body:begin')
const bodyEnd = client.indexOf('/* dsn:body:end */')
const bodyBlock = bodyBegin >= 0 && bodyEnd > bodyBegin ? client.slice(client.indexOf('\n', bodyBegin), bodyEnd) : ''
const tables = bodyBlock
  ? new Function(
      bodyBlock + '\nreturn { tablesOf, setTableCell, tableFromTsv, appendTable, blocksOf, orderForDrop, inlineOf };',
    )()
  : null
check('body helpers are evaluable', Boolean(tables), 'missing dsn:body block')
if (!tables) {
  // 切片失败时下面二十多条断言会整体跳过，CI 只会看到一条失败、很容易被当成注释笔误。
  // 直接终止，避免"以为测过其实没测"。
  console.error('\ndsn:body block not found — the markdown assertions did not run at all.')
  process.exit(1)
}
if (tables) {
  const md = ['| 名称 | 数量 |', '| --- | --- |', '| 苹果 | 2 |', '| 香蕉 | 3 |'].join('\n')
  const parsed = tables.tablesOf(md)
  check(
    'parses a table into header + rows',
    parsed.length === 1 && parsed[0].startLine === 0 && parsed[0].header.length === 2 && parsed[0].rows.length === 2,
    JSON.stringify(parsed),
  )
  check('finds a table below prose', tables.tablesOf('说明\n' + md)[0]?.startLine === 1, 'start line drifted')
  const written = tables.setTableCell(md, 0, 1, 1, '5|6')
  check(
    'cell edit rewrites exactly one line',
    written.split('\n').length === 4 && written.split('\n')[3] === '| 香蕉 | 5\\|6 |',
    written,
  )
  const converted = tables.tableFromTsv('name\tage\r\nBob\t3\r\nAda\t4\r\n')
  check(
    'tsv becomes a table with header + divider',
    converted === ['| name | age |', '| --- | --- |', '| Bob | 3 |', '| Ada | 4 |'].join('\n'),
    converted,
  )
  check('single column text is not a table', tables.tableFromTsv('just text') === '', 'not filtered')
  check('prose with a pipe is not a table', tables.tablesOf('a | b\n--- | ---').length === 0, 'false positive')
  const inserted = tables.appendTable('已有内容')
  check(
    'insert table appends a parseable 3x3 block',
    inserted.startsWith('已有内容\n\n') && tables.tablesOf(inserted).length === 1 && tables.tablesOf(inserted)[0].header.length === 3,
    inserted,
  )
  check('insert table on empty body has no leading blank line', tables.appendTable('').startsWith('| '), tables.appendTable(''))
}

// 15. 预览分块：表格整块、待办逐行、其余按段落合并，图片行让位给缩略图
if (tables) {
  const sample = [
    '小标题',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '- [ ] 待办一',
    '- [x] 待办二',
    '正文第一行',
    '正文第二行',
    '',
    '![](assets/shot.png)',
  ].join('\n')
  const blocks = tables.blocksOf(sample)
  check(
    'preview blocks: text / table / todo x2 / text',
    blocks.length === 5 &&
      blocks[0].type === 'text' &&
      blocks[1].type === 'table' &&
      blocks[2].type === 'todo' &&
      blocks[2].done === false &&
      blocks[3].type === 'todo' &&
      blocks[3].done === true &&
      blocks[4].type === 'text',
    blocks.map((block) => block.type).join(','),
  )
  check('paragraph keeps its own lines', blocks[4] && blocks[4].lines.length === 2, JSON.stringify(blocks[4]))
  check('block offset points at the source line', sample.slice(blocks[1].offset).startsWith('| a | b |'), blocks[1].offset)
  check('image line is not rendered as text', tables.blocksOf('![](assets/shot.png)').length === 0, 'image line leaked')
  check('table block keeps all rows', blocks[1].table.rows.length === 1, JSON.stringify(blocks[1].table))
}
check('client renders md tables', client.includes("className: 'dsn-table'") && client.includes('dsn-table-input'), 'missing table ui')
check('table paste honours the body cap', client.includes('next.slice(0, MAX_NOTE_BODY)'), 'paste can exceed MAX_NOTE_BODY')
check(
  'tables and todos render in full',
  !client.includes('MAX_TABLE_ROWS') && !client.includes('MAX_TABLES') && !client.includes('dsn-table-more'),
  'row folding came back',
)

// 16. 预览/原文切换只靠点正文，卡片和工具栏都不放按钮
check(
  'no dedicated mode button anywhere',
  !client.includes('dsn-foot-btn') && !client.includes('GlyphPencil') && !client.includes('defaultMode'),
  'stale mode button or switch',
)
check(
  'clicking the preview opens the source editor',
  client.includes('onPreviewClick') && client.includes('enterEdit'),
  'missing preview-to-edit entry',
)

// 17. 拖拽落点：order 只在同组内取邻居，置顶/普通混排时才不会落回原位
if (tables) {
  const valueOf = (note) => note.order
  const mixed = [
    { id: 'p', pinned: true, order: -1 },
    { id: 'c', order: -300 },
    { id: 'b', order: -200 },
  ]
  const atTop = tables.orderForDrop(mixed, 1, false, valueOf)
  check('drop below a pinned card lands in the plain group', atTop < -300, atTop)
  check('drop between two plain cards takes the midpoint', tables.orderForDrop(mixed, 2, false, valueOf) === -250, tables.orderForDrop(mixed, 2, false, valueOf))
  check('drop into the pinned group lands before it', tables.orderForDrop(mixed, 0, true, valueOf) < -1, tables.orderForDrop(mixed, 0, true, valueOf))
  check('drop at the pinned group tail lands after it', tables.orderForDrop(mixed, 1, true, valueOf) > -1, tables.orderForDrop(mixed, 1, true, valueOf))
}

// 18. 数据面板：快照 / 导入导出 / 图片回收三条路由与宿主保持一致
const dataRoutes = ['SNAPSHOTS_PATH', 'EXPORT_PATH', 'IMPORT_PATH', 'STORAGE_PATH']
check(
  'client declares the data routes',
  dataRoutes.every((route) => client.includes(`const ${route} = \`\${API_PREFIX}/`)),
  dataRoutes.filter((route) => !client.includes(`const ${route} = \`\${API_PREFIX}/`)),
)
check(
  'host serves the data routes',
  ['handleSnapshots', 'handleSnapshotItem', 'handleExport', 'handleImport', 'handleStorage', 'SNAPSHOT_NAME'].every(
    (name) => index.includes(name),
  ),
  'missing data handler',
)
check(
  'client wires the data dialog',
  ['openData', 'restoreSnapshot', 'exportData', 'importBackup', 'pruneAssets'].every((name) => client.includes(name)),
  'missing data ui',
)
check(
  'downloads never touch document.body',
  client.includes('triggerDownload') && !/document\.body/.test(client),
  'download helper leaks into body',
)
check(
  'import merges behind a version guard',
  client.includes('baseVersion: versionRef.current') && index.includes('MAX_IMPORT_BYTES'),
  'import without a version guard',
)
// 满员导入会被拒掉一部分，条数必须在提示里出现，否则用户以为整份都进来了。
check(
  'import reports the overflow count',
  /data\.overflow[\s\S]{0,300}?importOverflow/.test(client),
  'overflow not surfaced in the import notice',
)
check(
  'export and storage share the zero-dependency layer',
  store.includes('restoreSnapshot') && store.includes('listSnapshots') && /from '\.\/export\.js'/.test(index),
  'missing snapshot/export layer',
)

// 19. Markdown 补全：行内粗体/斜体/代码/链接，块级标题/代码块/列表
if (tables) {
  const strong = tables.inlineOf('前 **粗体** 后')
  check('inline strong splits text', strong.length === 3 && strong[1].type === 'strong' && strong[1].text === '粗体', strong)
  const emphasis = tables.inlineOf('a *斜* b')
  check('inline emphasis', emphasis[1]?.type === 'em' && emphasis[1].text === '斜', emphasis)
  const code = tables.inlineOf('`**not bold**`')
  check(
    'inline code wins over bold',
    code.length === 1 && code[0].type === 'code' && code[0].text === '**not bold**',
    code,
  )
  const link = tables.inlineOf('见 [文档](https://example.com/a)')
  check(
    'inline link keeps href',
    link.some((part) => part.type === 'link' && part.href === 'https://example.com/a'),
    link,
  )
  const unsafe = tables.inlineOf('[x](javascript:alert(1))')
  check('inline link rejects javascript:', unsafe.every((part) => part.type !== 'link'), unsafe)
  check('snake_case stays literal', tables.inlineOf('a_b_c').length === 1, tables.inlineOf('a_b_c'))

  const md = ['# 标题', '', '- 一项', '- 二项', '', '```js', '| a | b |', '| --- | --- |', '```', '', '正文'].join('\n')
  const rich = tables.blocksOf(md)
  check(
    'blocks: heading / list / code / text',
    rich.length === 4 &&
      rich[0].type === 'heading' &&
      rich[0].level === 1 &&
      rich[1].type === 'list' &&
      rich[1].items.length === 2 &&
      rich[2].type === 'code' &&
      rich[2].lang === 'js' &&
      rich[3].type === 'text',
    rich.map((block) => block.type).join(','),
  )
  check('code block swallows pipe tables', rich[2] && rich[2].text.startsWith('| a | b |'), rich[2] && rich[2].text)
  check('code block offset points at the fence', md.slice(rich[2].offset).startsWith('```js'), rich[2].offset)
  const ordered = tables.blocksOf('1. 一\n2. 二')
  check(
    'ordered list keeps the order flag',
    ordered.length === 1 && ordered[0].ordered === true && ordered[0].items.length === 2,
    ordered,
  )
  const nested = tables.blocksOf('- 一\n  - 二')
  check('nested list keeps indent', nested[0].items[1].indent === 2, nested[0].items)
  check(
    'todo lines are not swallowed by lists',
    tables.blocksOf('- [ ] 待办\n- 普通')
      .map((block) => block.type)
      .join(',') === 'todo,list',
    tables.blocksOf('- [ ] 待办\n- 普通').map((block) => block.type),
  )
}
check(
  'markdown renders through react, not innerHTML',
  client.includes('inlineNodes') && !/dangerouslySetInnerHTML/.test(client),
  'markdown bypassed react',
)
check('markdown links are not repeated as chips', client.includes('explicit.has(url)'), 'link chips duplicated')

// 20. 图片可以直接拖进卡片
check(
  'cards accept dropped images',
  client.includes("indexOf('Files')") && client.includes('const image = dropped.find'),
  'no drop-to-upload path',
)

// 21. 本轮修复的回归防护
check(
  'read path salvages instead of renaming',
  store.includes('function salvageNotes') && !/notes: sanitizeNotes\(parsed\)/.test(store),
  'readDoc rejects the whole file on field errors',
)
check(
  'note ids are charset-checked',
  /!ID_PATTERN\.test\(rawId\)/.test(store),
  'sanitizeNote accepts arbitrary ids',
)
check(
  'import writes images only after the version check',
  /return \{ conflict: doc \}[\s\S]{0,80}await writeAssets\(/.test(exporter),
  'assets written before baseVersion is validated',
)
check(
  'asset pruning flushes pending edits first',
  /const pruneAssets[\s\S]{0,500}flushRef\.current\(\)/.test(client),
  'prune may delete images whose reference is still pending',
)
check(
  'asset links are path-checked',
  client.includes('function isAssetHref') && client.includes("!name.includes('..')"),
  'markdown asset links can walk out of the plugin prefix',
)
check(
  'storage report hides the orphan detail list',
  index.includes('delete report.orphans'),
  'orphan detail list is shipped to the browser',
)

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
