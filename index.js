import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Cordis 插件的诊断名；与 patch 里的 id 保持一致便于排查。 */
const name = 'dsh-sticky-notes'
/** `webServer` 提供 HTTP 路由能力。 */
const inject = ['webServer']

const API_PREFIX = '/api/dsh-sticky-notes'
const STATE_PATH = `${API_PREFIX}/state`
const CONFIG_PATH = `${API_PREFIX}/config`
const NOTES_PATH = `${API_PREFIX}/notes`
const TRASH_PATH = `${API_PREFIX}/trash`
const ASSETS_PATH = `${API_PREFIX}/assets`
/** 写请求必须带的自定义头：跨站 fetch 因此被迫走预检，而本路由不回 CORS。 */
const CLIENT_MARKER_HEADER = 'x-dsh-sticky-notes'
const MAX_NOTES = 200
const MAX_TITLE = 200
const MAX_NOTE_BODY = 20000
const MAX_ID = 128
/** 回收站：最多留 30 条、30 天。 */
const MAX_TRASH = 30
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 写前快照份数：每次写盘前把上一份轮转成 notes.bak.1..N。 */
const SNAPSHOT_COUNT = 3
/**
 * 整份覆盖（导入/兼容）的请求体上限必须能装下最坏情况：200 条 × 20000 字，
 * 中文按 UTF-8 3 字节、加上转义与字段名约 12MB，取 16MB 留余量。
 * 单条接口只按一条计算，远小于这个值。
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_ASSET_BYTES = 8 * 1024 * 1024
/** 卡片手动调整后的尺寸（像素），只接受这个区间内的整数。 */
const MIN_CARD_WIDTH = 220
const MAX_CARD_WIDTH = 720
const MIN_CARD_HEIGHT = 180
const MAX_CARD_HEIGHT = 720
/** 便签纸配色白名单，与 client.js 的 PAPERS、CSS 的 dsn-palette 三处一致。 */
const PAPER_COLORS = new Set(['pink', 'yellow', 'mint', 'sky', 'violet'])
/** 便签 id 同时出现在 URL 路径里，先卡死字符集再拼路径。 */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const ASSET_PATTERN = /^[a-z0-9]{6,64}\.(png|jpg|gif|webp)$/
const ASSET_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
const ASSET_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

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

function json(res, code, payload, headOnly = false) {
  if (!res || res.writableEnded || res.destroyed) return
  res.once('error', () => undefined)
  try {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    // HEAD 返回与实体一致的 content-length，但不输出 body。
    res.end(headOnly ? undefined : body)
  } catch {
    // 客户端已断开。
  }
}

function fail(res, caught) {
  const statusCode = Number.isInteger(caught && caught.statusCode) ? caught.statusCode : 500
  json(res, statusCode, {
    ok: false,
    ...(caught && typeof caught.code === 'string' ? { code: caught.code } : {}),
    error: messageOf(caught),
  })
}

/** 版本号对不上时把服务端现状整份回给客户端，让它自行合并。 */
function conflict(res, doc) {
  json(res, 409, {
    ok: false,
    code: 'error.state.conflict',
    error: 'state version mismatch',
    data: { version: doc.version, notes: doc.notes, savedAt: Date.now() },
  })
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    const failWith = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        failWith(coded(413, 'error.proto.bodyTooLarge', 'body too large'))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (caught) => {
      const error = caught instanceof Error ? caught : new Error(String(caught))
      if (error.statusCode === undefined) error.statusCode = 400
      failWith(error)
    })
  })
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const raw = await readRawBody(req, limit)
  try {
    const text = raw.toString('utf8')
    const parsed = text === '' ? {} : JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw coded(400, 'error.proto.invalidBody', '请求体必须是 JSON 对象')
    }
    return parsed
  } catch (caught) {
    if (caught && Number.isInteger(caught.statusCode)) throw caught
    throw coded(400, 'error.proto.invalidJson', `invalid JSON body: ${messageOf(caught)}`)
  }
}

/** 将裸 `host[:port]` 解析为 URL；非法形态返回 undefined。 */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** 用 http/https 双重解析保留显式的 :80 / :443，避免默认端口被剥离后扩大授权范围。 */
function canonicalAuthority(authority, parsed) {
  const port = parsed.port !== '' ? parsed.port : new URL(`https://${authority}`).port
  return port === '' ? parsed.hostname : `${parsed.hostname}:${port}`
}

function isCanonicalAuthority(authority, parsed) {
  return canonicalAuthority(authority, parsed) === authority.toLowerCase()
}

