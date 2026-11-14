/**
 * 便签的导入 / 导出 / 图片占用审计。
 *
 * 和 store.js 一样只依赖 node 内置模块：Host 半边（index.js）直接调用，
 * zip 也是手写的（zlib 只负责 deflate），不为打包功能引入运行时依赖。
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import {
  ASSET_PATTERN,
  MAX_ASSET_BYTES,
  MAX_NOTES,
  assetsDir,
  coded,
  readDoc,
  readState,
  salvageNotes,
  sanitizeNotes,
  serialized,
  stateFilePath,
  writeDoc,
} from './store.js'

/** 一次导出里图片（解码后）的总量上限，避免把几十 MB 的 base64 塞进一个响应。 */
const MAX_EXPORT_ASSET_BYTES = 48 * 1024 * 1024
/** 导出保留的格式标识，导入时用来认「这是本插件的备份」。 */
const EXPORT_FORMAT = 'dsh-sticky-notes'
const EXPORT_VERSION = 1
/** 单次导入的图片数量上限：几百个小文件串行写会把跨进程写锁占住超过 5s。 */
const MAX_IMPORT_ASSETS = 500
/** 图片写盘的分批大小：并行但别一次开几百个文件句柄。 */
const ASSET_BATCH = 16
/** 「一张图片都没写」的空统计，避免各处重复写字面量。 */
const NO_ASSETS = { written: 0, exists: 0, failed: 0, skipped: 0, bytes: 0 }

// `![]()` 是图片，`[]()` 是普通链接；两种都算「正文引用了这张图」，
// 否则 `[截图](assets/x.png)` 会被当成孤儿删掉，而客户端明明把它渲染成了可点链接。
const IMAGE_REF = /!?\[[^\]]*\]\(\s*assets\/([A-Za-z0-9._-]+)\s*\)/g

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 文件名里只用 ASCII 时间戳，避免下载时各平台对文件名的编码差异。 */
function stampOf(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('')
}

function referencedAssetsOf(notes) {
  const found = new Set()
  for (const note of notes) {
    for (const match of String(note.body || '').matchAll(IMAGE_REF)) found.add(match[1])
  }
  return found
}

async function listAssetNames() {
  try {
    return (await readdir(await assetsDir())).filter((name) => ASSET_PATTERN.test(name)).sort()
  } catch {
    return []
  }
}

/** 只导出正文真正引用到的图片：孤儿本来就不该跟着备份跑。 */
async function collectAssets(referenced) {
  const dir = await assetsDir()
  const map = {}
  let bytes = 0
  let truncated = false
  for (const name of await listAssetNames()) {
    if (!referenced.has(name)) continue
    let info
    try {
      info = await stat(join(dir, name))
    } catch {
      continue
    }
    if (bytes + info.size > MAX_EXPORT_ASSET_BYTES) {
      truncated = true
      continue
    }
    try {
      map[name] = (await readFile(join(dir, name))).toString('base64')
      bytes += info.size
    } catch {
      // 单张读不出来就跳过，其余图片照常导出。
    }
  }
  return { map, bytes, count: Object.keys(map).length, truncated }
}

/* ------------------------------------------------------------------- zip */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/**
 * 最小可用的 ZIP 写入器（deflate 或 store），够 Windows / macOS / unzip 打开。
 * 没有引依赖，所以固定 1980-01-01 的 DOS 时间戳：解压顺序比时间更重要。
 */
function zipSync(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const deflated = deflateRawSync(data)
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}

/* -------------------------------------------------------------- 导出入口 */

/** JSON 备份：可直接被「导入」读回来，含被引用的图片（base64）。 */
async function buildJsonExport(options = {}) {
  const doc = await readDoc(await stateFilePath())
  const referenced = referencedAssetsOf([...doc.notes, ...doc.trash])
  const assets =
    options.includeAssets === false
      ? { map: {}, bytes: 0, count: 0, truncated: false }
      : await collectAssets(referenced)
  return {
    payload: {
      format: EXPORT_FORMAT,
      exportVersion: EXPORT_VERSION,
      exportedAt: Date.now(),
      version: doc.version,
      notes: doc.notes,
      trash: doc.trash,
      assets: assets.map,
      // stats 是随备份文件一起存下的元信息，导入时可用来核对，别当成响应的装饰。
      stats: {
        notes: doc.notes.length,
        trash: doc.trash.length,
        assets: assets.count,
        assetBytes: assets.bytes,
        truncated: assets.truncated,
        // 导出时如果读盘发生过抢救/留档，让备份文件自己带上事实，别让用户以为导全了。
        recovered: doc.recovered === true,
        dropped: doc.dropped || 0,
      },
    },
  }
}

function markdownOf(note, index) {
  const title = String(note.title || '').trim() || `Note ${index + 1}`
  const meta = [formatTime(note.updatedAt), note.pinned === true ? 'pinned' : '', note.color || '']
    .filter(Boolean)
    .join(' · ')
  const body = String(note.body || '').trim()
  const head = `# ${title}`
  const quote = meta === '' ? '' : `\n\n> ${meta}`
  return body === '' ? `${head}${quote}` : `${head}${quote}\n\n${body}`
}

