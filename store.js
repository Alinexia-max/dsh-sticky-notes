/**
 * 便签数据层：目录解析、读写、版本号、字段清洗、跨进程写锁与高层操作。
 *
 * 这一层同时被两个宿主复用：
 * - `index.js`（Cordis 插件的 Host 半边，提供 HTTP 路由与原生工具）
 * - `mcp.js`（独立 stdio 进程，供 DSH / Cursor / Claude Desktop 等 MCP 客户端）
 *
 * 因此只允许依赖 node 内置模块：插件保持零运行时依赖，任何一个进程都能直接跑。
 */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const MAX_NOTES = 200
const MAX_TITLE = 200
const MAX_NOTE_BODY = 20000
const MAX_ID = 128
/** 回收站：最多留 30 条、30 天。 */
const MAX_TRASH = 30
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 写前快照份数：每次写盘前把上一份轮转成 notes.bak.1..N。 */
const SNAPSHOT_COUNT = 3
/** 卡片手动调整后的尺寸（像素），只接受这个区间内的整数。 */
const MIN_CARD_WIDTH = 220
const MAX_CARD_WIDTH = 720
const MIN_CARD_HEIGHT = 180
const MAX_CARD_HEIGHT = 720
/** 便签纸配色白名单，与 client.js 的 PAPERS、CSS 的 dsn-palette 三处一致。 */
const PAPER_COLORS = new Set(['pink', 'yellow', 'mint', 'sky', 'violet'])
const PAPER_IDS = ['pink', 'yellow', 'mint', 'sky', 'violet']
/** 便签 id 同时出现在 URL 路径里，先卡死字符集再拼路径。 */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const ASSET_PATTERN = /^[a-z0-9]{6,64}\.(png|jpg|gif|webp)$/

/** 跨进程写锁：面板与 MCP 进程共用同一份数据文件，必须串行。 */
const LOCK_NAME = '.notes.lock'
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 10000

function coded(statusCode, code, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function messageOf(caught) {
  if (caught instanceof Error) return caught.message
  if (typeof caught === 'string') return caught
  try {
    return JSON.stringify(caught)
  } catch {
    return String(caught)
  }
}

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 默认数据目录：`<DSH_HOME>/sticky-notes`。 */
function defaultDataDir() {
  return join(resolveDshHome(), 'sticky-notes')
}

/**
 * 存放目录的配置固定留在 DSH_HOME 下，跟着数据目录跑就没法「搬走」了。
 * 文件内容形如 `{ "dir": "D:\\Notes\\Sticky" }`，`dir: null` 表示用默认目录。
 */
function configFilePath() {
  return join(defaultDataDir(), 'config.json')
}

/** 只接受绝对路径；相对路径会跟着进程工作目录漂，不能存。 */
function normalizeDir(input) {
  if (typeof input !== 'string') return null
  const value = input.trim().replace(/^"(.*)"$/, '$1')
  if (value === '') return null
  if (!isAbsolute(value)) return null
  return resolve(value)
}

async function readConfigDir() {
  try {
    const parsed = JSON.parse(await readFile(configFilePath(), 'utf8'))
    return normalizeDir(parsed && parsed.dir)
  } catch {
    return null
  }
}

async function writeConfigDir(dir) {
  const file = configFilePath()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ dir: dir || null }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * 数据目录：每次都读一次配置文件。
 * 不做缓存是有意为之——MCP 进程可能长期存活，切换目录后必须立刻跟上。
 */
async function resolveDataDir() {
  return (await readConfigDir()) || defaultDataDir()
}

async function stateFilePath() {
  return join(await resolveDataDir(), 'notes.json')
}

async function assetsDir() {
  return join(await resolveDataDir(), 'assets')
}

async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * 切换目录时把老数据带过去：复制 notes.json 与 assets/，目标已有 notes.json 就不覆盖。
 * 复制完成后把老 notes.json 改名留档，避免切回去时读到一份过期数据。
 */
async function migrateData(fromDir, toDir) {
  const stats = { notes: 0, assets: 0, skipped: false }
  if (resolve(fromDir) === resolve(toDir)) {
    stats.skipped = true
    return stats
  }
  const fromNotes = join(fromDir, 'notes.json')
  const toNotes = join(toDir, 'notes.json')
  if (!(await pathExists(fromNotes))) return stats
  if (await pathExists(toNotes)) {
    stats.skipped = true
    return stats
  }
  await mkdir(toDir, { recursive: true })
  await copyFile(fromNotes, toNotes)
  try {
    const parsed = JSON.parse(await readFile(toNotes, 'utf8'))
    stats.notes = Array.isArray(parsed && parsed.notes) ? parsed.notes.length : 0
  } catch {
    stats.notes = 0
  }
  const fromAssets = join(fromDir, 'assets')
  const toAssets = join(toDir, 'assets')
  try {
    const names = await readdir(fromAssets)
    if (names.length > 0) await mkdir(toAssets, { recursive: true })
    for (const name of names) {
      if (!ASSET_PATTERN.test(name)) continue
      await copyFile(join(fromAssets, name), join(toAssets, name))
      stats.assets += 1
    }
  } catch {
    // 没有图片目录，跳过。
  }
  await rename(fromNotes, join(fromDir, `notes.migrated-${Date.now().toString(36)}.json`)).catch(() => undefined)
  return stats
}

function clampSize(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 收窄单条便签：字段类型、长度、取值范围都在这里兜住。 */
function sanitizeNote(raw, fallbackId) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw coded(400, 'error.proto.invalidNote', 'note must be an object')
  }
  const now = Date.now()
  const title = typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE) : ''
  const body = typeof raw.body === 'string' ? raw.body.slice(0, MAX_NOTE_BODY) : ''
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
  const rawId = typeof raw.id === 'string' && raw.id !== '' ? raw.id : fallbackId
  const id = typeof rawId === 'string' && rawId !== '' ? rawId.slice(0, MAX_ID) : randomUUID()
  const color = typeof raw.color === 'string' && PAPER_COLORS.has(raw.color) ? raw.color : ''
  const note = { id, title, body, color, createdAt, updatedAt }
  // 卡片尺寸与手动排序位置都是可选的：老数据没有就当没设置。
  if (Number.isFinite(raw.width)) note.width = clampSize(raw.width, MIN_CARD_WIDTH, MAX_CARD_WIDTH)
  if (Number.isFinite(raw.height)) note.height = clampSize(raw.height, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT)
  if (Number.isFinite(raw.order)) note.order = raw.order
  return note
}

