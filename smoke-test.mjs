// 离线冒烟测试：不依赖 cordis，直接驱动插件注册的 HTTP handler。
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { apply } from './index.js'

const home = await mkdtemp(join(tmpdir(), 'dsn-test-'))
process.env.DSH_HOME = home

const routes = []
/** 插件注册进来的原生工具，用来验证 ctx.tools.register 的接线。 */
const registered = []
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
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
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

// ---- 原生工具：ctx.tools.register 的定义与执行 ----
const tool = (name) => registered.find((item) => item.name === name)
check(
  'registers native note tools',
  ['notes_list', 'notes_get', 'notes_create', 'notes_update', 'notes_delete', 'notes_trash_list', 'notes_restore', 'notes_purge', 'notes_empty_trash'].every(
    (name) => tool(name) !== undefined,
  ),
  registered.map((item) => item.name),
)
check(
  'native tools carry JSON Schema parameters',
  registered.every((item) => item.parameters && item.parameters.type === 'object' && typeof item.description === 'string'),
  registered.map((item) => item.name),
)

let toolError = null
try {
  await tool('notes_get').execute({ id: '../etc/passwd' })
} catch (caught) {
  toolError = caught
}
check('native tool rejects a malformed id', toolError instanceof Error, String(toolError))

const toolNote = JSON.parse(await tool('notes_create').execute({ title: '工具创建', body: '- [ ] 待办' }))
check('native create returns an id', typeof toolNote.id === 'string', toolNote)
const toolList = JSON.parse(await tool('notes_list').execute({ query: '工具创建' }))
check('native list finds the note', toolList.matched === 1, toolList)

const toolPinned = JSON.parse(await tool('notes_update').execute({ id: toolNote.id, pinned: true }))
check('native pin update', toolPinned.pinned === true, toolPinned)
const pinnedList = JSON.parse(await tool('notes_list').execute({}))
check(
  'native list reports pinned',
  pinnedList.items.some((item) => item.id === toolNote.id && item.pinned === true),
  pinnedList.items,
)
r = await call({ method: 'GET' })
check(
  'pinned flag survives the serializer',
  r.json?.data?.notes?.some((note) => note.id === toolNote.id && note.pinned === true),
  r.json?.data?.notes,
)

const toolDeleted = JSON.parse(await tool('notes_delete').execute({ id: toolNote.id }))
check('native delete moves to trash', toolDeleted.deleted === true && toolDeleted.trashCount >= 1, toolDeleted)
check('native output renders text content', tool('notes_list').output.render({}, '{}')[0].type === 'text', null)

// ---- 图片占用审计（上传过一张图，但没有任何便签引用它） ----
// 孤儿有 60 秒宽限期（防「刚粘贴、引用还没落盘」被误删），先把 mtime 拨老再测。
const assetsDirPath = join(home, 'sticky-notes', 'assets')
const oldStamp = new Date(Date.now() - 10 * 60 * 1000)
for (const name of await readdir(assetsDirPath)) await utimes(join(assetsDirPath, name), oldStamp, oldStamp)

r = await call({ method: 'GET', url: `${API}/storage` })
check('storage audit lists assets', r.status === 200 && r.json?.data?.total >= 1, r.json?.data)
check('unreferenced image is an orphan', r.json?.data?.orphanCount >= 1, r.json?.data)
check('orphan detail list stays server-side', r.json?.data?.orphans === undefined, Object.keys(r.json?.data || {}))
check('audit reports broken references as a count', Number.isFinite(r.json?.data?.missingCount), r.json?.data)
check('audit keeps the server data dir private', r.json?.data?.dir === undefined, Object.keys(r.json?.data || {}))

r = await call({ method: 'DELETE', url: `${API}/storage`, headers: {} })
check('storage prune needs marker 403', r.status === 403, r.json)

// ---- 导出 ----
r = await call({ method: 'GET', url: `${API}/export?format=json` })
const exported = r.json?.data || {}
check(
  'json export carries format and notes',
  r.status === 200 && exported.format === 'dsh-sticky-notes' && Array.isArray(exported.notes) && exported.notes.length >= 1,
  exported.stats,
)
check('json export counts notes', exported.stats?.notes === exported.notes?.length, exported.stats)

