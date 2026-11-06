// 离线冒烟测试：真的把 mcp.js 当子进程拉起来，走一遍 stdio JSON-RPC 协议。
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` -> ${JSON.stringify(detail)}`}`)
}

/** 拉起一个 mcp.js 子进程，返回最小的 JSON-RPC 客户端。 */
function startServer(home) {
  const child = spawn(process.execPath, [join(here, 'mcp.js')], {
    env: Object.assign({}, process.env, { DSH_HOME: home }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const state = { stderr: '', buffer: '' }

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk
  })

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    state.buffer += chunk
    let index = state.buffer.indexOf('\n')
    while (index >= 0) {
      const line = state.buffer.slice(0, index).trim()
      state.buffer = state.buffer.slice(index + 1)
      if (line !== '') {
        const message = JSON.parse(line)
        const waiter = pending.get(message.id)
        if (waiter) {
          pending.delete(message.id)
          waiter(message)
        }
      }
      index = state.buffer.indexOf('\n')
    }
  })

  let nextId = 1
  const request = (method, params) => {
    const id = nextId
    nextId += 1
    const message = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    child.stdin.write(`${JSON.stringify(message)}\n`)
    return new Promise((resolve) => pending.set(id, resolve))
  }

  const notify = (method, params) => {
    const message = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const close = async () => {
    child.stdin.end()
    const code = await new Promise((resolve) => child.once('close', resolve))
    return { code, stderr: state.stderr }
  }

  return { request, notify, close }
}

const textOf = (response) => {
  const block = response.result && response.result.content && response.result.content[0]
  return block ? block.text : ''
}

const initialize = (client) =>
  client.request('initialize', {
    // DSH 用的 `@modelcontextprotocol/client` 会先报自己最新的版本（2025-11-25）。
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'dsh-mcp-client', version: '0.2.0-rc.2' },
  })

// ---- 场景一：协议握手、工具面、错误码 ----
{
  const home = await mkdtemp(join(tmpdir(), 'dsn-mcp-proto-'))
  const client = startServer(home)
  try {
    let response = await initialize(client)
    check('initialize returns a result', response.result !== undefined, response)
    check(
      'protocol version is one the client supports',
      ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(response.result?.protocolVersion),
      response.result,
    )
    check('advertises tools capability', response.result?.capabilities?.tools !== undefined, response.result)
    check('serverInfo name', response.result?.serverInfo?.name === 'dsh-sticky-notes', response.result?.serverInfo)

    client.notify('notifications/initialized')

    response = await client.request('ping')
    check('ping answers without error', response.error === undefined && response.result !== undefined, response)

    response = await client.request('tools/list')
    const tools = response.result?.tools || []
    const names = tools.map((tool) => tool.name)
    check('tools/list returns tools', tools.length >= 8, names)
    check(
      'every tool has an object input schema',
      tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'),
      names,
    )
    check('notes_create is exposed', names.includes('notes_create'), names)

    response = await client.request('tools/call', {
      name: 'notes_create',
      arguments: { title: '来自 MCP', body: '- [ ] 记得勾选' },
    })
    const created = JSON.parse(textOf(response))
    check('tools/call create returns id', typeof created.id === 'string', response)

    response = await client.request('tools/call', { name: 'notes_list', arguments: { query: 'MCP' } })
    check('list finds the new note', JSON.parse(textOf(response)).matched === 1, textOf(response))

    response = await client.request('tools/call', { name: 'notes_get', arguments: { id: 'no-such-note' } })
    check('missing note is an isError result', response.result?.isError === true, response)

    response = await client.request('tools/call', { name: 'notes_nope', arguments: {} })
    check('unknown tool is a JSON-RPC error', response.error?.code === -32602, response)

    response = await client.request('nope/nope')
    check('unknown method is a JSON-RPC error', response.error?.code === -32601, response)

    const doc = JSON.parse(await readFile(join(home, 'sticky-notes', 'notes.json'), 'utf8'))
    check('data landed on disk', doc.notes.length === 1 && doc.notes[0].title === '来自 MCP', doc.notes)
    check('version bumped once', doc.version === 1, doc.version)

    const { code, stderr } = await client.close()
    check('exits cleanly on stdin end', code === 0, code)
    check('nothing written to stderr', stderr.trim() === '', stderr)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// ---- 场景二：两个进程同时写同一份数据（跨进程文件锁） ----
{
  const home = await mkdtemp(join(tmpdir(), 'dsn-mcp-lock-'))
  const first = startServer(home)
  const second = startServer(home)
  try {
    await Promise.all([initialize(first), initialize(second)])
    first.notify('notifications/initialized')
    second.notify('notifications/initialized')

    const results = await Promise.all([
      first.request('tools/call', { name: 'notes_create', arguments: { title: '进程一' } }),
      second.request('tools/call', { name: 'notes_create', arguments: { title: '进程二' } }),
    ])
    check('both concurrent creates succeeded', results.every((item) => item.result?.isError !== true), results)

    const doc = JSON.parse(await readFile(join(home, 'sticky-notes', 'notes.json'), 'utf8'))
    const titles = doc.notes.map((note) => note.title).sort()
    check('neither write was lost', doc.notes.length === 2, titles)
    check('both titles survived', titles[0] === '进程一' && titles[1] === '进程二', titles)
    check('version counted both writes', doc.version === 2, doc.version)

    const listed = JSON.parse(textOf(await first.request('tools/call', { name: 'notes_list', arguments: {} })))
    check('list sees both notes', listed.matched === 2, listed)

    await first.close()
    await second.close()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) process.exitCode = 1