/** 整份覆盖入口（导入/兼容）。 */
function sanitizeNotes(input) {
  const list = input !== null && typeof input === 'object' && Array.isArray(input.notes) ? input.notes : null
  if (list === null) throw coded(400, 'error.proto.invalidBody', 'notes must be an array')
  if (list.length > MAX_NOTES) throw coded(400, 'error.proto.tooManyNotes', `at most ${MAX_NOTES} notes`)
  return list.map((raw) => sanitizeNote(raw))
}

/** 回收站条目 = 便签本体 + deletedAt；过期和超量的直接丢掉。 */
function sanitizeTrash(input) {
  if (!Array.isArray(input)) return []
  const now = Date.now()
  const seen = new Set()
  const entries = []
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue
    let note
    try {
      note = sanitizeNote(raw)
    } catch {
      continue
    }
    if (seen.has(note.id)) continue
    seen.add(note.id)
    const deletedAt = Number.isFinite(raw.deletedAt) ? raw.deletedAt : now
    if (now - deletedAt > TRASH_TTL_MS) continue
    entries.push(Object.assign({}, note, { deletedAt }))
  }
  return entries.slice(0, MAX_TRASH)
}

/** 数据文件坏掉时先留档再重置，避免插件永久卡在「加载失败」。 */
async function backupCorrupt(filePath) {
  const backup = join(dirname(filePath), `notes.corrupt-${Date.now().toString(36)}.json`)
  try {
    await rename(filePath, backup)
    return backup
  } catch {
    return ''
  }
}

async function readDoc(filePath) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (caught) {
    if (caught && caught.code === 'ENOENT') return { version: 0, notes: [], trash: [] }
    throw caught
  }
  try {
    const parsed = JSON.parse(raw)
    return {
      version: Number.isFinite(parsed && parsed.version) ? parsed.version : 0,
      notes: sanitizeNotes(parsed),
      trash: sanitizeTrash(parsed && parsed.trash),
    }
  } catch {
    const backup = await backupCorrupt(filePath)
    return { version: 0, notes: [], trash: [], recovered: true, backup }
  }
}

