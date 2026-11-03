// 离线冒烟测试：不依赖 cordis，直接驱动插件注册的 HTTP handler。
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

const home = await mkdtemp(join(tmpdir(), 'dsn-test-'))
process.env.DSH_HOME = home

const routes = []
const ctx = {
  effect(fn, label) {
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

function makeReq({ method = 'GET', url = '/api/dsh-sticky-notes/state', headers = {}, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = Object.assign({ host: '127.0.0.1:54926', 'sec-fetch-site': 'same-origin' }, headers)
  req.resume = () => {}
  setTimeout(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  }, 5)
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writableEnded: false,
    destroyed: false,
    once() {},
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(chunk) {
      if (chunk) this.body += chunk
      this.writableEnded = true
    },
  }
}

async function call(options) {
  const req = makeReq(options)
  const res = makeRes()
  await handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    // 忽略
  }
  return { status: res.statusCode, json, text: res.body }
}

const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` -> ${JSON.stringify(detail)}`}`)
}

let r = await call({ method: 'GET' })
check('GET empty 200', r.status === 200 && r.json?.ok === true && r.json.data.notes.length === 0, r)

const notes = [
  { id: 'a', title: '第一行', body: '正文\n第二行', color: 'pink', createdAt: 1, updatedAt: 2 },
  { id: 'b', title: '', body: '', createdAt: 3, updatedAt: 4 },
]
r = await call({
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'x-dsh-sticky-notes': '1' },
  body: JSON.stringify({ notes }),
})
check('PUT saves 200', r.status === 200 && r.json?.ok === true && r.json.data.notes.length === 2, r)

const onDisk = JSON.parse(await readFile(join(home, 'sticky-notes', 'notes.json'), 'utf8'))
check('file written', onDisk.notes.length === 2 && onDisk.notes[0].id === 'a', onDisk)

r = await call({ method: 'GET' })
check('GET roundtrip', r.status === 200 && r.json.data.notes[1].id === 'b', r)
check('paper color persisted', r.json.data.notes[0].color === 'pink', r.json.data.notes[0])

r = await call({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ notes: [] }),
})
check('missing marker 403', r.status === 403 && r.json?.ok === false, r)

r = await call({
  method: 'PUT',
  headers: { 'content-type': 'text/plain', 'x-dsh-sticky-notes': '1' },
  body: '{}',
})
check('wrong content-type 415', r.status === 415, r)

r = await call({ method: 'GET', headers: { host: 'evil.example.com' } })
check('untrusted host 403', r.status === 403, r)

r = await call({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
check('cross-site 403', r.status === 403, r)

r = await call({ method: 'DELETE' })
check('bad method 405', r.status === 405, r)

r = await call({
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'x-dsh-sticky-notes': '1' },
  body: '{"notes":"nope"}',
})
check('invalid notes 400', r.status === 400 && r.json?.ok === false, r)

r = await call({
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'x-dsh-sticky-notes': '1' },
  body: '{"notes":[{"id":"c","title":123,"body":null,"color":42,"createdAt":"x"},{"id":"d","color":"chartreuse"}]}',
})
check(
  'coerces bad fields 200',
  r.status === 200 && r.json.data.notes[0].title === '' && r.json.data.notes[0].body === '' && r.json.data.notes[0].color === '',
  r,
)
check('unknown paper color dropped', r.json.data.notes[1].color === '', r.json.data.notes[1])

r = await call({ method: 'GET', url: '/api/dsh-sticky-notes/other' })
check('unknown path 404', r.status === 404, r)

await rm(home, { recursive: true, force: true })
const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
