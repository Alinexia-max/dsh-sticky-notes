import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Cordis 插件的诊断名；与 patch 里的 id 保持一致便于排查。 */
const name = 'dsh-sticky-notes'
/** `webServer` 提供 HTTP 路由能力。 */
const inject = ['webServer']

const API_PREFIX = '/api/dsh-sticky-notes'
const STATE_PATH = `${API_PREFIX}/state`
/** 写请求必须带的自定义头：跨站 fetch 因此被迫走预检，而本路由不回 CORS。 */
const CLIENT_MARKER_HEADER = 'x-dsh-sticky-notes'
const MAX_BODY_BYTES = 1024 * 1024
const MAX_NOTES = 200
const MAX_TITLE = 200
const MAX_NOTE_BODY = 20000
const MAX_ID = 128
/** 便签纸配色白名单，与 client.js 的 PAPERS、CSS 的 dsn-palette 三处一致。 */
const PAPER_COLORS = new Set(['pink', 'yellow', 'mint', 'sky', 'violet'])

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

/** 成功统一包成 `{ ok: true, data }`；核心返回 `{ ok:false, ... }` 时透传为 400。 */
function run(res, task, headOnly = false) {
  return Promise.resolve()
    .then(task)
    .then((result) => {
      if (result !== null && typeof result === 'object' && result.ok === false) {
        json(res, 400, result, headOnly)
      } else {
        json(res, 200, { ok: true, data: result }, headOnly)
      }
    })
    .catch((caught) => fail(res, caught, headOnly))
}

function fail(res, caught, headOnly = false) {
  const statusCode = Number.isInteger(caught && caught.statusCode) ? caught.statusCode : 500
  json(
    res,
    statusCode,
    {
      ok: false,
      ...(caught && typeof caught.code === 'string' ? { code: caught.code } : {}),
      error: messageOf(caught),
    },
    headOnly,
  )
}

function readBody(req, limit = MAX_BODY_BYTES) {
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
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        const parsed = raw === '' ? {} : JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          failWith(coded(400, 'error.proto.invalidBody', '请求体必须是 JSON 对象'))
          return
        }
        settled = true
        resolve(parsed)
      } catch (caught) {
        failWith(coded(400, 'error.proto.invalidJson', `invalid JSON body: ${messageOf(caught)}`))
      }
    })
    req.on('error', (caught) => {
      const error = caught instanceof Error ? caught : new Error(String(caught))
      if (error.statusCode === undefined) error.statusCode = 400
      failWith(error)
    })
  })
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

function stateFilePath() {
  return join(resolveDshHome(), 'sticky-notes', 'notes.json')
}

/** 收窄客户端提交的内容：字段类型、长度、条数都在这里兜住。 */
function sanitizeDoc(input) {
  const list = input !== null && typeof input === 'object' && Array.isArray(input.notes) ? input.notes : null
  if (list === null) throw coded(400, 'error.proto.invalidBody', 'notes must be an array')
  if (list.length > MAX_NOTES) throw coded(400, 'error.proto.tooManyNotes', `at most ${MAX_NOTES} notes`)
  const now = Date.now()
  return list.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw coded(400, 'error.proto.invalidNote', 'note must be an object')
    }
    const title = typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE) : ''
    const body = typeof raw.body === 'string' ? raw.body.slice(0, MAX_NOTE_BODY) : ''
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now
    const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
    const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, MAX_ID) : randomUUID()
    const color = typeof raw.color === 'string' && PAPER_COLORS.has(raw.color) ? raw.color : ''
    return { id, title, body, color, createdAt, updatedAt }
  })
}

async function readState(filePath) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (caught) {
    if (caught && caught.code === 'ENOENT') return { notes: [] }
    throw caught
  }
  try {
    return { notes: sanitizeDoc(JSON.parse(raw)) }
  } catch (caught) {
    if (caught && Number.isInteger(caught.statusCode)) throw caught
    throw coded(500, 'error.proto.corruptState', `invalid notes file: ${messageOf(caught)}`)
  }
}

/** 原子写：先落临时文件再 rename，避免写到一半留下半个 JSON。 */
async function writeState(filePath, notes) {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.notes.${process.pid}.${Date.now().toString(36)}.tmp`)
  const payload = `${JSON.stringify({ version: 1, notes }, null, 2)}\n`
  await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tmp, filePath)
  } catch (caught) {
    await rm(tmp, { force: true })
    throw caught
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
            const hostError = validateRequestOrigin(req, trustedHostsOf(ctx))
            if (hostError !== null) {
              json(res, hostError.statusCode, { ok: false, code: hostError.code, error: hostError.error })
              return
            }
            if (pathname !== STATE_PATH) {
              json(res, 404, { ok: false, code: 'error.proto.unknownAction', error: `unknown action: ${pathname}` })
              return
            }
            if (req.method === 'GET' || req.method === 'HEAD') {
              const headOnly = req.method === 'HEAD'
              return run(res, () => readState(stateFilePath()), headOnly)
            }
            if (req.method !== 'PUT' && req.method !== 'POST') {
              json(res, 405, {
                ok: false,
                code: 'error.proto.method',
                error: `method not allowed: ${req.method ?? 'unknown'}`,
              })
              return
            }
            const requestError = validateMutationRequest(req, trustedHostsOf(ctx))
            if (requestError !== null) {
              json(res, requestError.statusCode, { ok: false, code: requestError.code, error: requestError.error })
              return
            }
            const body = await readBody(req)
            const notes = sanitizeDoc(body)
            await writeState(stateFilePath(), notes)
            return run(res, () => ({ notes, savedAt: Date.now() }))
          } catch (caught) {
            fail(res, caught)
          }
        },
      }),
    'dsh-sticky-notes: state route',
  )
}

export { apply, inject, name }