/** 写盘前把上一份文件轮转成 notes.bak.1..N，坏文件/误改还有得回。 */
async function rotateSnapshots(filePath) {
  const dir = dirname(filePath)
  const snapshot = (index) => join(dir, `notes.bak.${index}.json`)
  await rm(snapshot(SNAPSHOT_COUNT), { force: true })
  for (let index = SNAPSHOT_COUNT - 1; index >= 1; index -= 1) {
    await rename(snapshot(index), snapshot(index + 1)).catch(() => undefined)
  }
  await copyFile(filePath, snapshot(1)).catch(() => undefined)
}

/** 原子写：先轮转快照、落临时文件，再 rename，避免写到一半留下半个 JSON。 */
async function writeDoc(filePath, doc) {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  await rotateSnapshots(filePath)
  const tmp = join(dir, `.notes.${process.pid}.${Date.now().toString(36)}.tmp`)
  const payload = `${JSON.stringify({ version: doc.version, notes: doc.notes, trash: doc.trash || [] }, null, 2)}\n`
  await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tmp, filePath)
  } catch (caught) {
    await rm(tmp, { force: true })
    throw caught
  }
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

/** 锁文件超过这个时间没更新，就认为持有者已经死了。 */
async function isStaleLock(file) {
  try {
    const info = await stat(file)
    return Date.now() - info.mtimeMs > LOCK_STALE_MS
  } catch {
    return false
  }
}

