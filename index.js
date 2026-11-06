import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ASSET_PATTERN,
  ID_PATTERN,
  MAX_NOTES,
  MAX_TRASH,
  PAPER_IDS,
  assetsDir,
  coded,
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
  resolveDataDir,
  restoreNote,
  sanitizeNote,
  sanitizeNotes,
  serialized,
  stateFilePath,
  updateNote,
  writeConfigDir,
  writeDoc,
} from './store.js'

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
/**
 * 整份覆盖（导入/兼容）的请求体上限必须能装下最坏情况：200 条 × 20000 字，
 * 中文按 UTF-8 3 字节、加上转义与字段名约 12MB，取 16MB 留余量。
 * 单条接口只按一条计算，远小于这个值。
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_ASSET_BYTES = 8 * 1024 * 1024
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
  const dir = await resolveDataDir()
  json(res, 200, {
    ok: true,
    data: { dir, defaultDir: defaultDataDir(), custom: Boolean(target), ...result },
  })
}

/** 工具返回给模型的内容：统一是一段 JSON 文本。 */
const jsonText = (value) => ({ type: 'text', text: JSON.stringify(value, null, 2) })

/**
 * 原生工具面：让 DSH 的模型不配 MCP 也能直接读写便签。
 *
 * 这些定义是普通的鸭子类型对象（`ctx.tools.register` 只读 name / description /
 * parameters / output / execute），所以插件不必 import `@deepseek-ai/dsh-tools`，
 * 也就不需要额外的运行时依赖。
 */