r = await call({ method: 'GET', url: `${API}/export?format=markdown&assets=0` })
check(
  'markdown export without assets is plain text',
  r.status === 200 && r.headers['content-type'].startsWith('text/markdown') && r.raw.toString('utf8').startsWith('<!-- exported'),
  r.headers,
)

r = await call({ method: 'GET', url: `${API}/export?format=markdown` })
check('markdown export with images is a zip', r.status === 200 && r.raw.slice(0, 2).toString() === 'PK', r.headers)
const zipMethod = r.raw.readUInt16LE(8)
const zipNameLen = r.raw.readUInt16LE(26)
const zipCompressed = r.raw.readUInt32LE(18)
const zipName = r.raw.slice(30, 30 + zipNameLen).toString('utf8')
const zipBody = r.raw.slice(30 + zipNameLen, 30 + zipNameLen + zipCompressed)
const unzipped = zipMethod === 8 ? inflateRawSync(zipBody).toString('utf8') : zipBody.toString('utf8')
check(
  'zip holds a readable markdown file',
  zipName === 'sticky-notes.md' && unzipped.startsWith('<!-- exported'),
  { zipName, method: zipMethod, head: unzipped.slice(0, 40) },
)

// ---- 导入 ----
r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({ notes: [noteOf('incoming', { title: '导入的', updatedAt: 9 })], mode: 'merge' }),
})
check('import merge adds a note', r.status === 200 && r.json?.data?.added === 1, r.json)

r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({ notes: [noteOf('incoming', { title: '导入的更新', updatedAt: 99 })], mode: 'merge' }),
})
check('import merge updates a newer note', r.status === 200 && r.json?.data?.updated === 1, r.json)

r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({ notes: [noteOf('incoming', { title: '更旧的', updatedAt: 1 })], mode: 'merge' }),
})
check('import keeps the newer local copy', r.status === 200 && r.json?.data?.skipped === 1, r.json)

r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({ notes: [noteOf('dupe', { title: '一' }), noteOf('dupe', { title: '二' })], mode: 'merge' }),
})
check('import dedupes repeated ids', r.status === 200 && r.json?.data?.added === 1 && r.json?.data?.skipped === 1, r.json)
r = await call({ method: 'GET' })
check(
  'board has no duplicate ids',
  r.json?.data?.notes?.filter((note) => note.id === 'dupe').length === 1,
  r.json?.data?.notes?.map((note) => note.id),
)

// 备份里的便签全都比本地旧：合并结果是「无改动」，这时图片也不该落盘（落了就是孤儿）。
r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({
    notes: [noteOf('dupe', { title: '旧', updatedAt: 1 })],
    assets: { 'ffffaa01.png': Buffer.from('noop').toString('base64') },
    mode: 'merge',
  }),
})
const noopAssetLanded = (await readdir(join(home, 'sticky-notes', 'assets')).catch(() => [])).includes('ffffaa01.png')
check(
  'no-op import writes no images',
  r.status === 200 && r.json?.data?.assets?.written === 0 && noopAssetLanded === false,
  { result: r.json?.data?.assets, landed: noopAssetLanded },
)

const conflictAssetsDir = join(home, 'sticky-notes', 'assets')
const assetsBeforeConflict = (await readdir(conflictAssetsDir).catch(() => [])).length
r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({
    notes: [],
    assets: { 'ffffee01.png': Buffer.from('conflict').toString('base64') },
    baseVersion: 0,
    mode: 'merge',
  }),
})
check('import with stale baseVersion 409', r.status === 409 && r.json?.code === 'error.state.conflict', r.json)
const assetsAfterConflict = (await readdir(conflictAssetsDir).catch(() => [])).length
check(
  'conflict writes nothing to disk',
  assetsAfterConflict === assetsBeforeConflict,
  `${assetsBeforeConflict} -> ${assetsAfterConflict}`,
)