async function acquireLock(dir) {
  const file = join(dir, LOCK_NAME)
  await mkdir(dir, { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await open(file, 'wx', 0o600)
      try {
        await handle.writeFile(`${process.pid} ${Date.now()}\n`)
      } finally {
        await handle.close()
      }
      return file
    } catch (caught) {
      if (!caught || caught.code !== 'EEXIST') throw caught
      if (await isStaleLock(file)) {
        await rm(file, { force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw coded(503, 'error.state.busy', 'notes storage is locked by another process')
      }
      await delay(20)
    }
  }
}

async function releaseLock(file) {
  await rm(file, { force: true })
}

/**
 * 读-改-写必须串行，分两层：
 * 1. 进程内 Promise 队列，避免本进程的请求互相覆盖；
 * 2. 进程间文件锁，避免面板与 MCP 进程同时写盘。
 * 同一进程内允许重入（持锁期间再调用不会再抢一次锁）。
 */
let writeQueue = Promise.resolve()
let lockDepth = 0

function serialized(task) {
  const run = writeQueue.then(
    () => runLocked(task),
    () => runLocked(task),
  )
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function runLocked(task) {
  if (lockDepth > 0) return task()
  const lockFile = await acquireLock(await resolveDataDir())
  lockDepth += 1
  try {
    return await task()
  } finally {
    lockDepth -= 1
    await releaseLock(lockFile)
  }
}

/** 读一次当前状态（不加锁：写盘是 rename，读到的永远是完整文件）。 */
async function readState() {
  return readDoc(await stateFilePath())
}

/**
 * 读-改-写一件事：回调返回 `{ value, next }`，带 `next` 时会写盘并版本 +1。
 * HTTP 路由与 MCP 工具都走这里，保证两条入口的合并语义完全一致。
 */
async function withDoc(task) {
  return serialized(async () => {
    const filePath = await stateFilePath()
    const doc = await readDoc(filePath)
    const result = await task(doc)
    if (!result || !result.next) return result ? result.value : undefined
    const version = doc.version + 1
    await writeDoc(filePath, {
      version,
      notes: result.next.notes || doc.notes,
      trash: result.next.trash || doc.trash,
    })
    return Object.assign({ version }, result.value)
  })
}

function colorOf(note) {
  return note && PAPER_COLORS.has(note.color) ? note.color : ''
}

/** 列表/搜索：标题与正文都参与匹配，和面板里的搜索保持一致。 */
async function listNotes(options = {}) {
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, Math.floor(options.limit))) : 20
  const includeBody = options.includeBody === true
  const doc = await readState()
  const matched = query === ''
    ? doc.notes
    : doc.notes.filter((note) =>
        `${note.title}\n${note.body}`.toLowerCase().includes(query),
      )
  const items = matched.slice(0, limit).map((note) => {
    const item = {
      id: note.id,
      title: note.title,
      preview: note.body.replace(/\s+/g, ' ').trim().slice(0, 120),
      color: colorOf(note),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }
    if (includeBody) item.body = note.body
    return item
  })
  return { total: doc.notes.length, matched: matched.length, items }
}

async function getNote(id) {
  const doc = await readState()
  return doc.notes.find((note) => note.id === id) || null
}

async function createNote(input = {}) {
  const now = Date.now()
  const note = sanitizeNote({
    id: randomUUID(),
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
    color: PAPER_COLORS.has(input.color) ? input.color : PAPER_IDS[0],
    createdAt: now,
    updatedAt: now,
  })
  const result = await withDoc((doc) => {
    if (doc.notes.length >= MAX_NOTES) throw coded(400, 'error.proto.tooManyNotes', `at most ${MAX_NOTES} notes`)
    return { value: { note }, next: { notes: [note, ...doc.notes] } }
  })
  return result.note
}

/** 改一条便签：只覆盖传进来的字段，`mode: 'append'` 时把正文接在末尾。 */
async function updateNote(id, patch = {}) {
  const result = await withDoc((doc) => {
    const index = doc.notes.findIndex((note) => note.id === id)
    if (index < 0) throw coded(404, 'error.proto.notFound', `note not found: ${id}`)
    const current = doc.notes[index]
    const nextBody =
      typeof patch.body === 'string'
        ? patch.mode === 'append'
          ? `${current.body}${patch.body}`
          : patch.body
        : current.body
    const note = sanitizeNote(
      {
        id: current.id,
        title: typeof patch.title === 'string' ? patch.title : current.title,
        body: nextBody,
        color: typeof patch.color === 'string' && PAPER_COLORS.has(patch.color) ? patch.color : current.color,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
        width: current.width,
        height: current.height,
        order: current.order,
      },
      current.id,
    )
    const notes = doc.notes.slice()
    notes[index] = note
    return { value: { note }, next: { notes } }
  })
  return result.note
}

/** 软删除：进回收站，和面板上的 × 完全同一套语义。 */
async function deleteNote(id) {
  return withDoc((doc) => {
    const note = doc.notes.find((item) => item.id === id)
    if (!note) return { value: { removed: false, trashCount: doc.trash.length } }
    const trash = [Object.assign({}, note, { deletedAt: Date.now() }), ...doc.trash].slice(0, MAX_TRASH)
    return {
      value: { removed: true, trashCount: trash.length },
      next: { notes: doc.notes.filter((item) => item.id !== id), trash },
    }
  })
}

async function listTrash() {
  const doc = await readState()
  return doc.trash
}

async function restoreNote(id) {
  return withDoc((doc) => {
    const entry = doc.trash.find((item) => item.id === id)
    if (!entry) throw coded(404, 'error.proto.notFound', `trash entry not found: ${id}`)
    if (doc.notes.length >= MAX_NOTES) throw coded(400, 'error.proto.tooManyNotes', `at most ${MAX_NOTES} notes`)
    const note = Object.assign({}, entry)
    delete note.deletedAt
    const trash = doc.trash.filter((item) => item.id !== id)
    return { value: { note, trashCount: trash.length }, next: { notes: [note, ...doc.notes], trash } }
  })
}

/** 彻底删除单条回收站条目。 */
async function purgeNote(id) {
  return withDoc((doc) => {
    const trash = doc.trash.filter((item) => item.id !== id)
    if (trash.length === doc.trash.length) {
      throw coded(404, 'error.proto.notFound', `trash entry not found: ${id}`)
    }
    return { value: { purged: true, trashCount: trash.length }, next: { trash } }
  })
}

async function emptyTrash() {
  return withDoc((doc) => {
    if (doc.trash.length === 0) return { value: { purged: 0, trashCount: 0 } }
    return { value: { purged: doc.trash.length, trashCount: 0 }, next: { trash: [] } }
  })
}

export {
  ASSET_PATTERN,
  ID_PATTERN,
  MAX_ID,
  MAX_NOTES,
  MAX_NOTE_BODY,
  MAX_TITLE,
  MAX_TRASH,
  PAPER_COLORS,
  PAPER_IDS,
  TRASH_TTL_MS,
  assetsDir,
  coded,
  configFilePath,
  createNote,
  defaultDataDir,
  deleteNote,
  emptyTrash,
  getNote,
  listNotes,
  listTrash,
  messageOf,
  migrateData,
  normalizeDir,
  purgeNote,
  readConfigDir,
  readDoc,
  readState,
  resolveDataDir,
  restoreNote,
  sanitizeNote,
  sanitizeNotes,
  sanitizeTrash,
  serialized,
  stateFilePath,
  updateNote,
  withDoc,
  writeConfigDir,
  writeDoc,
}