function formatTime(ts) {
  if (!Number.isFinite(ts)) return ''
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Markdown 归档：一条便签一节。带图片时打成 zip（`sticky-notes.md` + `assets/`），
 * 这样正文里的 `![](assets/x.png)` 解压后仍然有效。
 */
async function buildMarkdownExport(options = {}) {
  const doc = await readDoc(await stateFilePath())
  const referenced = referencedAssetsOf(doc.notes)
  const stamp = stampOf()
  const header = [
    '<!-- exported by dsh-sticky-notes -->',
    '',
    `_${doc.notes.length} notes · ${new Date().toISOString().slice(0, 10)}_`,
    '',
  ].join('\n')
  const markdown = [header, ...doc.notes.map((note, index) => markdownOf(note, index))].join('\n\n---\n\n')

  if (options.includeAssets === false) {
    return {
      filename: `sticky-notes-${stamp}.md`,
      contentType: 'text/markdown; charset=utf-8',
      buffer: Buffer.from(`${markdown}\n`, 'utf8'),
    }
  }

  const dir = await assetsDir()
  const entries = [{ name: 'sticky-notes.md', data: Buffer.from(`${markdown}\n`, 'utf8') }]
  let bytes = 0
  for (const name of await listAssetNames()) {
    if (!referenced.has(name)) continue
    let info
    try {
      info = await stat(join(dir, name))
    } catch {
      continue
    }
    if (bytes + info.size > MAX_EXPORT_ASSET_BYTES) continue
    try {
      entries.push({ name: `assets/${name}`, data: await readFile(join(dir, name)) })
      bytes += info.size
    } catch {
      // 读不到就跳过，Markdown 里那张图会变成断链，不影响其余内容。
    }
  }
  return {
    filename: `sticky-notes-${stamp}.zip`,
    contentType: 'application/zip',
    buffer: zipSync(entries),
  }
}

/* -------------------------------------------------------------- 导入入口 */

/** 图片随备份一起回填：同名文件已存在就跳过，绝不覆盖。 */
async function writeAssets(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return { ...NO_ASSETS }
  let skipped = 0
  const entries = []
  for (const [name, value] of Object.entries(map)) {
    if (!ASSET_PATTERN.test(name) || typeof value !== 'string') {
      skipped += 1
      continue
    }
    const buffer = Buffer.from(value, 'base64')
    if (buffer.length === 0 || buffer.length > MAX_ASSET_BYTES) {
      skipped += 1
      continue
    }
    entries.push({ name, buffer })
  }
  if (entries.length === 0) return { ...NO_ASSETS, skipped }
  if (entries.length > MAX_IMPORT_ASSETS) {
    throw coded(413, 'error.proto.tooManyAssets', `at most ${MAX_IMPORT_ASSETS} images per import`)
  }

  const dir = await assetsDir()
  await mkdir(dir, { recursive: true })
  let written = 0
  let exists = 0
  let failed = 0
  let bytes = 0
  // 分批并行：串行写几百个小文件会把跨进程写锁占住超过 LOCK_TIMEOUT_MS，
  // 另一个窗口/ MCP 进程就会开始 503。
  for (let start = 0; start < entries.length; start += ASSET_BATCH) {
    const batch = entries.slice(start, start + ASSET_BATCH)
    const results = await Promise.all(
      batch.map(async (entry) => {
        try {
          await writeFile(join(dir, entry.name), entry.buffer, { mode: 0o600, flag: 'wx' })
          return { ok: true, size: entry.buffer.length }
        } catch (caught) {
          // 同名已存在是预期情况（保留本地那份）；其余是真实 IO 失败，要能被上层看见。
          return { ok: false, exists: Boolean(caught && caught.code === 'EEXIST') }
        }
      }),
    )
    for (const item of results) {
      if (item.ok) {
        written += 1
        bytes += item.size
      } else if (item.exists) {
        exists += 1
      } else {
        failed += 1
      }
    }
  }
  return { written, exists, failed, skipped, bytes }
}

/**
 * 导入备份。
 * - `merge`（默认）：按 id 合并，同 id 取 updatedAt 更新的那条；新增的排在前面。
 * - `replace`：整份替换便签（回收站保持不动），等价于 `PUT /state`。
 * 图片在版本校验通过之后才落盘——否则这里就是个没有版本门槛的写盘入口。
 */
async function importData(payload = {}) {
  const mode = payload.mode === 'replace' ? 'replace' : 'merge'
  const baseVersion = Number.isFinite(payload.baseVersion) ? payload.baseVersion : null
  if (!Array.isArray(payload.notes)) {
    throw coded(400, 'error.proto.invalidBody', 'notes must be an array')
  }
  // replace 是破坏性操作，和 PUT /state 一样严格：超量或脏条目直接 400，不静默截断。
  // merge 更宽容：坏条目跳过并单独计入 dropped，让能导入的都进来。
  let incoming
  let dropped = 0
  if (mode === 'replace') {
    incoming = sanitizeNotes(payload)
  } else {
    const salvaged = salvageNotes(payload)
    incoming = salvaged.notes
    dropped = salvaged.dropped
  }

  const result = await serialized(async () => {
    const filePath = await stateFilePath()
    const doc = await readDoc(filePath)
    if (baseVersion !== null && baseVersion !== doc.version) return { conflict: doc }

    if (mode === 'replace') {
      const assets = await writeAssets(payload.assets)
      const version = doc.version + 1
      await writeDoc(filePath, { version, notes: incoming, trash: doc.trash })
      return { version, mode, added: incoming.length, updated: 0, skipped: 0, dropped, overflow: 0, assets }
    }

    const merged = []
    const seen = new Set()
    let added = 0
    let updated = 0
    let stale = 0
    // 本地原有便签优先保留：只有「本地根本没有的新增」才占名额，名额用完就丢掉新增。
    // 反过来先塞新增再裁到 200 条，裁掉的会是本地数据，而界面上完全看不出来。
    const room = Math.max(0, MAX_NOTES - doc.notes.length)
    let overflow = 0
    for (const note of incoming) {
      // 备份文件里可能有重复 id（手工改过 / 合并过别的备份），只认第一条，别写出两张同 id 的卡。
      if (seen.has(note.id)) {
        stale += 1
        continue
      }
      seen.add(note.id)
      const existing = doc.notes.find((item) => item.id === note.id)
      if (existing === undefined) {
        if (added >= room) {
          overflow += 1
          continue
        }
        merged.push(note)
        added += 1
        continue
      }
      if ((note.updatedAt || 0) > (existing.updatedAt || 0)) {
        merged.push(note)
        updated += 1
      } else {
        merged.push(existing)
        stale += 1
      }
    }
    for (const note of doc.notes) {
      if (!seen.has(note.id)) merged.push(note)
    }
    // 走到这里一定塞得下：覆盖不改变条数，新增已经在 room 里卡过。
    const notes = merged.slice(0, MAX_NOTES)
    const stats = { mode, added, updated, skipped: stale + dropped + overflow, dropped, overflow }
    if (added === 0 && updated === 0) {
      // 什么都没变就别写盘，图片也别落——落了也没人引用，只会变成孤儿。
      return { ...stats, version: doc.version, assets: { ...NO_ASSETS } }
    }
    const assets = await writeAssets(payload.assets)
    const version = doc.version + 1
    await writeDoc(filePath, { version, notes, trash: doc.trash })
    return { ...stats, version, assets }
  })

  if (result.conflict) {
    const error = coded(409, 'error.state.conflict', 'state version mismatch')
    error.doc = result.conflict
    throw error
  }
  return result
}

/* ------------------------------------------------------------ 图片占用审计 */

/**
 * 孤儿宽限期：刚上传、引用还没写进 notes.json 的图片不算孤儿。
 * 客户端有 600ms 防抖，另一个窗口也可能正在编辑，留一分钟最省事。
 */
const ORPHAN_GRACE_MS = 60 * 1000

/** 扫描 assets 与正文引用，算出总量、可清理孤儿与断链。 */
async function auditAssets() {
  const dir = await assetsDir()
  const names = await listAssetNames()
  const doc = await readState()
  const referenced = referencedAssetsOf([...doc.notes, ...doc.trash])
  const now = Date.now()
  const orphans = []
  let bytes = 0
  let orphanBytes = 0
  let recent = 0
  for (const name of names) {
    let info
    try {
      info = await stat(join(dir, name))
    } catch {
      continue
    }
    bytes += info.size
    if (referenced.has(name)) continue
    const age = now - info.mtimeMs
    // 刚落盘但引用还没写进数据的，先当「新上传」放着，不算可清理。
    // 未来时间戳（跨机器拷贝 / 时钟回拨）按「已经足够老」处理，否则永远清不掉。
    if (age >= 0 && age < ORPHAN_GRACE_MS) {
      recent += 1
      continue
    }
    orphans.push({ name, size: info.size })
    orphanBytes += info.size
  }
  orphans.sort((a, b) => b.size - a.size)
  // 只回统计值：孤儿明细给 pruneAssets 内部用，断链文件名也不往浏览器发。
  return {
    total: names.length,
    bytes,
    orphanCount: orphans.length,
    orphanBytes,
    recent,
    orphans,
    missingCount: [...referenced].filter((name) => !names.includes(name)).length,
  }
}

/**
 * 删除没有被任何便签（含回收站）引用的图片。
 * 放在写锁里重新审计：锁外算出来的孤儿，可能刚被另一个窗口的导入引用上。
 */
async function pruneAssets() {
  return serialized(async () => {
    const report = await auditAssets()
    const dir = await assetsDir()
    let removed = 0
    let bytes = 0
    for (const item of report.orphans) {
      try {
        await rm(join(dir, item.name), { force: true })
        removed += 1
        bytes += item.size
      } catch {
        // 文件被占用就跳过，下次再清。
      }
    }
    return { removed, bytes, remaining: report.total - removed }
  })
}

export { auditAssets, buildJsonExport, buildMarkdownExport, importData, pruneAssets }
