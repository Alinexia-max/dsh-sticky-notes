// 静态检查客户端半边：loader 契约、i18n key 完整性、主题 token 白名单、注册 id 一致性。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (name) => readFile(join(root, name), 'utf8')

const client = await read('client.js')
const index = await read('index.js')
const store = await read('store.js')
const mcp = await read('mcp.js')
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
for (const match of client.matchAll(/\bt\('([a-zA-Z]+)'\)/g)) used.add(match[1])
const zhStart = client.indexOf('zh: {')
const enStart = client.indexOf('en: {')
const zhBlock = client.slice(zhStart, enStart)
const enBlock = client.slice(enStart, client.indexOf('const CSS', enStart))
const keyOf = (block) => new Set([...block.matchAll(/^\s{8}([a-zA-Z]+):/gm)].map((m) => m[1]))
const zhKeys = keyOf(zhBlock)
const enKeys = keyOf(enBlock)
const missingZh = [...used].filter((key) => !zhKeys.has(key))
const missingEn = [...used].filter((key) => !enKeys.has(key))
check(`zh dictionary covers ${used.size} keys`, missingZh.length === 0, missingZh)
check(`en dictionary covers ${used.size} keys`, missingEn.length === 0, missingEn)
check('zh/en key sets match', zhKeys.size === enKeys.size && [...zhKeys].every((key) => enKeys.has(key)), `${zhKeys.size} vs ${enKeys.size}`)

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

// 9. dsh 清单齐备
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

// 12. 分发清单与包入口
check('files ship store.js and mcp.js', ['store.js', 'mcp.js'].every((name) => pkg.files?.includes(name)), pkg.files)
check('package exports ./mcp', pkg.exports?.['./mcp'] === './mcp.js', pkg.exports?.['./mcp'])

// 13. 三条入口共享同一套工具面：MCP server + DSH 原生工具 + 后台对齐
const toolNames = ['notes_list', 'notes_get', 'notes_create', 'notes_update', 'notes_delete', 'notes_restore', 'notes_purge']
check(
  'mcp server exposes every note tool',
  toolNames.every((toolName) => mcp.includes(`name: '${toolName}'`)),
  toolNames.filter((toolName) => !mcp.includes(`name: '${toolName}'`)),
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

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
