// 离线修复：把「会话日志头 cwd 已指向某工作区路径、但工作区登记表里没有」的会话补登记。
// 必须在 DSH 完全退出后运行（运行中改 workspace.json 会被宿主覆盖）。
// 用法: node fix-workspace-sessions.mjs [--dry]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const DRY = process.argv.includes('--dry')
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || 'C:/Users/Administrator', '.dsh')
const WS_FILE = path.join(HOME, 'storages', 'workspace.json')
const SESSIONS = path.join(HOME, 'sessions')
const TRASH = path.join(HOME, 'trash')

function frameLength(buf, off) {
  let p = off + 4
  const d = buf[p]; p += 1
  const fcsFlag = d >> 6, single = (d >> 5) & 1, checksum = (d >> 2) & 1, dictFlag = d & 3
  if (!single) p += 1
  p += [0, 1, 2, 4][dictFlag]
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  for (;;) {
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16); p += 3
    const last = h & 1, type = (h >> 1) & 3, size = h >>> 3
    p += type === 1 ? 1 : size
    if (last) break
  }
  if (checksum) p += 4
  return p - off
}

function readHeader(file) {
  const buf = fs.readFileSync(file)
  const len = frameLength(buf, 0)
  const text = zlib.zstdDecompressSync(buf.subarray(0, len)).toString('utf8')
  return JSON.parse(text.split('\n')[0])
}

const norm = (value) => String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

// 旧版本写日志时把整个正文塞进第一帧，DSH 会判为损坏：拆成 header 单帧 + 正文帧
function decodeFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const len = frameLength(buf, off)
    frames.push({ buffer: buf.subarray(off, off + len), text: zlib.zstdDecompressSync(buf.subarray(off, off + len)).toString('utf8') })
    off += len
  }
  return frames
}

function splitFirstFrame(file) {
  const buf = fs.readFileSync(file)
  const frames = decodeFrames(buf)
  const firstLines = (frames[0]?.text ?? '').split('\n')
  const meaningful = firstLines.filter((line) => line.trim().length > 0)
  if (meaningful.length <= 1) return false
  const headerLine = meaningful[0]
  const restOfFirst = meaningful.slice(1)
  const parts = [zlib.zstdCompressSync(Buffer.from(`${headerLine}\n`, 'utf8'))]
  if (restOfFirst.length > 0) parts.push(zlib.zstdCompressSync(Buffer.from(restOfFirst.map((line) => `${line}\n`).join(''), 'utf8')))
  for (const frame of frames.slice(1)) parts.push(frame.buffer)
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, Buffer.concat(parts))
  fs.renameSync(temp, file)
  return true
}

// 1) 扫会话
const byCwd = new Map()
let scanned = 0
let frameFixed = 0
for (const project of fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS, { withFileTypes: true }) : []) {
  if (!project.isDirectory()) continue
  const projectDir = path.join(SESSIONS, project.name)
  for (const dir of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const log = path.join(projectDir, dir.name, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(log)) continue
    try {
      const frames = decodeFrames(fs.readFileSync(log))
      const meaningful = (frames[0]?.text ?? '').split('\n').filter((line) => line.trim().length > 0)
      if (meaningful.length > 1) {
        if (DRY) {
          console.log(`  [dry] 首帧多行，需要拆分：${dir}`)
        } else if (splitFirstFrame(log)) {
          frameFixed += 1
        }
      }
      const header = readHeader(log)
      const cwd = header.cwd
      if (!cwd) continue
      scanned += 1
      const key = norm(cwd)
      if (!byCwd.has(key)) byCwd.set(key, [])
      byCwd.get(key).push(String(header.id || dir.name))
    } catch {
      /* 跳过读不出的会话 */
    }
  }
}

// 2) 读登记表
const raw = fs.readFileSync(WS_FILE, 'utf8')
const wsDoc = JSON.parse(raw)
const workspaces = wsDoc?.tables?.workspaces ?? {}

let added = 0
const changed = []
for (const [id, workspace] of Object.entries(workspaces)) {
  const key = norm(workspace.path)
  const candidates = byCwd.get(key) ?? []
  const existing = new Set((workspace.sessionIds || []).map(String))
  const missing = candidates.filter((sessionId) => !existing.has(sessionId))
  if (missing.length === 0) continue
  changed.push({ workspace: workspace.title || workspace.path, path: workspace.path, add: missing.length })
  if (!DRY) {
    workspace.sessionIds = [...(workspace.sessionIds || []), ...missing]
    workspace.updatedAt = new Date().toISOString()
    added += missing.length
  }
}

console.log(`扫描会话 ${scanned} 个，工作区 ${Object.keys(workspaces).length} 个`)
for (const item of changed) console.log(`  + ${item.add} 个会话 → ${item.workspace}（${item.path}）`)

if (DRY) {
  console.log('dry-run：未写入')
} else if (changed.length === 0) {
  console.log('没有需要补登记的会话')
} else {
  fs.mkdirSync(TRASH, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = path.join(TRASH, `workspace-json-before-fix-${stamp}.json`)
  fs.copyFileSync(WS_FILE, backup)
  fs.writeFileSync(WS_FILE, JSON.stringify(wsDoc, null, 2))
  console.log(`已补登记 ${added} 个会话；原文件备份 ${backup}`)
}
