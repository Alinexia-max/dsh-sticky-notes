/**
 * 便签的 MCP server（stdio，零依赖）。
 *
 * 走 JSON-RPC 2.0 的换行分隔格式，只实现 tools 能力：
 * initialize / notifications/initialized / ping / tools/list / tools/call。
 * 不引官方 SDK，是因为插件要保持零运行时依赖——宿主（DSH）本身也只按这些方法通信。
 *
 * 用法（在自己用的 MCP 客户端里加一条 stdio 服务器即可）：
 *   command: node
 *   args:    ['<本文件绝对路径>']
 *   env:     { DSH_HOME: '<可选，指向同一个 DSH 主目录>' }
 *
 * 调试：`node mcp.js --self-test` 用临时目录跑一遍增删改查，不碰真实数据。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ID_PATTERN,
  PAPER_IDS,
  createNote,
  deleteNote,
  emptyTrash,
  getNote,
  listNotes,
  listTrash,
  messageOf,
  purgeNote,
  restoreNote,
  updateNote,
} from './store.js'

/** 服务端能接受的 legacy 协议版本（2026-07-28 的 server/discover 暂不实现）。 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const FALLBACK_PROTOCOL_VERSION = '2025-06-18'

const INSTRUCTIONS = [
  'Sticky notes stored on this machine by the DSH sticky-notes plugin.',
  'Call notes_list first to discover note ids; every other tool needs an id.',
  'notes_delete moves a note to the trash (recoverable). notes_purge is permanent and requires confirm: true.',
].join(' ')

const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))

function ok(value) {
  return { content: [{ type: 'text', text: text(value) }] }
}

function failed(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

function requireId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value.trim())) {
    throw new Error('id must be a note id returned by notes_list')
  }
  return value.trim()
}

const noteSummary = (note) => ({
  id: note.id,
  title: note.title,
  preview: note.body.replace(/\s+/g, ' ').trim().slice(0, 120),
  color: note.color,
  updatedAt: note.updatedAt,
  deletedAt: note.deletedAt,
})

/**
 * 工具清单。`inputSchema` 就是 MCP 要求的 JSON Schema，客户端直接展示给模型。
 */
const TOOLS = [
  {
    name: 'notes_list',
    description:
      'List sticky notes, newest first. Supports a keyword filter over title and body. Returns ids used by the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive keyword matched against title and body.' },
        limit: { type: 'integer', description: 'Maximum notes to return, 1-200 (default 20).' },
        includeBody: { type: 'boolean', description: 'Include the full body of every returned note.' },
      },
      additionalProperties: false,
    },
    async run(args) {
      return ok(await listNotes(args))
    },
  },
  {
    name: 'notes_get',
    description: 'Read one sticky note by id, including its full body.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id from notes_list.' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args) {
      const note = await getNote(requireId(args.id))
      if (!note) throw new Error(`note not found: ${args.id}`)
      return ok(note)
    },
  },
  {
    name: 'notes_create',
    description:
      'Create a sticky note. Title and body are both optional; Markdown task lines such as "- [ ] buy milk" render as checkboxes in the panel.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title (up to 200 characters).' },
        body: { type: 'string', description: 'Note body (up to 20000 characters).' },
        color: { type: 'string', enum: PAPER_IDS, description: 'Paper color; defaults to pink.' },
        pinned: { type: 'boolean', description: 'Pin the note to the top of the board.' },
      },
      additionalProperties: false,
    },
    async run(args) {
      return ok(await createNote(args))
    },
  },
  {
    name: 'notes_update',
    description:
      'Update a sticky note. Only the fields you pass are changed. Use mode "append" to add text at the end of the body instead of replacing it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note id from notes_list.' },
        title: { type: 'string', description: 'New title.' },
        body: { type: 'string', description: 'New body, or the text to append when mode is "append".' },
        color: { type: 'string', enum: PAPER_IDS, description: 'New paper color.' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'How body is applied (default replace).' },
        pinned: { type: 'boolean', description: 'Pin (true) or unpin (false) the note.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args) {
      const id = requireId(args.id)
      const patch = {}
      if (typeof args.title === 'string') patch.title = args.title
      if (typeof args.body === 'string') patch.body = args.body
      if (typeof args.color === 'string') patch.color = args.color
      if (typeof args.pinned === 'boolean') patch.pinned = args.pinned
      if (args.mode === 'append') patch.mode = 'append'
      if (Object.keys(patch).length === 0) {
        const note = await getNote(id)
        if (!note) throw new Error(`note not found: ${id}`)
        return ok(note)
      }
      return ok(await updateNote(id, patch))
    },
  },
  {
    name: 'notes_delete',
    description: 'Move a sticky note to the trash. The note can be restored with notes_restore.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id from notes_list.' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args) {
      const id = requireId(args.id)
      const result = await deleteNote(id)
      if (!result.removed) throw new Error(`note not found: ${id}`)
      return ok({ id, deleted: true, trashCount: result.trashCount })
    },
  },
  {
    name: 'notes_trash_list',
    description: 'List notes currently in the trash, with their deletion time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const entries = await listTrash()
      return ok({ total: entries.length, items: entries.map(noteSummary) })
    },
  },
  {
    name: 'notes_restore',
    description: 'Restore a note from the trash back onto the board.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id of the trashed note.' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args) {
      const result = await restoreNote(requireId(args.id))
      return ok({ id: result.note.id, restored: true, trashCount: result.trashCount })
    },
  },
  {
    name: 'notes_purge',
    description: 'Permanently delete one trashed note. Irreversible: requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the trashed note.' },
        confirm: { type: 'boolean', description: 'Must be true; guards against accidental permanent deletion.' },
      },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
    async run(args) {
      const id = requireId(args.id)
      if (args.confirm !== true) throw new Error('confirm must be true to purge a note permanently')
      const result = await purgeNote(id)
      return ok({ id, purged: result.purged, trashCount: result.trashCount })
    },
  },
  {
    name: 'notes_empty_trash',
    description: 'Permanently delete every trashed note. Irreversible: requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Must be true; guards against accidental permanent deletion.' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    async run(args) {
      if (args.confirm !== true) throw new Error('confirm must be true to empty the trash')
      const result = await emptyTrash()
      return ok(result)
    },
  },
]

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]))