r = await call({ method: 'POST', url: `${API}/import`, headers: writeHeaders, body: '{"notes":"nope"}' })
check('import rejects a bad payload 400', r.status === 400, r.json)

r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({ notes: [{ id: '../../etc/passwd', title: 'bad id' }], mode: 'merge' }),
})
check(
  'import drops notes with invalid ids',
  r.status === 200 && r.json?.data?.added === 0 && r.json?.data?.skipped === 1,
  r.json?.data,
)

const importedAsset = Buffer.from('fake-image-bytes')
r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({
    notes: [noteOf('with-asset', { body: '![](assets/abcdef01.png)' })],
    assets: { 'abcdef01.png': importedAsset.toString('base64') },
    mode: 'merge',
  }),
})
check('import writes bundled images', r.status === 200 && r.json?.data?.assets?.written === 1, r.json?.data?.assets)
r = await call({ method: 'GET', url: `${API}/assets/abcdef01.png` })
check('imported image is served', r.status === 200 && r.raw.equals(importedAsset), { status: r.status })

// ---- 快照历史与回滚 ----
r = await call({ method: 'GET', url: `${API}/snapshots` })
const snapshots = r.json?.data?.snapshots || []
check(
  'snapshots listed',
  r.status === 200 && snapshots.length > 0 && snapshots.every((item) => typeof item.name === 'string'),
  r.json?.data,
)
check(
  'snapshots carry counts and kind',
  snapshots.some((item) => item.kind === 'auto' && Number.isFinite(item.notes) && item.size > 0),
  snapshots,
)

const target = snapshots.find((item) => item.kind === 'auto' && item.broken !== true)
r = await call({
  method: 'POST',
  url: `${API}/snapshots/${encodeURIComponent(target.name)}/restore`,
  headers: writeHeaders,
  body: '{}',
})
check('snapshot restore 200', r.status === 200 && r.json?.data?.restoredFrom === target.name, r.json)
check('restore keeps the trash', Number.isFinite(r.json?.data?.trash), r.json?.data)

r = await call({ method: 'GET', url: `${API}/snapshots` })
check(
  'restore archives the pre-restore state',
  (r.json?.data?.snapshots || []).some((item) => item.kind === 'preRestore'),
  r.json?.data?.snapshots?.map((item) => item.kind),
)

r = await call({
  method: 'POST',
  url: `${API}/snapshots/..%2Fnotes.json/restore`,
  headers: writeHeaders,
  body: '{}',
})
check('snapshot name validated 400', r.status === 400, r.json)

r = await call({ method: 'POST', url: `${API}/snapshots/${encodeURIComponent(target.name)}/restore`, body: '{}' })
check('snapshot restore needs marker 403', r.status === 403, r.json)

r = await call({ method: 'POST', url: `${API}/snapshots/${encodeURIComponent(target.name)}`, headers: writeHeaders, body: '{}' })
check('unknown snapshot action 404', r.status === 404, r.json)

// 结构不对的快照必须拒绝恢复：否则一个被改坏的留档文件就能把整板清空。
const brokenSnapshot = 'notes.pre-restore-zzzz.json'
await writeFile(join(home, 'sticky-notes', brokenSnapshot), JSON.stringify({ version: 1 }))
r = await call({
  method: 'POST',
  url: `${API}/snapshots/${encodeURIComponent(brokenSnapshot)}/restore`,
  headers: writeHeaders,
  body: '{}',
})
check('malformed snapshot is rejected 400', r.status === 400, r.json)
await rm(join(home, 'sticky-notes', brokenSnapshot), { force: true })

// ---- 清理孤儿图片 ----
// 回滚把引用图的那条便签换掉了，先放回来一条，确保清理只删没人用的。
// 这里故意用普通链接（没有 `!`）而不是图片语法：服务端的「引用」判定必须两种都认。
r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({ notes: [noteOf('keep-asset', { body: '[截图](assets/abcdef01.png)' })], mode: 'merge' }),
})
check('import restores an image reference', r.status === 200 && r.json?.data?.added === 1, r.json)