/** 与 DSH `/api` 信任栅栏一致：localhost、IPv6 loopback 或 IPv4 127/8。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** 带端口的 trustedHosts 条目精确匹配；不带端口的条目匹配同主机的任意端口。 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    if (typeof entry !== 'string') return false
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined || !isCanonicalAuthority(entry, entryUrl)) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** 未知 Host、跨站 Fetch 或异源 Origin 一律拒绝，避免被任意网页读走便签内容。 */
function validateRequestOrigin(req, trustedHosts) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  const hostUrl = parseAuthority(host)
  const forbidden = { statusCode: 403, code: 'error.proto.forbiddenHost', error: 'forbidden host' }
  if (hostUrl === undefined || !isCanonicalAuthority(host, hostUrl)) return forbidden
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return forbidden
  if (req.headers['sec-fetch-site'] === 'cross-site') return forbidden
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).host !== hostUrl.host) return forbidden
    } catch {
      return forbidden
    }
  }
  return null
}

/** 写接口额外要求自定义头与 JSON：自定义头迫使跨站 fetch 走预检，而本路由不回 CORS。 */
function validateMutationRequest(req, trustedHosts) {
  const hostError = validateRequestOrigin(req, trustedHosts)
  if (hostError !== null) return hostError
  if (req.headers[CLIENT_MARKER_HEADER] !== '1') {
    return { statusCode: 403, code: 'error.proto.forbidden', error: 'forbidden mutation request' }
  }
  const contentType = String(req.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (contentType !== 'application/json') {
    return { statusCode: 415, code: 'error.proto.contentType', error: 'content-type must be application/json' }
  }
  return null
}

/** DELETE 与图片上传没有 JSON 体，只校验来源与自定义头。 */
function validateMutationMarker(req, trustedHosts) {
  const hostError = validateRequestOrigin(req, trustedHosts)
  if (hostError !== null) return hostError
  if (req.headers[CLIENT_MARKER_HEADER] !== '1') {
    return { statusCode: 403, code: 'error.proto.forbidden', error: 'forbidden mutation request' }
  }
  return null
}

/** 从 `root.webRuntime` / `root.webStartup` 里尽量取到 LAN 信任列表，取不到就只信 loopback。 */
function trustedHostsOf(ctx) {
  try {
    const raw = ctx ?? {}
    const root = raw.root ?? raw
    const candidate = root.webRuntime ?? root.webStartup
    if (candidate !== null && typeof candidate === 'object') {
      const hosts = candidate.trustedHosts
      if (Array.isArray(hosts)) return hosts.filter((item) => typeof item === 'string')
    }
  } catch {
    // 宿主结构随版本变化，失败时降级到 loopback。
  }
  return []
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

/** 运行期的数据目录缓存：每次保存都读一次配置文件太浪费。 */
let dataDirCache = null

async function resolveDataDir() {
  if (dataDirCache !== null) return dataDirCache
  dataDirCache = (await readConfigDir()) || defaultDataDir()
  return dataDirCache
}

function forgetDataDir() {
  dataDirCache = null
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

/**
 * 读-改-写必须串行：两个请求同时进来时，后一个要看到前一个的结果，
 * 否则后写的那份会把先写的改动整份盖掉。
 */
let writeQueue = Promise.resolve()
function serialized(task) {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function notAllowed(res, method) {
  json(res, 405, {
    ok: false,
    code: 'error.proto.method',
    error: `method not allowed: ${method || 'unknown'}`,
  })
}

async function handleState(req, res, trustedHosts) {
  const filePath = await stateFilePath()
  if (req.method === 'GET' || req.method === 'HEAD') {
    const doc = await readDoc(filePath)
    const data = { notes: doc.notes, version: doc.version, trashCount: doc.trash.length, savedAt: Date.now() }
    if (doc.recovered) {
      data.recovered = true
      data.backup = doc.backup || ''
    }
    json(res, 200, { ok: true, data }, req.method === 'HEAD')
    return
  }
  if (req.method !== 'PUT' && req.method !== 'POST') {
    notAllowed(res, req.method)
    return
  }
  const requestError = validateMutationRequest(req, trustedHosts)
  if (requestError !== null) {
    json(res, requestError.statusCode, { ok: false, code: requestError.code, error: requestError.error })
    return
  }
  const body = await readBody(req)
  const notes = sanitizeNotes(body)
  const baseVersion = Number.isFinite(body.baseVersion) ? body.baseVersion : null
  const result = await serialized(async () => {
    const doc = await readDoc(filePath)
    if (baseVersion !== null && baseVersion !== doc.version) return { conflict: doc }
    const version = doc.version + 1
    // 整份覆盖（导入）不动回收站。
    await writeDoc(filePath, { version, notes, trash: doc.trash })
    return { version }
  })
  if (result.conflict) {
    conflict(res, result.conflict)
    return
  }
  json(res, 200, { ok: true, data: { version: result.version, notes, savedAt: Date.now() } })
}

async function handleNote(req, res, rawId, url, trustedHosts) {
  let id
  try {
    id = decodeURIComponent(rawId)
  } catch {
    json(res, 400, { ok: false, code: 'error.proto.invalidId', error: 'invalid note id' })
    return
  }
  if (!ID_PATTERN.test(id)) {
    json(res, 400, { ok: false, code: 'error.proto.invalidId', error: 'invalid note id' })
    return
  }
  const filePath = await stateFilePath()

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const requestError = validateMutationRequest(req, trustedHosts)
    if (requestError !== null) {
      json(res, requestError.statusCode, { ok: false, code: requestError.code, error: requestError.error })
      return
    }
    const body = await readBody(req)
    const note = sanitizeNote(Object.assign({}, body.note || {}, { id }), id)
    const baseVersion = Number.isFinite(body.baseVersion) ? body.baseVersion : null
    const result = await serialized(async () => {
      const doc = await readDoc(filePath)
      if (baseVersion !== null && baseVersion !== doc.version) return { conflict: doc }
      const index = doc.notes.findIndex((item) => item.id === id)
      let notes
      if (index >= 0) {
        notes = doc.notes.slice()
        notes[index] = note
      } else {
        if (doc.notes.length >= MAX_NOTES) return { tooMany: true }
        notes = [note, ...doc.notes]
      }
      const version = doc.version + 1
      // 同 id 的回收站条目一并清掉：撤销删除 / 重建会走这条路，避免回收站里留重复。
      const trash = doc.trash.filter((item) => item.id !== id)
      await writeDoc(filePath, { version, notes, trash })
      return { version }
    })
    if (result.conflict) {
      conflict(res, result.conflict)
      return
    }
    if (result.tooMany) {
      json(res, 400, { ok: false, code: 'error.proto.tooManyNotes', error: `at most ${MAX_NOTES} notes` })
      return
    }
    json(res, 200, { ok: true, data: { version: result.version, note } })
    return
  }

  if (req.method === 'DELETE') {
    const markerError = validateMutationMarker(req, trustedHosts)
    if (markerError !== null) {
      json(res, markerError.statusCode, { ok: false, code: markerError.code, error: markerError.error })
      return
    }
    const queryVersion = Number(url.searchParams.get('baseVersion'))
    const baseVersion = Number.isFinite(queryVersion) && url.searchParams.get('baseVersion') !== null ? queryVersion : null
    const result = await serialized(async () => {
      const doc = await readDoc(filePath)
      if (baseVersion !== null && baseVersion !== doc.version) return { conflict: doc }
      const note = doc.notes.find((item) => item.id === id)
      if (!note) return { version: doc.version, removed: false }
      const notes = doc.notes.filter((item) => item.id !== id)
      const trash = [Object.assign({}, note, { deletedAt: Date.now() }), ...doc.trash].slice(0, MAX_TRASH)
      const version = doc.version + 1
      await writeDoc(filePath, { version, notes, trash })
      return { version, removed: true, trashCount: trash.length }
    })
    if (result.conflict) {
      conflict(res, result.conflict)
      return
    }
    json(res, 200, {
      ok: true,
      data: { version: result.version, removed: result.removed, trashCount: result.trashCount || 0 },
    })
    return
  }

  notAllowed(res, req.method)
}

/** 回收站列表 / 清空。 */
async function handleTrash(req, res, trustedHosts) {
  const filePath = await stateFilePath()
  if (req.method === 'GET' || req.method === 'HEAD') {
    const doc = await readDoc(filePath)
    json(res, 200, { ok: true, data: { entries: doc.trash, version: doc.version } }, req.method === 'HEAD')
    return
  }
  if (req.method === 'DELETE') {
    const markerError = validateMutationMarker(req, trustedHosts)
    if (markerError !== null) {
      json(res, markerError.statusCode, { ok: false, code: markerError.code, error: markerError.error })
      return
    }
    const result = await serialized(async () => {
      const doc = await readDoc(filePath)
      if (doc.trash.length === 0) return { version: doc.version, purged: 0 }
      const version = doc.version + 1
      await writeDoc(filePath, { version, notes: doc.notes, trash: [] })
      return { version, purged: doc.trash.length }
    })
    json(res, 200, { ok: true, data: { version: result.version, purged: result.purged, trashCount: 0 } })
    return
  }
  notAllowed(res, req.method)
}

/** 单条回收站操作：`POST …/trash/:id/restore` 还原，`DELETE …/trash/:id` 彻底删除。 */
async function handleTrashItem(req, res, rawRest, trustedHosts) {
  const segments = rawRest.split('/')
  let id
  try {
    id = decodeURIComponent(segments[0] || '')
  } catch {
    json(res, 400, { ok: false, code: 'error.proto.invalidId', error: 'invalid note id' })
    return
  }
  if (!ID_PATTERN.test(id)) {
    json(res, 400, { ok: false, code: 'error.proto.invalidId', error: 'invalid note id' })
    return
  }
  const filePath = await stateFilePath()
  const restoring = segments[1] === 'restore'

  if (restoring) {
    if (req.method !== 'POST') {
      notAllowed(res, req.method)
      return
    }
    const requestError = validateMutationRequest(req, trustedHosts)
    if (requestError !== null) {
      json(res, requestError.statusCode, { ok: false, code: requestError.code, error: requestError.error })
      return
    }
    await readBody(req)
    const result = await serialized(async () => {
      const doc = await readDoc(filePath)
      const entry = doc.trash.find((item) => item.id === id)
      if (!entry) return { version: doc.version, restored: false, trashCount: doc.trash.length }
      if (doc.notes.length >= MAX_NOTES) return { tooMany: true }
      const note = Object.assign({}, entry)
      delete note.deletedAt
      const trash = doc.trash.filter((item) => item.id !== id)
      const version = doc.version + 1
      await writeDoc(filePath, { version, notes: [note, ...doc.notes], trash })
      return { version, restored: true, trashCount: trash.length }
    })
    if (result.tooMany) {
      json(res, 400, { ok: false, code: 'error.proto.tooManyNotes', error: `at most ${MAX_NOTES} notes` })
      return
    }
    json(res, 200, {
      ok: true,
      data: { version: result.version, restored: result.restored, trashCount: result.trashCount },
    })
    return
  }

  if (req.method !== 'DELETE') {
    notAllowed(res, req.method)
    return
  }
  const markerError = validateMutationMarker(req, trustedHosts)
  if (markerError !== null) {
    json(res, markerError.statusCode, { ok: false, code: markerError.code, error: markerError.error })
    return
  }
  const result = await serialized(async () => {
    const doc = await readDoc(filePath)
    const trash = doc.trash.filter((item) => item.id !== id)
    if (trash.length === doc.trash.length) return { version: doc.version, purged: 0, trashCount: trash.length }
    const version = doc.version + 1
    await writeDoc(filePath, { version, notes: doc.notes, trash })
    return { version, purged: 1, trashCount: trash.length }
  })
  json(res, 200, {
    ok: true,
    data: { version: result.version, purged: result.purged, trashCount: result.trashCount },
  })
}

async function handleAssetUpload(req, res, trustedHosts) {
  if (req.method !== 'POST') {
    notAllowed(res, req.method)
    return
  }
  const markerError = validateMutationMarker(req, trustedHosts)
  if (markerError !== null) {
    json(res, markerError.statusCode, { ok: false, code: markerError.code, error: markerError.error })
    return
  }
  const contentType = String(req.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  const extension = ASSET_EXTENSIONS[contentType]
  if (!extension) {
    json(res, 415, { ok: false, code: 'error.proto.contentType', error: 'unsupported image type' })
    return
  }
  const buffer = await readRawBody(req, MAX_ASSET_BYTES)
  if (buffer.length === 0) {
    json(res, 400, { ok: false, code: 'error.proto.invalidBody', error: 'empty image' })
    return
  }
  const fileName = `${randomUUID().replace(/-/g, '').slice(0, 24)}.${extension}`
  const dir = await assetsDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, fileName), buffer, { mode: 0o600 })
  // 正文里只存相对路径，随端口/子路径变化也不失效。
  json(res, 200, { ok: true, data: { url: `assets/${fileName}`, size: buffer.length } })
}

async function handleAssetGet(req, res, rawName) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    notAllowed(res, req.method)
    return
  }
  let assetName
  try {
    assetName = decodeURIComponent(rawName)
  } catch {
    json(res, 400, { ok: false, code: 'error.proto.invalidId', error: 'invalid asset name' })
    return
  }
  if (!ASSET_PATTERN.test(assetName)) {
    json(res, 400, { ok: false, code: 'error.proto.invalidId', error: 'invalid asset name' })
    return
  }
  const extension = assetName.split('.').pop()
  let buffer
  try {
    buffer = await readFile(join(await assetsDir(), assetName))
  } catch (caught) {
    if (caught && caught.code === 'ENOENT') {
      json(res, 404, { ok: false, code: 'error.proto.notFound', error: 'asset not found' })
      return
    }
    throw caught
  }
  if (!res || res.writableEnded || res.destroyed) return
  res.once('error', () => undefined)
  res.writeHead(200, {
    'content-type': ASSET_TYPES[extension] || 'application/octet-stream',
    'content-length': buffer.length,
    'cache-control': 'private, max-age=31536000, immutable',
  })
  res.end(req.method === 'HEAD' ? undefined : buffer)
}