async function serverVersion() {
  try {
    const raw = await readFile(new URL('./package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function pickProtocolVersion(requested) {
  if (typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)) return requested
  return FALLBACK_PROTOCOL_VERSION
}

/** 版本号只读一次 package.json，并发请求共用同一个 promise。 */
let versionPromise = null
function packageVersion() {
  if (versionPromise === null) versionPromise = serverVersion()
  return versionPromise
}

async function handleRequest(message) {
  const method = message.method
  if (method === 'initialize') {
    return {
      protocolVersion: pickProtocolVersion(message.params && message.params.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'dsh-sticky-notes', version: await packageVersion() },
      instructions: INSTRUCTIONS,
    }
  }
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools: TOOLS.map(({ name: toolName, description, inputSchema }) => ({ name: toolName, description, inputSchema })) }
  if (method === 'tools/call') {
    const params = message.params || {}
    const tool = TOOL_MAP.get(params.name)
    if (!tool) {
      const error = new Error(`unknown tool: ${params.name}`)
      error.rpcCode = -32602
      throw error
    }
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    try {
      return await tool.run(args)
    } catch (caught) {
      // 业务失败（找不到便签、参数不合法）按 MCP 约定放进结果，不算协议错误。
      return failed(messageOf(caught))
    }
  }
  const error = new Error(`method not found: ${method}`)
  error.rpcCode = -32601
  throw error
}

/** 跑一次 stdin 循环：换行分隔 JSON-RPC，串行处理保证写盘顺序。 */
function serve() {
  let buffer = ''
  let queue = Promise.resolve()

  const send = (payload) => {
    try {
      process.stdout.write(`${JSON.stringify(payload)}\n`)
    } catch {
      // 客户端已经走了。
    }
  }

  const handle = async (message) => {
    const id = Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : undefined
    const isNotification = id === undefined
    try {
      const result = await handleRequest(message)
      if (!isNotification) send({ jsonrpc: '2.0', id, result })
    } catch (caught) {
      if (isNotification) return
      send({
        jsonrpc: '2.0',
        id,
        error: { code: Number.isInteger(caught && caught.rpcCode) ? caught.rpcCode : -32603, message: messageOf(caught) },
      })
    }
  }

  const enqueue = (line) => {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    if (message === null || typeof message !== 'object' || typeof message.method !== 'string') {
      return
    }
    queue = queue.then(() => handle(message)).catch(() => undefined)
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      enqueue(line)
      index = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    if (buffer.trim() !== '') enqueue(buffer)
    void queue.then(() => process.exit(0))
  })

  // 客户端断开就退出，别留孤儿进程。
  process.stdout.on('error', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))
}