r = await call({ method: 'DELETE', url: `${API}/storage`, headers: { 'x-dsh-sticky-notes': '1' } })
check('orphan prune removes unused images', r.status === 200 && r.json?.data?.removed >= 1, r.json?.data)
r = await call({ method: 'GET', url: `${API}/storage` })
check('referenced image survives the prune', r.json?.data?.total >= 1 && r.json?.data?.orphanCount === 0, r.json?.data)

// ---- 单条写接口的入参护栏 ----
r = await call({ method: 'GET' })
const anyId = r.json?.data?.notes?.[0]?.id
r = await call({ method: 'PUT', url: `${API}/notes/${encodeURIComponent(anyId)}`, headers: writeHeaders, body: '{"note":"x"}' })
check('note payload must be an object 400', r.status === 400, r.json)
r = await call({ method: 'GET' })
check(
  'a bad note payload does not wipe the body',
  r.json?.data?.notes?.find((note) => note.id === anyId) !== undefined,
  anyId,
)

// replace 是破坏性操作：超量必须 400，不能像 merge 那样静默截断。
r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({ notes: Array.from({ length: 201 }, (_, i) => noteOf(`rep-${i}`)), mode: 'replace' }),
})
check('replace import stays strict on overflow 400', r.status === 400, r.json?.code)

// ---- 超量数据要「抢救」，不能当成坏文件改名（GET 不该有破坏性副作用） ----
const boardFile = join(home, 'sticky-notes', 'notes.json')
const corruptBefore = (await readdir(join(home, 'sticky-notes'))).filter((name) => name.startsWith('notes.corrupt-')).length
await writeFile(
  boardFile,
  JSON.stringify({ version: 900, notes: Array.from({ length: 201 }, (_, i) => noteOf(`over-${i}`)), trash: [] }),
)
r = await call({ method: 'GET' })
check('oversized board is salvaged', r.status === 200 && r.json?.data?.notes?.length === 200, r.json?.data?.notes?.length)
check('salvage reports the dropped count', r.json?.data?.dropped === 1, r.json?.data?.dropped)
const corruptAfter = (await readdir(join(home, 'sticky-notes'))).filter((name) => name.startsWith('notes.corrupt-')).length
check('oversized board is not renamed as corrupt', corruptAfter === corruptBefore, `${corruptBefore} -> ${corruptAfter}`)

// ---- 陈旧锁：过期的 .notes.lock 要被回收，而不是让写请求一直 503 ----
const lockFile = join(home, 'sticky-notes', '.notes.lock')
await writeFile(lockFile, '99999 0 dead-holder\n')
const longAgo = new Date(Date.now() - 60 * 1000)
await utimes(lockFile, longAgo, longAgo)
r = await call({
  method: 'PUT',
  url: `${API}/notes/over-0`,
  headers: writeHeaders,
  body: JSON.stringify({ note: { title: 'stale lock probe', updatedAt: Date.now() } }),
})
check('stale lock is reclaimed instead of failing 503', r.status === 200, r.json)
const lockLeft = (await readdir(join(home, 'sticky-notes'))).filter((name) => name.startsWith('.notes.lock')).length
check('lock file is released after the write', lockLeft === 0, lockLeft)

// 本地满 200 条时 merge 导入不能挤掉本地便签：名额用完就丢新增，并单独回报 overflow。
r = await call({
  method: 'POST',
  url: `${API}/import`,
  headers: writeHeaders,
  body: JSON.stringify({ notes: [noteOf('overflow-new', { title: '挤不进来' })], mode: 'merge' }),
})
check(
  'merge import refuses new notes when the board is full',
  r.status === 200 && r.json?.data?.added === 0 && r.json?.data?.overflow === 1,
  r.json?.data,
)
r = await call({ method: 'GET' })
const idsAfterFull = (r.json?.data?.notes || []).map((note) => note.id)
check(
  'full board keeps every local note',
  idsAfterFull.length === 200 && idsAfterFull.includes('over-199') && !idsAfterFull.includes('overflow-new'),
  idsAfterFull.slice(-2),
)

await rm(home, { recursive: true, force: true })
const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