function notesTools() {
  // 每个工具各自一份 output：注册表可能冻结/包装定义，别让多个工具共享同一个对象。
  const makeOutput = () => ({ schema: { type: 'string' }, render: (_args, value) => [jsonText(value)] })
  const idSchema = { type: 'string', description: 'Note id returned by notes_list.' }
  return [
    {
      name: 'notes_list',
      description:
        'List sticky notes, newest first. Supports a keyword filter over title and body. Call this first to discover note ids.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive keyword matched against title and body.' },
          limit: { type: 'integer', description: 'Maximum notes to return, 1-200 (default 20).' },
          includeBody: { type: 'boolean', description: 'Include the full body of every returned note.' },
        },
        additionalProperties: false,
      },
      output: makeOutput(),
      isConcurrencySafe: () => true,
      async execute(args) {
        return JSON.stringify(await listNotes(args && typeof args === 'object' ? args : {}))
      },
    },
    {
      name: 'notes_get',
      description: 'Read one sticky note by id, including its full body.',
      parameters: {
        type: 'object',
        properties: { id: idSchema },
        required: ['id'],
        additionalProperties: false,
      },
      output: makeOutput(),
      isConcurrencySafe: () => true,
      async execute(args) {
        const id = requireNoteId(args)
        const note = await getNote(id)
        if (!note) throw new Error(`note not found: ${id}`)
        return JSON.stringify(note)
      },
    },
    {
      name: 'notes_create',
      description:
        'Create a sticky note. Title and body are optional; Markdown task lines such as "- [ ] buy milk" render as checkboxes in the panel.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title (up to 200 characters).' },
          body: { type: 'string', description: 'Note body (up to 20000 characters).' },
          color: { type: 'string', enum: PAPER_IDS, description: 'Paper color; defaults to pink.' },
          pinned: { type: 'boolean', description: 'Pin the note to the top of the board.' },
        },
        additionalProperties: false,
      },
      output: makeOutput(),
      async execute(args) {
        return JSON.stringify(await createNote(args && typeof args === 'object' ? args : {}))
      },
    },
    {
      name: 'notes_update',
      description:
        'Update a sticky note. Only the fields you pass change. Use mode "append" to add text at the end of the body instead of replacing it.',
      parameters: {
        type: 'object',
        properties: {
          id: idSchema,
          title: { type: 'string', description: 'New title.' },
          body: { type: 'string', description: 'New body, or the text to append when mode is "append".' },
          color: { type: 'string', enum: PAPER_IDS, description: 'New paper color.' },
          mode: { type: 'string', enum: ['replace', 'append'], description: 'How body is applied (default replace).' },
          pinned: { type: 'boolean', description: 'Pin (true) or unpin (false) the note.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: makeOutput(),
      async execute(args) {
        const id = requireNoteId(args)
        const patch = {}
        if (typeof args.title === 'string') patch.title = args.title
        if (typeof args.body === 'string') patch.body = args.body
        if (typeof args.color === 'string') patch.color = args.color
        if (typeof args.pinned === 'boolean') patch.pinned = args.pinned
        if (args.mode === 'append') patch.mode = 'append'
        if (Object.keys(patch).length === 0) {
          const note = await getNote(id)
          if (!note) throw new Error(`note not found: ${id}`)
          return JSON.stringify(note)
        }
        return JSON.stringify(await updateNote(id, patch))
      },
    },
    {
      name: 'notes_delete',
      description: 'Move a sticky note to the trash. Recoverable with notes_restore.',
      parameters: {
        type: 'object',
        properties: { id: idSchema },
        required: ['id'],
        additionalProperties: false,
      },
      output: makeOutput(),
      async execute(args) {
        const id = requireNoteId(args)
        const result = await deleteNote(id)
        if (!result.removed) throw new Error(`note not found: ${id}`)
        return JSON.stringify({ id, deleted: true, trashCount: result.trashCount })
      },
    },
    {
      name: 'notes_trash_list',
      description: 'List notes currently in the trash, with their deletion time.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: makeOutput(),
      isConcurrencySafe: () => true,
      async execute() {
        const entries = await listTrash()
        return JSON.stringify({
          total: entries.length,
          items: entries.map((note) => ({
            id: note.id,
            title: note.title,
            preview: note.body.replace(/\s+/g, ' ').trim().slice(0, 120),
            deletedAt: note.deletedAt,
          })),
        })
      },
    },
    {
      name: 'notes_restore',
      description: 'Restore a note from the trash back onto the board.',
      parameters: {
        type: 'object',
        properties: { id: idSchema },
        required: ['id'],
        additionalProperties: false,
      },
      output: makeOutput(),
      async execute(args) {
        const result = await restoreNote(requireNoteId(args))
        return JSON.stringify({ id: result.note.id, restored: true, trashCount: result.trashCount })
      },
    },
    {
      name: 'notes_purge',
      description: 'Permanently delete one trashed note. Irreversible: requires confirm: true.',
      parameters: {
        type: 'object',
        properties: {
          id: idSchema,
          confirm: { type: 'boolean', description: 'Must be true; guards against accidental permanent deletion.' },
        },
        required: ['id', 'confirm'],
        additionalProperties: false,
      },
      output: makeOutput(),
      async execute(args) {
        const id = requireNoteId(args)
        if (args.confirm !== true) throw new Error('confirm must be true to purge a note permanently')
        const result = await purgeNote(id)
        return JSON.stringify({ id, purged: result.purged, trashCount: result.trashCount })
      },
    },
    {
      name: 'notes_empty_trash',
      description: 'Permanently delete every trashed note. Irreversible: requires confirm: true.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Must be true; guards against accidental permanent deletion.' },
        },
        required: ['confirm'],
        additionalProperties: false,
      },
      output: makeOutput(),
      async execute(args) {
        if (!args || args.confirm !== true) throw new Error('confirm must be true to empty the trash')
        return JSON.stringify(await emptyTrash())
      },
    },
  ]
}

/** 工具入参里的 id 先按同一套字符集校验，避免把奇怪的东西拼进路径/日志。 */
function requireNoteId(args) {
  const value = args && typeof args === 'object' ? args.id : undefined
  if (typeof value !== 'string' || !ID_PATTERN.test(value.trim())) {
    throw new Error('id must be a note id returned by notes_list')
  }
  return value.trim()
}

/** 工具服务由别的插件提供，取不到就安静跳过，不能让便签面板跟着挂掉。 */
function toolsOf(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get('tools')
      if (service !== undefined && service !== null) return service
    }
  } catch {
    // 宿主没挂 dsh-tools。
  }
  try {
    return ctx.tools || null
  } catch {
    return null
  }
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

  // 原生工具：宿主挂了 tools 服务才注册，取不到就算了，不影响面板。
  const tools = toolsOf(ctx)
  if (tools && typeof tools.register === 'function') {
    try {
      ctx.effect(() => {
        const disposers = notesTools().map((definition) => tools.register(definition))
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // HMR 期间宿主可能已经先一步清理。
            }
          }
        }
      }, 'dsh-sticky-notes: tools')
    } catch (caught) {
      // 工具名冲突之类的异常不该把面板路由一起带下去。
      console.error('[dsh-sticky-notes] failed to register tools', caught)
    }
  }
}

export { apply, inject, name, notesTools }
