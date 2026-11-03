// 离线冒烟测试：不依赖 cordis，直接驱动插件注册的 HTTP handler。
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

const home = await mkdtemp(join(tmpdir(), 'dsn-test-'))
process.env.DSH_HOME = home

const routes = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  root: {},
}
apply(ctx)
const handler = routes[0]?.handler
if (typeof handler !== 'function') throw new Error('no route registered')

const API = '/api/dsh-sticky-notes'

function makeReq({ method = 'GET', url = `${API}/state`, headers = {}, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = Object.assign({ host: '127.0.0.1:54926', 'sec-fetch-site': 'same-origin' }, headers)
  req.resume = () => {}
  setTimeout(() => {
    if (body !== undefined) req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body))
    req.emit('end')
  }, 5)
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    chunks: [],
    writableEnded: false,
    destroyed: false,
    once() {},
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      this.writableEnded = true
    },
  }
}

async function call(options) {
  const req = makeReq(options)
  const res = makeRes()
  await handler(req, res)
  const raw = Buffer.concat(res.chunks)
  let body = null
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    // 图片之类的二进制响应。
  }
  return { status: res.statusCode, json: body, headers: res.headers, raw }
}

const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` -> ${JSON.stringify(detail)}`}`)
}

const writeHeaders = { 'content-type': 'application/json', 'x-dsh-sticky-notes': '1' }
const noteOf = (id, patch) => Object.assign({ id, title: '标题', body: '正文', color: 'pink', createdAt: 1, updatedAt: 1 }, patch)

// ---- 基础读取 ----
let r = await call({ method: 'GET' })
check('GET empty 200', r.status === 200 && r.json?.ok === true && r.json.data.notes.length === 0, r.json)
check('GET returns version 0', r.json?.data.version === 0, r.json?.data)

// ---- 单条新建 ----
r = await call({
  method: 'PUT',
  url: `${API}/notes/a`,
  headers: writeHeaders,
  body: JSON.stringify({ note: noteOf('a'), baseVersion: 0 }),
})
check('PUT /notes/a creates 200', r.status === 200 && r.json?.ok === true, r.json)
check('create bumps version to 1', r.json?.data.version === 1, r.json?.data)

r = await call({ method: 'GET' })
check('state has one note', r.json?.data.notes.length === 1 && r.json.data.notes[0].id === 'a', r.json?.data)

// ---- 版本冲突 ----
r = await call({
  method: 'PUT',
  url: `${API}/notes/a`,
  headers: writeHeaders,
  body: JSON.stringify({ note: noteOf('a', { title: '旧窗口' }), baseVersion: 0 }),
})
check('stale baseVersion 409', r.status === 409 && r.json?.code === 'error.state.conflict', r.json)
check('409 returns current state', r.json?.data?.version === 1 && r.json.data.notes.length === 1, r.json?.data)

// ---- 更新 ----
r = await call({
  method: 'PUT',
  url: `${API}/notes/a`,
  headers: writeHeaders,
  body: JSON.stringify({ note: noteOf('a', { title: '改过' }), baseVersion: 1 }),
})
check('update with current baseVersion 200', r.status === 200 && r.json?.data.version === 2, r.json)
check('update applies title', r.json?.data.note.title === '改过', r.json?.data?.note)

// ---- 删除 ----
r = await call({
  method: 'DELETE',
  url: `${API}/notes/a?baseVersion=2`,
  headers: { 'x-dsh-sticky-notes': '1' },
})
check('DELETE note 200', r.status === 200 && r.json?.data.removed === true && r.json?.data.version === 3, r.json)

r = await call({
  method: 'DELETE',
  url: `${API}/notes/missing?baseVersion=3`,
  headers: { 'x-dsh-sticky-notes': '1' },
})
check('DELETE missing is idempotent', r.status === 200 && r.json?.data.removed === false, r.json)

// ---- 鉴权与参数 ----
r = await call({ method: 'PUT', url: `${API}/notes/a`, headers: { 'content-type': 'application/json' }, body: '{}' })
check('missing marker 403', r.status === 403 && r.json?.ok === false, r.json)

r = await call({
  method: 'PUT',
  url: `${API}/notes/a`,
  headers: { 'content-type': 'text/plain', 'x-dsh-sticky-notes': '1' },
  body: '{}',
})
check('wrong content-type 415', r.status === 415, r.json)

r = await call({ method: 'DELETE', url: `${API}/notes/a`, headers: {} })
check('DELETE without marker 403', r.status === 403, r.json)

r = await call({ method: 'GET', headers: { host: 'evil.example.com' } })
check('untrusted host 403', r.status === 403, r.json)

r = await call({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
check('cross-site 403', r.status === 403, r.json)

r = await call({ method: 'POST', url: `${API}/notes/a`, headers: writeHeaders, body: '{}' })
check('bad method 405', r.status === 405, r.json)

r = await call({ method: 'PUT', url: `${API}/notes/..%2F..%2Fetc`, headers: writeHeaders, body: '{}' })
check('path traversal id 400', r.status === 400, r.json)

r = await call({ method: 'GET', url: `${API}/other` })
check('unknown path 404', r.status === 404, r.json)

// ---- 字段收窄 ----
r = await call({
  method: 'PUT',
  url: `${API}/notes/c`,
  headers: writeHeaders,
  body: JSON.stringify({
    note: { id: 'other', title: 123, body: null, color: 'chartreuse', width: 9999, height: 10, order: 42 },
  }),
})
check(
  'note fields coerced',
  r.json?.data?.note.title === '' &&
    r.json.data.note.body === '' &&
    r.json.data.note.color === '' &&
    r.json.data.note.width === 720 &&
    r.json.data.note.height === 180,
  r.json?.data?.note,
)
check('path id wins over body id', r.json?.data?.note.id === 'c', r.json?.data?.note)
check('order persisted', r.json?.data?.note.order === 42, r.json?.data?.note)

// ---- 整份覆盖（导入/兼容） ----
r = await call({
  method: 'PUT',
  url: `${API}/state`,
  headers: writeHeaders,
  body: JSON.stringify({ notes: [noteOf('a'), noteOf('b')] }),
})
check('bulk PUT /state 200', r.status === 200 && r.json?.data.notes.length === 2, r.json)

r = await call({
  method: 'PUT',
  url: `${API}/state`,
  headers: writeHeaders,
  body: JSON.stringify({ notes: [], baseVersion: 1 }),
})
check('bulk PUT with stale version 409', r.status === 409, r.json)

r = await call({
  method: 'PUT',
  url: `${API}/state`,
  headers: writeHeaders,
  body: '{"notes":"nope"}',
})
check('invalid notes 400', r.status === 400 && r.json?.ok === false, r.json)

// ---- 图片 ----
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
r = await call({
  method: 'POST',
  url: `${API}/assets`,
  headers: { 'content-type': 'image/png', 'x-dsh-sticky-notes': '1' },
  body: png,
})
check('asset upload 200', r.status === 200 && /^assets\/[a-z0-9]+\.png$/.test(r.json?.data?.url || ''), r.json)
const assetUrl = r.json?.data?.url || ''

r = await call({ method: 'GET', url: `${API}/${assetUrl}` })
check(
  'asset served with image type',
  r.status === 200 && r.headers['content-type'] === 'image/png' && r.raw.length === png.length,
  { status: r.status, headers: r.headers, size: r.raw.length },
)

r = await call({ method: 'POST', url: `${API}/assets`, headers: { 'content-type': 'text/plain', 'x-dsh-sticky-notes': '1' }, body: 'x' })
check('asset upload rejects non-image 415', r.status === 415, r.json)

r = await call({ method: 'GET', url: `${API}/assets/..%2Fnotes.json` })
check('asset name validated 400', r.status === 400, r.json)

r = await call({ method: 'GET', url: `${API}/assets/abcdef01.png` })
check('missing asset 404', r.status === 404, r.json)

// ---- 大请求体 ----
const bulk = Array.from({ length: 40 }, (_, index) => noteOf(`bulk-${index}`, { body: '汉'.repeat(20000) }))
r = await call({ method: 'PUT', url: `${API}/state`, headers: writeHeaders, body: JSON.stringify({ notes: bulk }) })
check('2.4MB payload accepted', r.status === 200 && r.json.data.notes.length === 40, r.status)

// ---- 坏文件自愈 ----
await writeFile(join(home, 'sticky-notes', 'notes.json'), '{ 这不是 JSON', 'utf8')
r = await call({ method: 'GET' })
check('corrupt file recovers', r.status === 200 && r.json.data.notes.length === 0 && r.json.data.recovered === true, r.json)
check(
  'corrupt file backed up',
  typeof r.json.data.backup === 'string' && r.json.data.backup.includes('notes.corrupt-'),
  r.json.data.backup,
)
const files = await readdir(join(home, 'sticky-notes'))
check('backup file exists', files.some((name) => name.startsWith('notes.corrupt-')), files)

// ---- 落盘 ----
r = await call({
  method: 'PUT',
  url: `${API}/notes/disk`,
  headers: writeHeaders,
  body: JSON.stringify({ note: noteOf('disk'), baseVersion: 0 }),
})
const onDisk = JSON.parse(await readFile(join(home, 'sticky-notes', 'notes.json'), 'utf8'))
check('file written with version', onDisk.version === 1 && onDisk.notes.length === 1, onDisk)

// ---- 存放目录 ----
const defaultDir = join(home, 'sticky-notes')
r = await call({ method: 'GET', url: `${API}/config` })
check(
  'config GET returns default dir',
  r.status === 200 && r.json?.data?.dir === defaultDir && r.json.data.custom === false,
  r.json?.data,
)

const movedDir = join(home, 'moved-data')
r = await call({
  method: 'POST',
  url: `${API}/config`,
  headers: writeHeaders,
  body: JSON.stringify({ dir: movedDir }),
})
check('switch dir 200', r.status === 200 && r.json?.data?.dir === movedDir, r.json?.data)
check('migration copies notes', r.json?.data?.notes === 1, r.json?.data)
check('migration copies assets', r.json?.data?.assets === 1, r.json?.data)

const movedFile = JSON.parse(await readFile(join(movedDir, 'notes.json'), 'utf8'))
check('notes file landed in new dir', movedFile.notes.length === 1 && movedFile.notes[0].id === 'disk', movedFile)
const movedAssets = await readdir(join(movedDir, 'assets'))
check('assets copied', movedAssets.length === 1, movedAssets)

const savedConfig = JSON.parse(await readFile(join(defaultDir, 'config.json'), 'utf8'))
check('config persisted', savedConfig.dir === movedDir, savedConfig)
check('old notes archived not left stale', !(await readdir(defaultDir)).includes('notes.json'), await readdir(defaultDir))

r = await call({ method: 'GET' })
check('state served from new dir', r.json?.data?.notes?.some((note) => note.id === 'disk'), r.json?.data)

r = await call({
  method: 'POST',
  url: `${API}/config`,
  headers: writeHeaders,
  body: JSON.stringify({ dir: 'relative/path' }),
})
check('relative dir rejected 400', r.status === 400 && r.json?.code === 'error.proto.invalidPath', r.json)

r = await call({
  method: 'POST',
  url: `${API}/config`,
  headers: writeHeaders,
  body: JSON.stringify({ dir: movedDir }),
})
check('same dir is a no-op', r.status === 200 && r.json?.data?.skipped === true, r.json?.data)

r = await call({ method: 'POST', url: `${API}/config`, headers: writeHeaders, body: JSON.stringify({ dir: null }) })
check('reset to default', r.status === 200 && r.json?.data?.dir === defaultDir && r.json.data.custom === false, r.json?.data)
check('reset migrates data back', r.json?.data?.skipped === false && r.json.data.notes === 1, r.json?.data)

r = await call({ method: 'POST', url: `${API}/config`, headers: { 'content-type': 'application/json' }, body: '{}' })
check('config POST needs marker 403', r.status === 403, r.json)

await rm(home, { recursive: true, force: true })
const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