/** 读取当前存放目录。 */
async function handleConfigGet(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    notAllowed(res, req.method)
    return
  }
  const custom = await readConfigDir()
  json(
    res,
    200,
    { ok: true, data: { dir: await resolveDataDir(), defaultDir: defaultDataDir(), custom: Boolean(custom) } },
    req.method === 'HEAD',
  )
}

/** 切换存放目录：先迁移数据，成功后才落配置。 */
async function handleConfigSet(req, res, trustedHosts) {
  if (req.method !== 'POST' && req.method !== 'PUT') {
    notAllowed(res, req.method)
    return
  }
  const requestError = validateMutationRequest(req, trustedHosts)
  if (requestError !== null) {
    json(res, requestError.statusCode, { ok: false, code: requestError.code, error: requestError.error })
    return
  }
  const body = await readBody(req)
  const raw = body.dir
  const wantsDefault = raw === null || raw === undefined || raw === ''
  const target = wantsDefault ? null : normalizeDir(raw)
  if (!wantsDefault && target === null) {
    json(res, 400, { ok: false, code: 'error.proto.invalidPath', error: 'dir must be an absolute path' })
    return
  }
  const from = await resolveDataDir()
  const to = target || defaultDataDir()
  const result = await serialized(async () => {
    const stats = await migrateData(from, to)
    await writeConfigDir(target)
    return stats
  })
  forgetDataDir()
  const dir = await resolveDataDir()
  json(res, 200, {
    ok: true,
    data: { dir, defaultDir: defaultDataDir(), custom: Boolean(target), ...result },
  })
}