/** 离线自测：临时 DSH_HOME 里跑一遍工具面，不碰真实数据。 */
async function selfTest() {
  const home = await mkdtemp(join(tmpdir(), 'dsn-mcp-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const fails = []
  const check = (label, condition, detail) => {
    if (!condition) fails.push(`${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
    console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`)
  }
  const call = async (name, args) => {
    const tool = TOOL_MAP.get(name)
    if (!tool) throw new Error(`unknown tool: ${name}`)
    // 与 handleRequest 一致：业务异常变成 isError 结果，而不是抛给调用方。
    try {
      return await tool.run(args || {})
    } catch (caught) {
      return failed(messageOf(caught))
    }
  }

  try {
    check('tools/list has tools', TOOLS.length >= 8, TOOLS.length)

    let result = await call('notes_list', {})
    check('list starts empty', result.content[0].text.includes('"matched": 0'), result)

    result = await call('notes_create', { title: '买牛奶', body: '- [ ] 两盒\n- [x] 鸡蛋' })
    const created = JSON.parse(result.content[0].text)
    check('create returns id', typeof created.id === 'string' && created.id.length > 0, created)

    result = await call('notes_get', { id: created.id })
    check('get returns body', result.content[0].text.includes('两盒'), result)

    result = await call('notes_update', { id: created.id, body: '\n- [ ] 面包', mode: 'append' })
    check('append keeps old body', result.content[0].text.includes('两盒') && result.content[0].text.includes('面包'), result)

    result = await call('notes_update', { id: created.id, title: '购物清单' })
    check('update title', result.content[0].text.includes('购物清单'), result)

    result = await call('notes_update', { id: created.id, pinned: true })
    check('pin toggles on', JSON.parse(result.content[0].text).pinned === true, result)

    result = await call('notes_list', {})
    check('list reports pinned', JSON.parse(result.content[0].text).items[0].pinned === true, result)

    result = await call('notes_list', { query: '面包' })
    check('search finds note', JSON.parse(result.content[0].text).matched === 1, result)

    result = await call('notes_delete', { id: created.id })
    check('delete moves to trash', result.content[0].text.includes('"trashCount": 1'), result)

    result = await call('notes_trash_list', {})
    check('trash lists entry', JSON.parse(result.content[0].text).total === 1, result)

    result = await call('notes_restore', { id: created.id })
    check('restore brings it back', JSON.parse(result.content[0].text).restored === true, result)

    await call('notes_delete', { id: created.id })
    result = await call('notes_purge', { id: created.id, confirm: false })
    check('purge needs confirm', result.isError === true, result)

    result = await call('notes_purge', { id: created.id, confirm: true })
    check('purge removes entry', result.content[0].text.includes('"purged": true'), result)

    result = await call('notes_empty_trash', { confirm: true })
    check('empty trash ok', result.isError !== true, result)

    result = await call('notes_get', { id: created.id })
    check('missing note is a tool error', result.isError === true, result)

    result = await call('notes_create', { color: 'chartreuse' })
    check('unknown color falls back', JSON.parse(result.content[0].text).color === PAPER_IDS[0], result)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }

  if (fails.length > 0) {
    console.error(fails.join('\n'))
    process.exitCode = 1
    return
  }
  console.log('mcp self-test OK')
}

/** 被别的模块 import 时只导出工具清单，不接管 stdin/stdout。 */
const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntry) {
  if (process.argv.includes('--self-test')) {
    await selfTest()
  } else if (process.argv.includes('--dump-tools')) {
    // 给测试/排障用：把工具清单原样打出来，不启动协议循环。
    process.stdout.write(
      `${JSON.stringify(
        TOOLS.map(({ name: toolName, description, inputSchema }) => ({ name: toolName, description, inputSchema })),
        null,
        2,
      )}\n`,
    )
  } else if (process.argv.includes('--help')) {
    process.stdout.write(
      [
        'dsh-sticky-notes MCP server (stdio)',
        '',
        '  node mcp.js                 speak MCP over stdin/stdout',
        '  node mcp.js --self-test     run the offline tool self-test',
        '  node mcp.js --dump-tools    print the tool list as JSON',
        '',
        'Env: DSH_HOME  DSH home directory (default ~/.dsh)',
        '',
      ].join('\n'),
    )
  } else {
    serve()
  }
}

export { TOOLS }