function apply(ctx) {
  // Cordis 不会收集 apply 返回的 disposer，必须用 ctx.effect 显式托管生命周期。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const pathname = url.pathname.replace(/\/+$/, '')
          try {
            const trustedHosts = trustedHostsOf(ctx)
            const hostError = validateRequestOrigin(req, trustedHosts)
            if (hostError !== null) {
              json(res, hostError.statusCode, { ok: false, code: hostError.code, error: hostError.error })
              return
            }
            if (pathname === STATE_PATH) {
              await handleState(req, res, trustedHosts)
              return
            }
            if (pathname === CONFIG_PATH) {
              if (req.method === 'GET' || req.method === 'HEAD') await handleConfigGet(req, res)
              else await handleConfigSet(req, res, trustedHosts)
              return
            }
            if (pathname.startsWith(`${NOTES_PATH}/`)) {
              await handleNote(req, res, pathname.slice(NOTES_PATH.length + 1), url, trustedHosts)
              return
            }
            if (pathname === TRASH_PATH) {
              await handleTrash(req, res, trustedHosts)
              return
            }
            if (pathname.startsWith(`${TRASH_PATH}/`)) {
              await handleTrashItem(req, res, pathname.slice(TRASH_PATH.length + 1), trustedHosts)
              return
            }
            if (pathname === ASSETS_PATH) {
              await handleAssetUpload(req, res, trustedHosts)
              return
            }
            if (pathname.startsWith(`${ASSETS_PATH}/`)) {
              await handleAssetGet(req, res, pathname.slice(ASSETS_PATH.length + 1))
              return
            }
            json(res, 404, {
              ok: false,
              code: 'error.proto.unknownAction',
              error: `unknown action: ${pathname}`,
            })
          } catch (caught) {
            fail(res, caught)
          }
        },
      }),
    'dsh-sticky-notes: state route',
  )
}

export { apply, inject, name }
