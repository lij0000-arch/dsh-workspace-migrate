import { promises as fsp } from 'node:fs'
import { join, resolve, basename, dirname, relative, isAbsolute, parse } from 'node:path'
import { homedir, hostname, platform, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib'

/**
 * Host half of the migration plugin: exports the three durable layers of a
 * Harness install (workspace registry, session logs, project files) into one
 * portable folder, and replays that folder on another machine through the
 * public `sessionPersistence` / `workspaceRegistry` services.
 */

const ROUTE_PREFIX = '/api/dsh-migrate'
const BUNDLE_SCHEMA = 1
const BUNDLE_KIND = 'dsh-migration-bundle'
const SELF_PACKAGE = 'dsh-workspace-migrate'
const DEFAULT_EXCLUDES = ['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.pnpm-store', 'dist', '.next']
const MAX_TASKS = 20

export const name = 'dsh-migrate'
export const inject = ['sessionPersistence', 'workspaceRegistry', 'webServer']

export function apply(ctx, config = {}) {
  const excludes = new Set(
    (Array.isArray(config.excludeDirs) && config.excludeDirs.length ? config.excludeDirs : DEFAULT_EXCLUDES)
      .map((entry) => String(entry).toLowerCase()),
  )
  const tasks = new Map()
  // Rollback may only remove what THIS process created, so a stray or forged
  // request can never delete an unrelated session or project registration.
  const createdWorkspaces = new Set()
  const createdSessions = new Set()

  // ── small helpers ────────────────────────────────────────────────────────

  function dshHome() {
    const fromEnv = process.env.DSH_HOME
    if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv)
    return join(homedir(), '.dsh')
  }

  async function pathExists(path) {
    try {
      await fsp.access(path)
      return true
    } catch {
      return false
    }
  }

  /** Node's built-in Zstandard, when this runtime has it. */
  async function loadZstd() {
    try {
      const zlib = await import('node:zlib')
      if (typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function') return zlib
    } catch {
      /* older runtime: session files stay plain JSON */
    }
    return null
  }

  function safeName(id) {
    return String(id).replace(/[^A-Za-z0-9._-]+/g, '_')
  }

  function stamp() {
    // Local time, not UTC: the folder name is read by a person on this machine.
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  }

  function localDay() {
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  }

  function normalKey(path) {
    // A single backslash must become "/", so the pattern is /\\/ (source text),
    // not /\\\\/ which would only match a doubled separator.
    const text = String(path).replace(/\\/g, '/')
    return process.platform === 'win32' || process.platform === 'darwin' ? text.toLowerCase() : text
  }

  /** Path style of an OS name: Windows uses backslashes, everything else slashes. */
  function styleOfPlatform(name) {
    return name === 'win32' ? 'win' : 'posix'
  }

  /** Accept only the three platforms this plugin can describe, or null. */
  function normalizeTargetPlatform(value) {
    const text = String(value ?? '').trim()
    if (text === 'win32' || text === 'darwin' || text === 'linux') return text
    return null
  }

  /** Characters Windows refuses in a file name. */
  const WINDOWS_BAD_NAME = /[<>:"/\\|?*\u0000-\u001f]/

  /** True when this name cannot exist on Windows (and would need renaming). */
  function illegalOnWindows(name) {
    const base = String(name)
    if (WINDOWS_BAD_NAME.test(base)) return true
    if (/[. ]$/.test(base)) return true
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)
  }

  /**
   * Convert separators inside the part of a path that follows a remapped root.
   * Windows-to-POSIX may span spaces (backslashes are rare in prose), while
   * POSIX-to-Windows must stop at whitespace so shell text is not rewritten.
   */
  function convertSeparators(tail, toStyle) {
    if (!tail) return tail
    return toStyle === 'posix' ? tail.replace(/\\/g, '/') : tail.replace(/\//g, '\\')
  }
  function trimSep(path) {
    return String(path).replace(/[\\/]+$/, '')
  }

  function mapPath(path, pairs) {
    if (!path) return path
    const key = normalKey(path)
    for (const pair of pairs) {
      const fromKey = normalKey(trimSep(pair.from))
      const toKey = trimSep(pair.to)
      if (key === fromKey) return toKey
      if (key.startsWith(fromKey + '\\') || key.startsWith(fromKey + '/')) {
        return toKey + String(path).slice(trimSep(pair.from).length)
      }
    }
    return path
  }

  async function dirSize(path) {
    let total = 0
    let stack = [path]
    while (stack.length > 0) {
      const current = stack.pop()
      let entries
      try {
        entries = await fsp.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.isFile()) {
          try {
            total += (await fsp.stat(full)).size
          } catch {
            /* unreadable entry does not fail the report */
          }
        }
      }
    }
    return total
  }

  /**
   * Snapshot a directory tree as `relative/path -> [size, mtimeMs]`, skipping
   * the rebuildable directories in `skipNames`. Keys use forward slashes so a
   * bundle written on Windows can be updated from the same relative spelling.
   */
  async function walkFiles(root, skipNames) {
    const result = new Map()
    const stack = ['']
    while (stack.length > 0) {
      const relative = stack.pop()
      const absolute = relative ? join(root, relative) : root
      let entries
      try {
        entries = await fsp.readdir(absolute, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (skipNames.has(entry.name.toLowerCase())) continue
          stack.push(child)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const info = await fsp.stat(join(root, child))
          result.set(child, [info.size, Math.round(info.mtimeMs)])
        } catch {
          /* an unreadable file is left out of the state and copied again next time */
        }
      }
    }
    return result
  }

  /** A filesystem-safe single path segment derived from a project title. */
  function safeSegment(value, fallback) {
    const cleaned = String(value ?? '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '')
    return cleaned.length > 0 ? cleaned.slice(0, 80) : String(fallback ?? 'workspace')
  }

  /**
   * Normalize a user-supplied target path by its own style, so a POSIX root
   * such as `/home/evan` never keeps Windows separators pasted from a bundle
   * that came from Windows (and a `D:\...` root keeps backslashes on Windows).
   */
  function normalizeTargetPath(value) {
    const text = String(value ?? '').trim()
    if (text.startsWith('/')) return text.replace(/\\/g, '/')
    if (/^[A-Za-z]:[\\/]/.test(text)) return text.replace(/\//g, '\\')
    return text
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * Rewrite absolute paths of the remapped roots inside one JSON value, in
   * place. This is what keeps a restored conversation usable: tool calls and
   * results still name the old machine's paths, and the model would chase
   * files that no longer exist there.
   */
  function rewritePaths(value, pairs, stats, depth = 0) {
    if (depth > 12) return value
    if (typeof value === 'string') {
      let text = value
      for (const pair of pairs) {
        if (pair.from === pair.to) continue
        const toStyle = pair.toStyle ?? styleOfPlatform(process.platform)
        const variants = [
          [pair.from, pair.to],
          [String(pair.from).replace(/\\/g, '/'), String(pair.to).replace(/\\/g, '/')],
        ]
        // Spanning spaces is safe when converting to POSIX, because backslashes
        // are rare in prose; the other direction stops at whitespace so shell
        // text that follows a path is never turned into backslashes.
        const tailSource = toStyle === 'posix' ? '([\\\\/][^\\r\\n"\'`<>|]*)?' : '([\\\\/][^\\s"\'`<>|]*)?'
        for (const [from, to] of variants) {
          if (!from || from.length < 4) continue
          const pattern = new RegExp(escapeRegExp(from) + tailSource, 'gi')
          text = text.replace(pattern, (matched) => {
            stats.count += 1
            const rest = matched.slice(from.length)
            return to + convertSeparators(rest, toStyle)
          })
        }
      }
      return text
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) value[index] = rewritePaths(value[index], pairs, stats, depth + 1)
      return value
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) value[key] = rewritePaths(value[key], pairs, stats, depth + 1)
      return value
    }
    return value
  }

  function isUnderTargets(path, targets) {
    const key = normalKey(path)
    return targets.some((entry) => {
      const root = normalKey(entry.target)
      return key === root || key.startsWith(root + '\\') || key.startsWith(root + '/')
    })
  }

  /** Read the registry's global archive/pin sets from the durable unit file. */
  async function readRegistrySets(home) {
    try {
      const text = await fsp.readFile(join(home, 'storages', 'workspace.json'), 'utf8')
      const parsed = JSON.parse(text)
      const global = parsed.global ?? {}
      return {
        archived: Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds.map(String) : [],
        pinned: Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds.map(String) : [],
        order: Array.isArray(global.workspaceIds) ? global.workspaceIds.map(String) : [],
      }
    } catch {
      return { archived: [], pinned: [], order: [] }
    }
  }

  /** Where the last import's created ids are remembered, so undo survives a reload. */
  function lastImportPath(home) {
    return join(home, 'migrations', 'last-import.json')
  }

  async function readLastImport() {
    try {
      const record = JSON.parse(await fsp.readFile(lastImportPath(dshHome()), 'utf8'))
      if (!record || record.undone === true) return null
      return record
    } catch {
      return null
    }
  }

  async function writeLastImport(record) {
    try {
      await fsp.mkdir(join(dshHome(), 'migrations'), { recursive: true })
      await fsp.writeFile(lastImportPath(dshHome()), JSON.stringify(record, null, 2))
    } catch {
      /* remembering is a convenience, never a reason to fail an import */
    }
  }

  /**
   * Check whether the last import can still be undone safely. Continuing a chat
   * in an imported Session adds events, and deleting that Session would throw
   * those away, so any growth flips the record to unsafe.
   */
  /** 会进入模型上下文的文本量（只算 surface 事件里的文本块）。 */
  function surfaceTextLength(events) {
    let total = 0
    for (const event of events) {
      if (!event || event.surfaceOp === undefined) continue
      const blocks = event.data?.message?.content ?? event.data?.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) if (block && typeof block.text === 'string') total += block.text.length
    }
    return total
  }

  /**
   * 裁剪后回合号不再从 1 开始，读取器会报 "turn/start does not open the expected
   * turn"。把 turn/step 重新从 1 编号，并同步所有事件里的 data.turn / data.step。
   */
  function renumberTurns(events) {
    const turnMap = new Map()
    const stepMaps = new Map()
    let nextTurn = 1
    for (const event of events) {
      const type = String(event && event.type)
      if (type === 'turn/start') {
        const old = event.data?.turn
        if (typeof old === 'number' && !turnMap.has(old)) turnMap.set(old, nextTurn)
        nextTurn += 1
        continue
      }
      if (type === 'step/start') {
        const turn = event.data?.turn
        const mappedTurn = turnMap.has(turn) ? turnMap.get(turn) : turn
        if (!stepMaps.has(mappedTurn)) stepMaps.set(mappedTurn, new Map())
        const map = stepMaps.get(mappedTurn)
        const old = event.data?.step
        if (typeof old === 'number' && !map.has(old)) map.set(old, map.size + 1)
      }
    }
    if (turnMap.size === 0) return events
    for (const event of events) {
      const data = event && event.data
      if (!data || typeof data !== 'object') continue
      if (typeof data.turn === 'number' && turnMap.has(data.turn)) {
        const mappedTurn = turnMap.get(data.turn)
        data.turn = mappedTurn
        if (typeof data.step === 'number') {
          const map = stepMaps.get(mappedTurn)
          if (map && map.has(data.step)) data.step = map.get(data.step)
        }
      }
    }
    return events
  }
  /**
   * v4 读取器要求「表层」的第一个事件是受保护的 system/message。兼容模式会裁剪、
   * 丢弃记账事件，极端情况下头部可能整段缺失（导入后能读、聊一阵子才报
   * "system/message requires a protected first surface head"）。这里兜底补一条：
   * 优先复用日志里现存的 system/message 内容（通常是切换审批策略时重发的系统
   * 提示词），插到第一个 step/start 之后，让 turn/step 上下文保持有效。
   */
  function ensureProtectedHead(events) {
    const firstSurfaceIndex = events.findIndex((event) => event && event.surfaceOp !== undefined)
    if (firstSurfaceIndex >= 0 && String(events[firstSurfaceIndex].type) === 'system/message') {
      return { events, inserted: 0 }
    }
    const template = events.find((event) => event && String(event.type) === 'system/message' && event.data && event.data.message)
    let message
    if (template) {
      message = JSON.parse(JSON.stringify(template.data.message))
      message.id = randomUUID()
    } else {
      message = {
        role: 'system',
        source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: '（系统提示词未随迁移包保留）' }],
        id: randomUUID(),
      }
    }
    let stepIndex = events.findIndex((event) => event && String(event.type) === 'step/start')
    if (stepIndex < 0 || (firstSurfaceIndex >= 0 && stepIndex > firstSurfaceIndex)) stepIndex = -1
    const insertAt = stepIndex >= 0 ? stepIndex + 1 : 0
    const context = (events[stepIndex >= 0 ? stepIndex : 0] || {}).data || {}
    const inserted = {
      type: 'system/message',
      seq: insertAt,
      time: Date.now(),
      surfaceOp: 'append',
      data: { turn: context.turn, step: context.step, message },
    }
    const next = [...events.slice(0, insertAt), inserted, ...events.slice(insertAt)]
    return { events: renumberEvents(next, null), inserted: 1, usedTemplate: Boolean(template) }
  }
  /**
   * 会话太长时只保留最近若干回合：模型窗口装不下整段历史，硬导入的结果就是
   * 「导入成功、一发消息就 CONTEXT_WINDOW_EXCEEDED」。按 surface 文本量估算 token
   * （中文约 2 字符/token），并从 turn/start 处切，保证日志从回合边界开始。
   */
  function trimToContextBudget(events, budgetChars) {
    const turns = []
    for (let i = 0; i < events.length; i += 1) if (events[i] && events[i].type === 'turn/start') turns.push(i)
    if (turns.length === 0) return { kept: events, dropped: 0, startSeq: 0 }
    // 第一条 turn/start 之前是「会话头部」：permission/preset、sandbox/mode、
    // approval/policy、session/title 与 system/message。v4 格式要求表层第一个事件
    // 必须是受保护的 system/message，头部一旦被裁掉，这条会话读回来就会报
    // "system/message requires a protected first surface head"。所以头部永远保留，
    // 只裁其中的回合。
    const head = events.slice(0, turns[0])
    // 从最早的 turn 往后找「装得下的最长后缀」，而不是从最后一个 turn 往前找一个
    // 刚好装下的（那样永远只留 1 个回合）。
    // 文本量随起点后移单调下降：第一个装得下的起点就是「最长的可保留后缀」。
    for (let k = 0; k < turns.length; k += 1) {
      const suffix = events.slice(turns[k])
      if (surfaceTextLength(suffix) <= budgetChars) {
        return { kept: [...head, ...suffix], dropped: turns[k], startSeq: turns[k], turns: turns.length - k, headKept: head.length }
      }
    }
    const last = events.slice(turns[turns.length - 1])
    return { kept: [...head, ...last], dropped: turns[turns.length - 1], startSeq: turns[turns.length - 1], turns: 1, headKept: head.length }
  }
  /**
   * 旧版 DSH 在压缩时会重放早先的 tool/result 等事件，它们带着旧 turn/step 却落在
   * 当前 turn 中间。新版读取器要求这些事件"落在已开启的 turn/step 内"，否则整条
   * 会话判损。兼容模式下把这类重放事件丢掉（内容在更早的位置已经存在）。
   */
  function dropOutOfTurnEvents(events) {
    const kept = []
    const dialog = new Set(['tool/call', 'tool/result', 'assistant/message', 'assistant/attempt'])
    let turn = null
    let step = null
    let dropped = 0
    for (const event of events) {
      const type = String(event && event.type)
      if (type === 'turn/start') { turn = event.data?.turn ?? null; step = null }
      else if (type === 'turn/end') { turn = null; step = null }
      else if (type === 'step/start') { step = event.data?.step ?? null }
      else if (type === 'step/end') { step = null }
      else if (dialog.has(type)) {
        const t = event.data?.turn
        const s = event.data?.step
        const mismatch = (t !== undefined && t !== turn) || (s !== undefined && s !== step)
        if (mismatch) { dropped += 1; continue }
      }
      kept.push(event)
    }
    return { kept, dropped }
  }
  /**
   * 只数「用户看得见的事件」：打开/恢复会话时宿主会追加 delivery marker 之类的
   * 记账事件，那些不算「又聊过」。记账事件可能出现在任意位置（后续消息会追加在
   * 它后面），所以整体过滤，而不是只看尾部。
   */
  function contentEventCount(events) {
    if (!Array.isArray(events)) return 0
    let count = 0
    for (const event of events) {
      if (!event) continue
      if (event.ignorable === true) continue
      if (isBookkeepingEvent(event)) continue
      count += 1
    }
    return count
  }

  async function probeLastImport() {
    const record = await readLastImport()
    if (!record) return null
    const counts = record.counts && typeof record.counts === 'object' ? record.counts : {}
    const contentCounts = record.contentCounts && typeof record.contentCounts === 'object' ? record.contentCounts : {}
    const changed = []
    const missing = []
    for (const id of Object.keys(counts)) {
      // 老记录没有 contentCounts：用原始计数当上限，配合内容计数比较（只会更宽松，
      // 不会把「打开过」误判成「聊过」）。
      const recorded = Number.isFinite(contentCounts[id]) ? contentCounts[id] : counts[id]
      try {
        const handle = await ctx.sessionPersistence.open(id, 'read')
        try {
          const { events } = await handle.read()
          const current = contentEventCount(events)
          if (current > recorded) changed.push({ id, recorded, current })
        } finally {
          await handle.close()
        }
      } catch {
        missing.push(id)
      }
    }
    return {
      ...record,
      changed,
      missing,
      safe: changed.length === 0,
    }
  }
  async function clearLastImport() {
    try {
      await fsp.rm(lastImportPath(dshHome()), { force: true })
    } catch {
      /* nothing to clear */
    }
  }
  /** Where bundles exported outside the default folder are remembered. */
  function recentBundlesPath(home) {
    return join(home, 'migrations', 'recent-bundles.json')
  }

  /** Recently exported bundle paths that still exist; missing ones are pruned. */
  async function readRecentBundlePaths() {
    const home = dshHome()
    let stored = []
    try {
      const raw = JSON.parse(await fsp.readFile(recentBundlesPath(home), 'utf8'))
      stored = Array.isArray(raw) ? raw.map(String) : []
    } catch {
      return []
    }
    const alive = []
    for (const path of stored) {
      if (await pathExists(join(path, 'manifest.json'))) alive.push(path)
    }
    if (alive.length !== stored.length) {
      try {
        await fsp.mkdir(join(home, 'migrations'), { recursive: true })
        await fsp.writeFile(recentBundlesPath(home), JSON.stringify(alive, null, 2))
      } catch {
        /* pruning is best effort */
      }
    }
    return alive
  }

  async function rememberBundle(path) {
    try {
      const home = dshHome()
      const previous = await readRecentBundlePaths()
      const next = [path, ...previous.filter((item) => item !== path)].slice(0, 8)
      await fsp.mkdir(join(home, 'migrations'), { recursive: true })
      await fsp.writeFile(recentBundlesPath(home), JSON.stringify(next, null, 2))
    } catch {
      /* remembering is a convenience */
    }
  }

  async function bundleSummary(path) {
    try {
      const manifest = JSON.parse(await fsp.readFile(join(path, 'manifest.json'), 'utf8'))
      if (manifest.kind !== BUNDLE_KIND) return null
      return {
        path,
        name: basename(path),
        createdAt: manifest.createdAt ?? null,
        formatVersion: manifest.formatVersion ?? null,
        workspaces: Array.isArray(manifest.workspaces) ? manifest.workspaces.length : 0,
        sessions: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
        sourceHost: manifest.source?.host ?? null,
        bytes: manifest.bytes ?? null,
      }
    } catch {
      return null
    }
  }

  /** Summary of a single-file bundle, from the manifest inside the archive. */
  async function archiveSummary(path) {
    const manifest = await readArchiveManifest(path)
    if (!manifest) return null
    let bytes = null
    try {
      bytes = (await fsp.stat(path)).size
    } catch {
      bytes = null
    }
    return {
      path,
      name: basename(path),
      file: true,
      createdAt: manifest.createdAt ?? null,
      formatVersion: manifest.formatVersion ?? null,
      workspaces: Array.isArray(manifest.workspaces) ? manifest.workspaces.length : 0,
      sessions: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
      sourceHost: manifest.source?.host ?? null,
      bytes: bytes ?? manifest.bytes ?? null,
    }
  }

  /**
   * How many of a bundle's Sessions already exist on this machine. The list uses
   * it to flag bundles that were imported before, so they start unchecked and
   * nobody re-parses or re-imports them by accident.
   */
  async function bundleLocalOverlap(path) {
    try {
      const manifest = looksLikeBundleFile(path) ? await readArchiveManifest(path) : await readManifest(path)
      if (!manifest) return null
      const ids = (Array.isArray(manifest.sessions) ? manifest.sessions : [])
        .filter((entry) => entry && entry.origin !== 'subagent')
        .map((entry) => String(entry.id))
      const localIds = new Set((await ctx.sessionPersistence.list()).map((snapshot) => String(snapshot.header.id)))
      const existing = ids.filter((id) => localIds.has(id)).length
      return { sessions: ids.length, existing }
    } catch {
      return null
    }
  }

  /**
   * Find importable bundles inside one directory. The desktop picker only
   * returns folders, so after the user picks a folder we look inside it for
   * .dshmig files (and legacy folder bundles) instead of asking them to type a
   * file path by hand.
   */
  async function scanBundleDir(dirPath) {
    const root = resolve(String(dirPath ?? ''))
    const found = []
    let entries = []
    try {
      entries = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return { dir: root, bundles: [], error: '目录不存在或无法读取' }
    }
    for (const entry of entries) {
      const full = join(root, entry.name)
      if (entry.isFile() && entry.name.toLowerCase().endsWith(BUNDLE_FILE_EXT)) {
        const summary = await archiveSummary(full)
        if (summary) {
          const overlap = await bundleLocalOverlap(full)
          found.push({ ...summary, existing: overlap ? overlap.existing : 0, total: overlap ? overlap.sessions : summary.sessions })
        }
      } else if (entry.isDirectory()) {
        const summary = await bundleSummary(full)
        if (summary) {
          const overlap = await bundleLocalOverlap(full)
          found.push({ ...summary, existing: overlap ? overlap.existing : 0, total: overlap ? overlap.sessions : summary.sessions })
        }
      }
    }
    found.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    return { dir: root, bundles: found }
  }

  async function listBundles() {
    const root = join(dshHome(), 'migrations')
    const bundles = []
    const seen = new Set()
    let entries = []
    try {
      entries = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        if (entry.name.toLowerCase().endsWith(BUNDLE_FILE_EXT)) {
          const single = await archiveSummary(join(root, entry.name))
          if (single) {
            seen.add(single.path)
            bundles.push(single)
          }
        }
        continue
      }
      const summary = await bundleSummary(join(root, entry.name))
      if (!summary) continue
      seen.add(summary.path)
      bundles.push(summary)
    }
    for (const path of await readRecentBundlePaths()) {
      if (seen.has(path)) continue
      const summary = await bundleSummary(path)
      if (!summary) continue
      seen.add(path)
      bundles.push(summary)
    }
    bundles.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    return bundles
  }

  // ── inventory ────────────────────────────────────────────────────────────

  async function inventory() {
    const home = dshHome()
    const workspaces = ctx.workspaceRegistry.list().map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      createdAt: workspace.createdAt,
      sessionIds: [...workspace.sessionIds].map(String),
    }))
    let sessions = []
    try {
      const snapshots = await ctx.sessionPersistence.list()
      sessions = snapshots.map((snapshot) => ({
        id: String(snapshot.header.id),
        cwd: snapshot.header.cwd ?? null,
        createdAt: snapshot.header.createdAt ?? null,
        parent: snapshot.header.parentSession ? String(snapshot.header.parentSession) : null,
        seeded: Boolean(snapshot.header.isSeeded),
        agentPreset: snapshot.header.agentPreset ?? null,
        bytes: snapshot.sizeBytes ?? null,
        format: snapshot.formatStatus ?? null,
      }))
    } catch (error) {
      sessions = []
    }
    const sets = await readRegistrySets(home)
    const attachmentsRoot = join(home, 'attachments')
    let plugins = null
    try {
      plugins = await readProfilePlugins(home)
    } catch {
      plugins = null
    }
    return {
      home,
      migrationsDir: join(home, 'migrations'),
      codeVersion: 13,
      hostPlatform: platform(),
      workspaces,
      sessions,
      archived: sets.archived,
      pinned: sets.pinned,
      hasAttachments: await pathExists(attachmentsRoot),
      bundles: await listBundles(),
      excludes: [...excludes],
      plugins,
      lastImport: await readLastImport(),
    }
  }

  // ── single-file bundle (.dshmig = stored ZIP) ─────────────────────────────

  /**
   * A bundle is hundreds of loose files, which is awkward to hand over and easy
   * to damage with one stray copy. The single-file form keeps the same internal
   * layout but wraps it in a stored (uncompressed) ZIP: sessions are already
   * zstd frames, so deflating them again wastes time, and storing lets an
   * incremental update copy unchanged payloads byte for byte.
   */
  const BUNDLE_FILE_EXT = '.dshmig'

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
    return table
  })()

  function crc32(buffer) {
    let crc = 0xffffffff
    for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }

  /** Collect every regular file under `root`, as POSIX-style relative names. */
  async function collectBundleFiles(root, prefix = '') {
    const out = []
    let entries = []
    try {
      entries = await fsp.readdir(join(root, prefix), { withFileTypes: true })
    } catch {
      return out
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...(await collectBundleFiles(root, relative)))
      else if (entry.isFile()) out.push(relative)
    }
    return out
  }

  /** Write one stored ZIP archive into `target`, streaming each entry. */
  async function writeBundleArchive(root, target) {
    const names = (await collectBundleFiles(root)).sort()
    const handle = await fsp.open(target, 'w')
    const central = []
    let offset = 0
    try {
      for (const name of names) {
        const data = await fsp.readFile(join(root, name))
        const nameBytes = Buffer.from(name, 'utf8')
        const crc = crc32(data)
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0x0800, 6)
        local.writeUInt16LE(0, 8)
        local.writeUInt16LE(0, 10)
        local.writeUInt16LE(0, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(data.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(nameBytes.length, 26)
        local.writeUInt16LE(0, 28)
        const entryOffset = offset
        await handle.write(local)
        await handle.write(nameBytes)
        if (data.length > 0) await handle.write(data)
        offset += local.length + nameBytes.length + data.length
        central.push({ name: nameBytes, crc, size: data.length, offset: entryOffset })
      }
      const centralStart = offset
      for (const entry of central) {
        const header = Buffer.alloc(46)
        header.writeUInt32LE(0x02014b50, 0)
        header.writeUInt16LE(20, 4)
        header.writeUInt16LE(20, 6)
        header.writeUInt16LE(0x0800, 8)
        header.writeUInt16LE(0, 10)
        header.writeUInt16LE(0, 12)
        header.writeUInt16LE(0, 14)
        header.writeUInt32LE(entry.crc, 16)
        header.writeUInt32LE(entry.size, 20)
        header.writeUInt32LE(entry.size, 24)
        header.writeUInt16LE(entry.name.length, 28)
        header.writeUInt16LE(0, 30)
        header.writeUInt16LE(0, 32)
        header.writeUInt16LE(0, 34)
        header.writeUInt16LE(0, 36)
        header.writeUInt32LE(0, 38)
        header.writeUInt32LE(entry.offset, 42)
        await handle.write(header)
        await handle.write(entry.name)
        offset += header.length + entry.name.length
      }
      const end = Buffer.alloc(22)
      end.writeUInt32LE(0x06054b50, 0)
      end.writeUInt16LE(0, 4)
      end.writeUInt16LE(0, 6)
      end.writeUInt16LE(central.length, 8)
      end.writeUInt16LE(central.length, 10)
      end.writeUInt32LE(offset - centralStart, 12)
      end.writeUInt32LE(centralStart, 16)
      end.writeUInt16LE(0, 20)
      await handle.write(end)
    } finally {
      await handle.close()
    }
    return { entries: names.length, bytes: offset + 22 }
  }

  /** Extract a stored ZIP archive into `target`; refuses paths that escape it. */
  async function readBundleArchive(archive, target) {
    const buffer = await fsp.readFile(archive)
    const endIndex = (() => {
      for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65535; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) return i
      }
      return -1
    })()
    if (endIndex < 0) throw new Error('不是有效的迁移包文件（缺少 ZIP 结束记录）')
    const count = buffer.readUInt16LE(endIndex + 10)
    let pointer = buffer.readUInt32LE(endIndex + 16)
    let written = 0
    for (let index = 0; index < count; index += 1) {
      if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('迁移包目录记录损坏')
      const method = buffer.readUInt16LE(pointer + 10)
      const size = buffer.readUInt32LE(pointer + 20)
      const nameLength = buffer.readUInt16LE(pointer + 28)
      const extraLength = buffer.readUInt16LE(pointer + 30)
      const commentLength = buffer.readUInt16LE(pointer + 32)
      const localOffset = buffer.readUInt32LE(pointer + 42)
      const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8')
      pointer += 46 + nameLength + extraLength + commentLength
      if (name.endsWith('/')) continue
      const safeName = name.replace(/\\/g, '/')
      if (safeName.startsWith('/') || safeName.split('/').includes('..')) {
        throw new Error(`迁移包里有非法路径：${name}`)
      }
      if (method !== 0) throw new Error(`迁移包条目使用了不支持的压缩方式（${method}）：${name}`)
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`迁移包条目损坏：${name}`)
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const destination = join(target, ...safeName.split('/'))
      await fsp.mkdir(dirname(destination), { recursive: true })
      await fsp.writeFile(destination, buffer.subarray(dataStart, dataStart + size))
      written += 1
    }
    return { entries: written }
  }

  /** True when the path names a single-file bundle rather than a folder. */
  function looksLikeBundleFile(path) {
    return String(path).toLowerCase().endsWith(BUNDLE_FILE_EXT)
  }

  /**
   * Random-access reader for a stored ZIP: the central directory is parsed once
   * and every entry is read straight from the file handle, so importing a bundle
   * never copies it into a temp folder first.
   */
  async function openArchiveReader(archive) {
    const handle = await fsp.open(String(archive), 'r')
    try {
      const size = (await handle.stat()).size
      const tailLength = Math.min(size, 66_000)
      const tail = Buffer.alloc(tailLength)
      await handle.read(tail, 0, tailLength, size - tailLength)
      let endIndex = -1
      for (let i = tail.length - 22; i >= 0; i -= 1) {
        if (tail.readUInt32LE(i) === 0x06054b50) {
          endIndex = i
          break
        }
      }
      if (endIndex < 0) throw new Error('不是有效的迁移包文件（缺少 ZIP 结束记录）')
      const count = tail.readUInt16LE(endIndex + 10)
      const directorySize = tail.readUInt32LE(endIndex + 12)
      const directoryOffset = tail.readUInt32LE(endIndex + 16)
      const directory = Buffer.alloc(directorySize)
      await handle.read(directory, 0, directorySize, directoryOffset)
      const entries = new Map()
      let pointer = 0
      for (let index = 0; index < count; index += 1) {
        if (directory.readUInt32LE(pointer) !== 0x02014b50) throw new Error('迁移包目录记录损坏')
        const method = directory.readUInt16LE(pointer + 10)
        const entrySize = directory.readUInt32LE(pointer + 20)
        const nameLength = directory.readUInt16LE(pointer + 28)
        const extraLength = directory.readUInt16LE(pointer + 30)
        const commentLength = directory.readUInt16LE(pointer + 32)
        const localOffset = directory.readUInt32LE(pointer + 42)
        const name = directory.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8')
        pointer += 46 + nameLength + extraLength + commentLength
        if (name.endsWith('/')) continue
        entries.set(name, { method, size: entrySize, offset: localOffset })
      }
      const readEntry = async (name) => {
        const entry = entries.get(name)
        if (!entry) return null
        if (entry.method !== 0) throw new Error(`迁移包条目使用了不支持的压缩方式：${name}`)
        const header = Buffer.alloc(30)
        await handle.read(header, 0, 30, entry.offset)
        if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`迁移包条目损坏：${name}`)
        const nameLength = header.readUInt16LE(26)
        const extraLength = header.readUInt16LE(28)
        const start = entry.offset + 30 + nameLength + extraLength
        const data = Buffer.alloc(entry.size)
        if (entry.size > 0) await handle.read(data, 0, entry.size, start)
        return data
      }
      return {
        names: () => [...entries.keys()],
        has: (name) => entries.has(name),
        sizeOf: (name) => (entries.get(name) ? entries.get(name).size : 0),
        read: readEntry,
        list: (prefix) => [...entries.keys()].filter((name) => name.startsWith(prefix)),
        close: () => handle.close(),
      }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  /**
   * One uniform view over a bundle folder or a .dshmig file: reads, existence and
   * listings behave the same, and only the folder flavour touches the disk.
   */
  async function openBundleView(path) {
    const resolved = resolve(String(path))
    if (!looksLikeBundleFile(resolved)) {
      const root = resolved
      const walk = async (prefix = '') => {
        const out = []
        let entries = []
        try {
          entries = await fsp.readdir(join(root, prefix), { withFileTypes: true })
        } catch {
          return out
        }
        for (const entry of entries) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) out.push(...(await walk(relative)))
          else if (entry.isFile()) out.push(relative)
        }
        return out
      }
      return {
        archive: false,
        root,
        has: async (name) => pathExists(join(root, name)),
        read: (name) => fsp.readFile(join(root, name)),
        list: (prefix) => walk(prefix.replace(/\/$/, '')),
        sizeOf: async (name) => {
          try {
            return (await fsp.stat(join(root, name))).size
          } catch {
            return 0
          }
        },
        close: async () => {},
      }
    }
    const reader = await openArchiveReader(resolved)
    return {
      archive: true,
      root: resolved,
      // A directory only appears as its entries, so `has('attachments')` must also
      // accept a prefix match — otherwise a .dshmig bundle reports no attachments
      // and the import silently skips them.
      has: async (name) => reader.has(name) || reader.names().some((entry) => entry.startsWith(`${name}/`)),
      read: (name) => reader.read(name),
      list: async (prefix) => {
        const base = String(prefix).replace(/\/$/, '')
        return reader.names().filter((name) => name === base || name.startsWith(`${base}/`))
      },
      sizeOf: async (name) => reader.sizeOf(name),
      close: () => reader.close(),
    }
  }

  /**
   * Sanitize one relative path for the target platform. Windows refuses a set of
   * characters and reserved names; every other platform keeps names as they are.
   * Returns null when nothing had to change.
   */
  function sanitizeRelativeName(relative, targetStyle) {
    if (targetStyle !== 'win') return null
    const parts = String(relative).split('/')
    let changed = false
    const cleaned = parts.map((part) => {
      let name = part.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
      if (name.length === 0) name = '_'
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = `_${name}`
      if (name !== part) changed = true
      return name
    })
    return changed ? cleaned.join('/') : null
  }

  /**
   * Resolve a bundle path to a directory. Folders are used as they are; a
   * single file is extracted into a temporary directory that the caller must
   * release with `cleanup`.
   */
  async function openBundleSource(path) {
    const resolved = resolve(String(path))
    if (!looksLikeBundleFile(resolved)) return { dir: resolved, archive: null, cleanup: async () => {} }
    const temp = join(tmpdir(), `dsh-migrate-${randomUUID()}`)
    await fsp.mkdir(temp, { recursive: true })
    await readBundleArchive(resolved, temp)
    return {
      dir: temp,
      archive: resolved,
      cleanup: async () => {
        try {
          await fsp.rm(temp, { recursive: true, force: true })
        } catch {
          /* the temp copy is disposable */
        }
      },
    }
  }


  /** Manifest of a single-file bundle, or null when it is not one of ours. */
  async function readArchiveManifest(archive) {
    try {
      // Read only the central directory and the one entry, never the whole file:
      // listing a folder full of multi-hundred-megabyte bundles must stay cheap.
      const reader = await openArchiveReader(archive)
      try {
        const raw = await reader.read('manifest.json')
        if (!raw) return null
        const manifest = JSON.parse(raw.toString('utf8'))
        return manifest.kind === BUNDLE_KIND ? manifest : null
      } finally {
        await reader.close()
      }
    } catch {
      return null
    }
  }

  async function readManifest(dir) {
    const manifest = JSON.parse(await fsp.readFile(join(dir, 'manifest.json'), 'utf8'))
    if (manifest.kind !== BUNDLE_KIND) throw new Error('这不是迁移包：manifest.kind 不匹配')
    if (Number(manifest.schema) > BUNDLE_SCHEMA) throw new Error(`迁移包结构版本 ${manifest.schema} 高于插件支持的 ${BUNDLE_SCHEMA}`)
    return manifest
  }

  /** Same validation, but reading through a bundle view (folder or archive). */
  async function readManifestView(view) {
    const raw = await view.read('manifest.json')
    if (!raw) throw new Error('迁移包里没有 manifest.json')
    const manifest = JSON.parse(raw.toString('utf8'))
    if (manifest.kind !== BUNDLE_KIND) throw new Error('这不是迁移包：manifest.kind 不匹配')
    if (Number(manifest.schema) > BUNDLE_SCHEMA) throw new Error(`迁移包结构版本 ${manifest.schema} 高于插件支持的 ${BUNDLE_SCHEMA}`)
    return manifest
  }

  async function preview(bundlePath) {
    if (!bundlePath) throw new Error('缺少迁移包路径')
    const view = await openBundleView(bundlePath)
    try {
      const dir = resolve(String(bundlePath))
      const manifest = await readManifestView(view)
      let workspaces = []
      try {
        const raw = await view.read('workspaces.json')
        const doc = JSON.parse(raw.toString('utf8'))
        workspaces = (doc.workspaces ?? []).map((workspace) => ({
          id: workspace.id,
          path: workspace.path,
          title: workspace.title,
          folder: workspace.folder ?? null,
          sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
          hasFiles: true,
        }))
      } catch {
        workspaces = []
      }
      const sizes = {}
      for (const workspace of workspaces) {
        const folder = workspace.folder ? String(workspace.folder) : safeName(workspace.id)
        const names = await view.list(`files/${folder}`)
        let total = 0
        for (const name of names) total += await view.sizeOf(name)
        sizes[workspace.id] = total
      }
      let plugins = null
      try {
        const raw = await view.read('plugins.json')
        const doc = JSON.parse(raw.toString('utf8'))
        plugins = {
          profile: doc.profile ?? null,
          list: Array.isArray(doc.plugins) ? doc.plugins : [],
        }
      } catch {
        plugins = null
      }
    const bundleStyle = styleOfPlatform(manifest.source?.platform ?? platform())
    const localStyle = styleOfPlatform(platform())
    const declaredTarget = normalizeTargetPlatform(manifest.target?.platform)
    const crossOs = bundleStyle !== localStyle

    return {
      path: dir,
      file: view.archive,
      crossOs,
      bundleStyle,
      localStyle,
      declaredTarget,
      illegalNames: manifest.target?.illegalNames ?? 0,
      createdAt: manifest.createdAt ?? null,
      formatVersion: manifest.formatVersion ?? null,
      source: manifest.source ?? {},
      excludes: manifest.excludes ?? [],
      sessions: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
      workspaces: workspaces.map((workspace) => ({ ...workspace, bytes: sizes[workspace.id] ?? 0 })),
      plugins,
      attachments: await view.has('attachments'),
      bytes: manifest.bytes ?? null,
    }
    } finally {
      await view.close()
    }
  }

  // ── task runner ──────────────────────────────────────────────────────────

  function startTask(kind) {
    const task = {
      id: randomUUID(),
      kind,
      phase: 'running',
      message: '准备中…',
      done: 0,
      total: 0,
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
    }
    tasks.set(task.id, task)
    while (tasks.size > MAX_TASKS) {
      const oldest = tasks.keys().next().value
      if (oldest === undefined) break
      tasks.delete(oldest)
    }
    return task
  }

  function fail(task, error) {
    task.phase = 'failed'
    task.error = error instanceof Error ? error.message : String(error)
    task.message = task.error
    task.finishedAt = Date.now()
  }

  function succeed(task, result) {
    task.phase = 'done'
    task.result = result
    task.message = '完成'
    task.finishedAt = Date.now()
  }

  function taskView(id) {
    const task = tasks.get(String(id))
    if (!task) return { error: '任务不存在或已过期' }
    return task
  }

  /**
   * Classify a profile dependency so the import page can say what is
   * restorable and what is not.
   */
  function pluginType(name, spec) {
    if (String(name).startsWith('@deepseek-ai/')) return 'official'
    const text = String(spec ?? '')
    if (text.startsWith('link:') || text.startsWith('file:')) return 'link'
    if (text.startsWith('git+') || text.startsWith('github:') || text.startsWith('gitlab:') || text.startsWith('bitbucket:')) return 'git'
    if (text.startsWith('http://') || text.startsWith('https://')) return 'tarball'
    return 'npm'
  }

  /**
   * Read the profile that hosts this plugin and list its dependencies.
   * Returns null when no profile can be read, so export never fails over it.
   */
  async function readProfilePlugins(home) {
    const root = join(home, 'profiles')
    const profiles = []
    let entries = []
    try {
      entries = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const doc = JSON.parse(await fsp.readFile(join(root, entry.name, 'package.json'), 'utf8'))
        profiles.push({ name: entry.name, doc })
      } catch {
        /* a profile without a readable package.json is simply not ours */
      }
    }
    if (profiles.length === 0) return null
    const hosting = profiles.find((profile) => Object.prototype.hasOwnProperty.call(profile.doc?.dependencies ?? {}, SELF_PACKAGE))
    const chosen = hosting ?? profiles[0]
    const deps = chosen.doc?.dependencies ?? {}
    const bundles = chosen.doc?.dsh?.profile?.bundles ?? []
    const plugins = Object.entries(deps)
      .filter(([name]) => name !== SELF_PACKAGE)
      .map(([name, spec]) => ({
        name,
        spec: String(spec ?? ''),
        type: pluginType(name, spec),
        enabled: bundles.includes(name),
      }))
    return { profile: chosen.name, profiles: profiles.map((profile) => profile.name), plugins }
  }

  // ── export ───────────────────────────────────────────────────────────────

  /** Refresh several existing bundles in one run, merging the reports. */
  async function runUpdateMany(task, options) {
    const paths = Array.isArray(options.bundlePaths) ? options.bundlePaths.map(String).filter(Boolean) : []
    if (paths.length === 0) throw new Error('没有选中的迁移包')
    const merged = {
      mode: 'update',
      path: paths[0],
      files: [],
      sessions: 0,
      sessionsReused: 0,
      subagents: 0,
      workspaces: 0,
      plugins: 0,
      bytes: 0,
      sessionBytes: 0,
      filesCopied: 0,
      filesUnchanged: 0,
      filesRemoved: 0,
      bytesCopied: 0,
      illegalNames: 0,
    }
    let index = 0
    for (const path of paths) {
      index += 1
      task.message = `增量更新第 ${index}/${paths.length} 个包：${basename(path)}`
      const one = await runExport(task, { ...options, mode: 'update', bundlePath: path })
      merged.files.push(one.path)
      merged.sessions += one.sessions ?? 0
      merged.sessionsReused += one.sessionsReused ?? 0
      merged.subagents += one.subagents ?? 0
      merged.workspaces += one.workspaces ?? 0
      merged.plugins += one.plugins ?? 0
      merged.bytes += one.bytes ?? 0
      merged.sessionBytes += one.sessionBytes ?? 0
      merged.filesCopied += one.filesCopied ?? 0
      merged.filesUnchanged += one.filesUnchanged ?? 0
      merged.filesRemoved += one.filesRemoved ?? 0
      merged.bytesCopied += one.bytesCopied ?? 0
      merged.illegalNames += one.illegalNames ?? 0
    }
    task.done += 1
    return merged
  }

  async function runExport(task, options) {
    // Updating a single-file bundle means unpacking it first; the recursive
    // call writes the archive back to the same path through archiveTarget.
    if (looksLikeBundleFile(options.bundlePath ?? '')) {
      const archiveTarget = resolve(String(options.bundlePath))
      const opened = await openBundleSource(archiveTarget)
      try {
        return await runExport(task, {
          ...options,
          bundlePath: opened.dir,
          packageFormat: 'file',
          archiveTarget,
        })
      } finally {
        await opened.cleanup()
      }
    }

    // One file per project: each project is exported on its own so the user
    // can hand over exactly the projects a machine needs, and import them all
    // in one go.
    if (options.packageFormat === 'perProject' || options.packageFormat === 'perProjectOnly') {
      const ids = Array.isArray(options.workspaceIds) ? options.workspaceIds.map(String) : []
      const results = []
      for (const id of ids) {
        results.push(await runExport(task, { ...options, workspaceIds: [id], packageFormat: 'file' }))
      }
      return {
        mode: 'perProject',
        path: results[0] ? results[0].path : null,
        files: results.map((entry) => entry.path),
        sessions: results.reduce((sum, entry) => sum + entry.sessions, 0),
        sessionsReused: results.reduce((sum, entry) => sum + entry.sessionsReused, 0),
        workspaces: results.length,
        bytes: results.reduce((sum, entry) => sum + entry.bytes, 0),
        plugins: 0,
        subagents: results.reduce((sum, entry) => sum + (entry.subagents ?? 0), 0),
        filesCopied: results.reduce((sum, entry) => sum + entry.filesCopied, 0),
        filesUnchanged: results.reduce((sum, entry) => sum + entry.filesUnchanged, 0),
        filesRemoved: results.reduce((sum, entry) => sum + entry.filesRemoved, 0),
        bytesCopied: results.reduce((sum, entry) => sum + entry.bytesCopied, 0),
        rewritten: 0,
        illegalNames: results.reduce((sum, entry) => sum + (entry.illegalNames ?? 0), 0),
      }
    }

    const targetPlatform = normalizeTargetPlatform(options.targetPlatform) ?? platform()
    const home = dshHome()
    const outRoot = options.outDir && String(options.outDir).trim() ? resolve(String(options.outDir)) : join(home, 'migrations')
    const updating = options.mode === 'update' && options.bundlePath && String(options.bundlePath).trim().length > 0
    let dir
    let previousState = null
    let bundleWorkspaceIds = null
    if (updating) {
      dir = resolve(String(options.bundlePath))
      await readManifest(dir)
      try {
        previousState = JSON.parse(await fsp.readFile(join(dir, 'state.json'), 'utf8'))
      } catch {
        throw new Error('这个迁移包没有增量状态（可能是旧版本导出的），请先做一次完整导出')
      }
      try {
        const doc = JSON.parse(await fsp.readFile(join(dir, 'workspaces.json'), 'utf8'))
        bundleWorkspaceIds = (doc.workspaces ?? []).map((workspace) => String(workspace.id))
      } catch {
        bundleWorkspaceIds = null
      }
      await fsp.mkdir(join(dir, 'sessions'), { recursive: true })
    } else {
      // A single project names the bundle after itself so the folder makes sense
      // on its own; several projects keep the neutral timestamped name and are
      // separated per project inside files/.
      const requested = Array.isArray(options.workspaceIds) ? options.workspaceIds.map(String) : []
      let label = 'dsh-migration'
      if (options.onlyPlugins) {
        label = 'dsh-plugins'
      } else if (requested.length === 1) {
        const only = ctx.workspaceRegistry.list().find((workspace) => String(workspace.id) === requested[0])
        if (only) label = safeSegment(only.title || basename(only.path), 'workspace').slice(0, 40)
      }
      const base = `${label}-${stamp()}`
      let candidate = join(outRoot, base)
      let attempt = 2
      while (await pathExists(candidate)) {
        candidate = join(outRoot, `${base}-${attempt}`)
        attempt += 1
      }
      dir = candidate
      await fsp.mkdir(join(dir, 'sessions'), { recursive: true })
    }

    task.message = '刷新会话日志…'
    await ctx.sessionPersistence.flush()

    const snapshots = await ctx.sessionPersistence.list()
    const snapshotById = new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot]))
    const allWorkspaces = ctx.workspaceRegistry.list()
    // An update keeps the bundle's own workspace set: re-selecting everything
    // would silently pull unrelated projects into a bundle meant for a subset.
    // An explicit "plugins only" export keeps the bundle free of sessions even
    // though the client sent an empty workspace list. An array is always an
    // explicit choice — only a missing list means "the caller did not choose".
    const hasExplicitSelection = Array.isArray(options.workspaceIds)
    const selected = options.onlyPlugins
      ? []
      : hasExplicitSelection
        ? allWorkspaces.filter((workspace) => options.workspaceIds.includes(String(workspace.id)))
        : updating && bundleWorkspaceIds
          ? allWorkspaces.filter((workspace) => bundleWorkspaceIds.includes(String(workspace.id)))
          : allWorkspaces

    const sessionIds = new Set()
    for (const workspace of selected) for (const id of workspace.sessionIds) sessionIds.add(String(id))

    let grew = true
    while (grew) {
      grew = false
      for (const snapshot of snapshots) {
        const parent = snapshot.header.parentSession
        const id = String(snapshot.header.id)
        if (parent && sessionIds.has(String(parent)) && !sessionIds.has(id)) {
          sessionIds.add(id)
          grew = true
        }
        // A DSH fork embeds its inherited prefix in its own log, so children do
        // not need their parent shipped alongside them.
      }
    }

    const ordered = [...sessionIds]
      .filter((id) => snapshotById.has(id))
      .sort((a, b) => {
        const left = snapshotById.get(a).header
        const right = snapshotById.get(b).header
        const leftChild = left.parentSession ? 1 : 0
        const rightChild = right.parentSession ? 1 : 0
        return leftChild - rightChild || (left.createdAt ?? 0) - (right.createdAt ?? 0)
      })

    task.total = ordered.length + (options.includeFiles ? selected.length : 0) + 2
    const manifestSessions = []
    const includedIds = new Set()
    const sessionState = {}
    const attachmentRefs = new Map()
    let bytes = 0
    let sessionsReused = 0
    let subagentSkipped = 0

    const zstd = await loadZstd()
    for (const id of ordered) {
      const snapshot = snapshotById.get(id)
      // Subagent transcripts are internal: DSH hides them on the source machine,
      // and importing them only produces a wall of untitled child sessions.
      if (snapshot?.header?.origin === 'subagent') {
        subagentSkipped += 1
        task.done += 1
        continue
      }
      const previous = previousState?.sessions?.[id]
      // Reuse only when the source log itself is unchanged: compare the
      // backend's own size/event count, never the packaged artifact size.
      const sourceBytes = typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : null
      const sourceEvents = typeof snapshot?.eventCount === 'number' ? snapshot.eventCount : null
      if (
        previous &&
        previous.meta &&
        previous.meta.file &&
        sourceBytes !== null &&
        previous.sourceBytes === sourceBytes &&
        previous.sourceEvents === sourceEvents &&
        (await pathExists(join(dir, 'sessions', previous.meta.file)))
      ) {
        includedIds.add(id)
        manifestSessions.push(previous.meta)
        sessionState[id] = previous
        sessionsReused += 1
        task.done += 1
        task.message = `复用未变化的会话 ${sessionsReused} 个`
        continue
      }
      const handle = await ctx.sessionPersistence.open(id, 'read')
      try {
        const { events } = await handle.read()
        // Remember which attachment objects this session actually uses, so the
        // bundle carries those files and not the whole attachments store.
        for (const event of events ?? []) {
          if (event && event.data) collectAttachments(event.data, attachmentRefs)
        }
        const document = {
          header: handle.header,
          inheritedEventCount: handle.inheritedEventCount,
          events,
        }
        const text = JSON.stringify(document)
        const packed = zstd ? zstd.zstdCompressSync(Buffer.from(text, 'utf8')) : null
        const file = packed ? `${safeName(id)}.json.zst` : `${safeName(id)}.json`
        await fsp.writeFile(join(dir, 'sessions', file), packed ?? text)
        bytes += packed ? packed.length : Buffer.byteLength(text)
        includedIds.add(id)
        const meta = {
          id,
          file,
          compressed: Boolean(packed),
          createdAt: handle.header.createdAt ?? null,
          cwd: handle.header.cwd ?? null,
          parent: handle.header.parentSession ? String(handle.header.parentSession) : null,
          seeded: Boolean(handle.header.isSeeded),
          origin: handle.header.origin ?? null,
          inherited: handle.inheritedEventCount ?? 0,
          events: Array.isArray(events) ? events.length : 0,
        }
        manifestSessions.push(meta)
        sessionState[id] = {
          meta,
          sourceBytes,
          sourceEvents,
          bytes: packed ? packed.length : Buffer.byteLength(text),
          events: Array.isArray(events) ? events.length : 0,
        }
      } finally {
        await handle.close()
      }
      task.done += 1
      task.message = `已导出会话 ${task.done}/${ordered.length}`
    }

    const previousFolders = new Map()
    if (updating) {
      try {
        const previousDoc = JSON.parse(await fsp.readFile(join(dir, 'workspaces.json'), 'utf8'))
        for (const item of previousDoc.workspaces ?? []) {
          if (item && item.id && item.folder) previousFolders.set(String(item.id), String(item.folder))
        }
      } catch {
        /* a missing or older document just means fresh folder names */
      }
    }
    // One readable folder per project inside the bundle: "<title>-<YYYYMMDD>".
    const usedFolders = new Set()
    const folders = new Map()
    const bundleDay = localDay()
    for (const workspace of selected) {
      const id = String(workspace.id)
      const kept = previousFolders.get(id)
      if (kept) {
        usedFolders.add(kept)
        folders.set(id, kept)
        continue
      }
      const base = `${safeSegment(workspace.title || basename(workspace.path), id)}-${bundleDay}`
      let name = base
      let attempt = 2
      while (usedFolders.has(name)) {
        name = `${base}-${attempt}`
        attempt += 1
      }
      usedFolders.add(name)
      folders.set(id, name)
    }

    const sets = await readRegistrySets(home)
    const workspaceDoc = {
      version: 2,
      order: selected.map((workspace) => String(workspace.id)),
      workspaces: selected.map((workspace) => ({
        id: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
        folder: folders.get(String(workspace.id)) ?? null,
        createdAt: workspace.createdAt ?? null,
        sessionIds: [...workspace.sessionIds].map(String).filter((id) => includedIds.has(id)),
      })),
      archived: sets.archived.filter((id) => includedIds.has(id)),
      pinned: sets.pinned.filter((id) => includedIds.has(id)),
    }
    await fsp.writeFile(join(dir, 'workspaces.json'), JSON.stringify(workspaceDoc, null, 2))

    const fileWarnings = []
    const outKey = normalKey(dir)
    const filesState = {}
    const targetStyleIsWindows = styleOfPlatform(targetPlatform) === 'win'
    let illegalNames = 0
    const illegalSamples = []
    let filesCopied = 0
    let filesUnchanged = 0
    let filesRemoved = 0
    let bytesCopied = 0
    for (const workspace of selected) {
      if (!options.includeFiles) break
      const source = workspace.path
      if (!(await pathExists(source))) {
        fileWarnings.push(`跳过不存在的项目目录：${workspace.title}（${source}）`)
        task.done += 1
        continue
      }
      const sourceKey = normalKey(source)
      if (outKey === sourceKey || outKey.startsWith(sourceKey + '\\') || outKey.startsWith(sourceKey + '/')) {
        fileWarnings.push(`导出目录位于项目「${workspace.title}」内部，已跳过它的文件复制，避免把导出包复制进自己`)
        task.done += 1
        continue
      }
      const dest = join(dir, 'files', folders.get(String(workspace.id)) ?? safeName(workspace.id))
      const current = await walkFiles(source, excludes)
      if (targetStyleIsWindows) {
        for (const relative of current.keys()) {
          if (!illegalOnWindows(basename(relative))) continue
          illegalNames += 1
          if (illegalSamples.length < 5) illegalSamples.push(relative)
        }
      }
      if (updating) {
        const previousFiles = previousState.files?.[workspace.id] ?? {}
        for (const [relative, info] of current) {
          const before = previousFiles[relative]
          if (before && before[0] === info[0] && before[1] === info[1] && (await pathExists(join(dest, relative)))) {
            filesUnchanged += 1
            continue
          }
          const target = join(dest, relative)
          await fsp.mkdir(dirname(target), { recursive: true })
          await fsp.copyFile(join(source, relative), target)
          filesCopied += 1
          bytesCopied += info[0]
        }
        for (const relative of Object.keys(previousFiles)) {
          if (current.has(relative)) continue
          await fsp.rm(join(dest, relative), { force: true })
          filesRemoved += 1
        }
      } else {
        await fsp.cp(source, dest, {
          recursive: true,
          force: true,
          filter: (entry) => {
            if (normalKey(entry) === normalKey(source)) return true
            return !excludes.has(basename(entry).toLowerCase())
          },
        })
        filesCopied += current.size
        for (const info of current.values()) bytesCopied += info[0]
      }
      filesState[workspace.id] = Object.fromEntries(current)
      task.done += 1
      task.message = updating
        ? `增量更新：${workspace.title}（变更 ${filesCopied}，未变 ${filesUnchanged}）`
        : `已复制项目文件：${workspace.title}`
    }
    if (updating) {
      for (const oldId of Object.keys(previousState.files ?? {})) {
        if (filesState[oldId]) continue
        await fsp.rm(join(dir, 'files', previousFolders.get(String(oldId)) ?? safeName(oldId)), {
          recursive: true,
          force: true,
        })
      }
    }

    let attachmentsBytes = 0
    let attachmentsCopied = 0
    const attachmentsRoot = join(home, 'attachments')
    if (options.includeAttachments && (await pathExists(attachmentsRoot))) {
      const service = ctx.get('attachments')
      const wanted = []
      for (const ref of attachmentRefs.values()) {
        let hostPath = null
        try {
          if (service && typeof ref.mediaType === 'string' && typeof service.imageHostPath === 'function') {
            hostPath = service.imageHostPath(ref)
          } else if (service && typeof service.fileHostPath === 'function') {
            hostPath = service.fileHostPath(ref)
          }
        } catch {
          hostPath = null
        }
        if (typeof hostPath !== 'string' || hostPath.length === 0) continue
        const rel = relative(attachmentsRoot, hostPath)
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
        wanted.push(rel)
      }
      if (wanted.length > 0) {
        // Copy only the objects these sessions reference: the store is shared by
        // every session on the machine, so a full copy would drag in everything.
        for (const rel of wanted) {
          const source = join(attachmentsRoot, rel)
          const target = join(dir, 'attachments', rel)
          try {
            await fsp.mkdir(dirname(target), { recursive: true })
            await fsp.copyFile(source, target)
            attachmentsCopied += 1
          } catch {
            /* a ref the host cannot resolve is reported by the pre-import check */
          }
        }
      } else if (!service && attachmentRefs.size === 0) {
        // No attachment service to resolve paths: keep the old whole-store copy
        // rather than silently shipping a bundle without images.
        await fsp.cp(attachmentsRoot, join(dir, 'attachments'), { recursive: true, force: true })
      }
      attachmentsBytes = await dirSize(join(dir, 'attachments'))
    }

    const filesBytes = await dirSize(join(dir, 'files'))
    // Ship this plugin itself so the target machine can install it without a
    // separate copy; the bundle is useless there without the same plugin.
    // Ship only the published files. Copying the whole plugin directory used to
    // drag in dist/, docs/ and promo material — kilobytes per bundle and assets
    // that never belong on another machine.
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      const shipped = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'package.json', 'README.md', 'LICENSE']
      const target = join(dir, 'plugin', 'dsh-migrate')
      for (const name of shipped) {
        const source = join(here, name)
        if (!(await pathExists(source))) continue
        await fsp.mkdir(target, { recursive: true })
        await fsp.copyFile(source, join(target, name))
      }
    } catch {
      /* the plugin copy is a convenience, never a reason to fail an export */
    }
    const totalBytes = bytes + filesBytes + attachmentsBytes
    const manifest = {
      schema: BUNDLE_SCHEMA,
      kind: BUNDLE_KIND,
      plugin: 'plugin/dsh-migrate',
      mode: updating ? 'update' : 'full',
      createdAt: new Date().toISOString(),
      source: {
        home,
        host: hostname(),
        platform: platform(),
        appVersion: process.env.DSH_CLIENT_VERSION ?? null,
      },
      target: {
        platform: targetPlatform,
        style: styleOfPlatform(targetPlatform),
        illegalNames,
      },
      formatVersion: pickFormatVersion(snapshots),
      options: {
        includeFiles: Boolean(options.includeFiles),
        includeAttachments: Boolean(options.includeAttachments),
      },
      excludes: [...excludes],
      bytes: totalBytes,
      sessions: manifestSessions,
      workspaces: workspaceDoc.workspaces,
      archived: workspaceDoc.archived.length,
      pinned: workspaceDoc.pinned.length,
    }
    await fsp.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    // The plugin list travels as its own file: it is informational only, and an
    // unreadable profile must never block the export. Users can leave it out or
    // narrow it down, because the list itself says which tools they run.
    let pluginsWritten = 0
    try {
      // `undefined` must not mean "include": incremental update requests carry no
      // checkbox state, so an update has to keep whatever the original export
      // decided instead of silently adding the plugin list to the bundle.
      const pluginsFlag = options.includePlugins === true ? true : options.includePlugins === false ? false : null
      const pluginsFile = join(dir, 'plugins.json')
      const hadPluginsFile = await pathExists(pluginsFile)
      const shouldWritePlugins = pluginsFlag === null ? (updating ? hadPluginsFile : true) : pluginsFlag
      if (!shouldWritePlugins && hadPluginsFile) {
        await fsp.rm(pluginsFile, { force: true })
      }
      if (shouldWritePlugins) {
        const profilePlugins = await readProfilePlugins(home)
        if (profilePlugins) {
          const keep = Array.isArray(options.pluginNames) ? new Set(options.pluginNames.map(String)) : null
          // Local links point at this machine's paths: they cannot travel, and
          // the export page shows them greyed out to say exactly that.
          const plugins = profilePlugins.plugins.filter(
            (plugin) => plugin.type !== 'link' && (!keep || keep.has(plugin.name)),
          )
          await fsp.writeFile(
            join(dir, 'plugins.json'),
            JSON.stringify(
              { version: 1, exportedAt: new Date().toISOString(), profile: profilePlugins.profile, profiles: profilePlugins.profiles, plugins },
              null,
              2,
            ),
          )
          pluginsWritten = plugins.length
        }
      }
    } catch {
      /* plugin inventory is a convenience */
    }
    await fsp.writeFile(
      join(dir, 'state.json'),
      JSON.stringify({ version: 1, createdAt: new Date().toISOString(), sessions: sessionState, files: filesState }),
    )
    task.done += 1

    // Single-file output: wrap the finished folder into a .dshmig archive and drop
    // the folder, so the handover is one file instead of hundreds.
    let finalPath = dir
    let archiveInfo = null
    // A folder bundle that is being updated in place stays a folder; only an
    // explicit archive target (or a .dshmig source) produces a single file.
    if (options.archiveTarget || looksLikeBundleFile(options.bundlePath ?? '') || (options.packageFormat === 'file' && !updating)) {
      const archive = options.archiveTarget
        ? resolve(String(options.archiveTarget))
        : looksLikeBundleFile(options.bundlePath ?? '')
          ? resolve(String(options.bundlePath))
          : join(dirname(dir), `${basename(dir)}${BUNDLE_FILE_EXT}`)
      finalPath = archive
      archiveInfo = await writeBundleArchive(dir, archive)
      if (!updating) await fsp.rm(dir, { recursive: true, force: true })
    }

    await rememberBundle(finalPath)
    return {
      path: finalPath,
      file: Boolean(archiveInfo),
      archiveEntries: archiveInfo ? archiveInfo.entries : null,
      mode: updating ? 'update' : 'full',
      sessions: manifestSessions.length,
      sessionsReused,
      subagents: subagentSkipped,
      targetPlatform,
      illegalNames,
      illegalSamples,
      workspaces: workspaceDoc.workspaces.length,
      plugins: pluginsWritten,
      bytes: totalBytes,
      sessionBytes: bytes,
      attachments: attachmentsCopied,
      filesBytes,
      attachmentsBytes,
      filesCopied,
      filesUnchanged,
      filesRemoved,
      bytesCopied,
      warnings: fileWarnings,
    }
  }

  function pickFormatVersion(snapshots) {
    for (const snapshot of snapshots) {
      const version = snapshot.header?.version
      if (typeof version === 'number') return version
    }
    return null
  }

  // ── import ───────────────────────────────────────────────────────────────

  /**
 * A DSH fork records its inherited boundary as `session/end-seed` with
 * `data.inherited === true`. The Host accepts that marker only inside a seeded
 * Session: an unseeded log that still carries it is rejected on read
 * ("unseeded Session contains an inherited end-seed marker"). Flattened forks
 * keep the event and its seq, and only drop the marker field.
 */
function stripInheritedSeedMarkers(events) {
  let stripped = 0
  const next = events.map((event) => {
    if (!event || event.type !== 'session/end-seed') return event
    const data = event.data && typeof event.data === 'object' ? event.data : null
    if (!data || data.inherited !== true) return event
    stripped += 1
    const { inherited, ...rest } = data
    return { ...event, data: rest }
  })
  return { events: next, stripped }
}
async function loadSessionDocument(view, meta) {
    const candidates = []
    if (meta.file) candidates.push(meta.file)
    candidates.push(`${safeName(meta.id)}.json.zst`, `${safeName(meta.id)}.json`)
    for (const name of candidates) {
      const buffer = await view.read(`sessions/${name}`)
      if (!buffer) continue
      if (name.endsWith('.zst')) {
        const zstd = await loadZstd()
        if (!zstd) throw new Error('本机运行时不支持 zstd，无法解压会话文件')
        return JSON.parse(zstd.zstdDecompressSync(buffer).toString('utf8'))
      }
      return JSON.parse(buffer.toString('utf8'))
    }
    throw new Error(`迁移包缺少会话文件：${meta.id}`)
  }

  async function removeSessionDirs(root, id) {
    let removed = 0
    let projects
    try {
      projects = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return removed
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const target = join(root, project.name, id)
      if (await pathExists(target)) {
        await fsp.rm(target, { recursive: true, force: true })
        removed += 1
        try {
          const rest = await fsp.readdir(join(root, project.name))
          if (rest.length === 0) await fsp.rmdir(join(root, project.name))
        } catch {
          /* keep a non-empty project directory */
        }
      }
    }
    return removed
  }

  /**
   * Move Session logs into a dated trash folder instead of deleting them. Same
   * volume, so the rename is atomic, holds no lock, and stays reversible: the
   * Host offers no deletion API and its documented stance is "archive, never
   * delete".
   */
  async function trashSessionDirs(home, ids) {
    const root = join(home, 'sessions')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const trashDir = join(home, 'trash', `undo-import-${stamp}`)
    const entries = []
    let projects = []
    try {
      projects = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      projects = []
    }
    let created = false
    for (const id of ids) {
      for (const project of projects) {
        if (!project.isDirectory()) continue
        const source = join(root, project.name, id)
        if (!(await pathExists(source))) continue
        if (!created) {
          await fsp.mkdir(trashDir, { recursive: true })
          created = true
        }
        const target = join(trashDir, `${id}__${project.name}`)
        try {
          await fsp.rename(source, target)
          entries.push({ id, from: source, to: target, restored: false })
        } catch (error) {
          entries.push({ id, from: source, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    if (created) {
      try {
        await fsp.writeFile(
          join(trashDir, 'MANIFEST.json'),
          JSON.stringify({ kind: 'undo-import', createdAt: new Date().toISOString(), entries }, null, 2),
        )
      } catch {
        /* the manifest is a convenience */
      }
    }
    return { trashDir: created ? trashDir : null, entries }
  }
  async function rollback(payload) {
    const remembered = payload && payload.useLast === true ? await readLastImport() : null
    if (payload && payload.useLast === true && !remembered) {
      return { workspaces: [], sessions: [], error: '没有可撤销的导入记录' }
    }
    const workspaceIds = remembered
      ? (remembered.workspaces || []).map(String)
      : Array.isArray(payload.workspaceIds)
        ? payload.workspaceIds.map(String)
        : []
    const sessionIds = remembered
      ? (remembered.sessions || []).map(String)
      : Array.isArray(payload.sessionIds)
        ? payload.sessionIds.map(String)
        : []
    // Ids from the persisted record were written by this plugin's own import, so
    // they stay eligible after a reload; ad-hoc ids still need the memory guard.
    const trustedWorkspaces = new Set(remembered ? workspaceIds : [])
    const trustedSessions = new Set(remembered ? sessionIds : [])
    const result = { workspaces: [], sessions: [] }
    for (const id of workspaceIds) {
      if (!createdWorkspaces.has(id) && !trustedWorkspaces.has(id)) {
        result.workspaces.push({ id, refused: '不是本次运行创建的项目，已拒绝删除' })
        continue
      }
      try {
        result.workspaces.push({ id, removed: await ctx.workspaceRegistry.delete(id) })
      } catch (error) {
        result.workspaces.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    // Sessions are moved to a dated trash folder, never deleted: the Host has no
    // deletion API and documents "archive, never delete" as the stance.
    const movable = []
    for (const id of sessionIds) {
      if (!createdSessions.has(id) && !trustedSessions.has(id)) {
        result.sessions.push({ id, refused: '不是本次运行导入的会话，已拒绝处理' })
        continue
      }
      movable.push(id)
    }
    const trashed = await trashSessionDirs(dshHome(), movable)
    result.trashDir = trashed.trashDir
    for (const entry of trashed.entries) {
      result.sessions.push(entry.error
        ? { id: entry.id, error: entry.error }
        : { id: entry.id, removed: true, movedTo: entry.to })
    }
    if (remembered) await clearLastImport()
    return result
  }

  async function cleanupWorkspaces(payload) {
    const only = Array.isArray(payload.workspaceIds) ? payload.workspaceIds.map(String) : null
    const removed = []
    for (const workspace of ctx.workspaceRegistry.list()) {
      const id = String(workspace.id)
      if (only && !only.includes(id)) continue
      // Only registrations that point at nothing and hold nothing are safe to drop.
      if (workspace.sessionIds.length > 0) continue
      if (await pathExists(workspace.path)) continue
      try {
        removed.push({ id, path: workspace.path, removed: await ctx.workspaceRegistry.delete(id) })
      } catch (error) {
        removed.push({ id, path: workspace.path, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { removed }
  }

  // ── attachment audit ─────────────────────────────────────────────────────

  /** Collect every attachment reference reachable from one event payload. */
  function collectAttachments(value, out, depth = 0) {
    if (depth > 12 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) collectAttachments(item, out, depth + 1)
      return
    }
    if (typeof value.attachmentId === 'string' && !out.has(value.attachmentId)) out.set(value.attachmentId, value)
    for (const key of Object.keys(value)) collectAttachments(value[key], out, depth + 1)
  }

  /** Whether this machine can still resolve one attachment reference. */
  function attachmentExists(ref) {
    const attachments = ctx.get('attachments')
    if (!attachments) return true
    try {
      if (typeof ref.mediaType === 'string' && typeof attachments.imageHostPath === 'function') {
        return typeof attachments.imageHostPath(ref) === 'string'
      }
      if (typeof attachments.fileHostPath === 'function') {
        return typeof attachments.fileHostPath(ref) === 'string'
      }
    } catch {
      return false
    }
    return true
  }

  function auditDocument(document) {
    const refs = new Map()
    for (const event of document.events ?? []) {
      if (event && event.data) collectAttachments(event.data, refs)
    }
    const missingIds = []
    for (const [id, ref] of refs) if (!attachmentExists(ref)) missingIds.push(id)
    return { refs: refs.size, missing: missingIds.length, missingIds: missingIds.slice(0, 20) }
  }

  /**
   * Readable name for a session. DSH appends a new `session/title` event on every
   * rename or generated title, so the sidebar shows the LAST one; reading the
   * first would report the original auto-generated name instead.
   */
  function sessionTitle(document) {
    const events = document.events ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      const title = event && event.type === 'session/title' && event.data ? event.data.title : null
      if (typeof title === 'string' && title.trim().length > 0) return title.trim()
    }
    for (const event of events) {
      if (!event || event.type !== 'user/message' || !event.data) continue
      const text = typeof event.data.text === 'string' ? event.data.text : ''
      if (text.trim().length > 0) return text.trim().slice(0, 40)
    }
    return null
  }
  /** Readable name for a session: DSH records one as a `session/title` event. */
  function sessionTitle(document) {
    const events = document.events ?? []
    for (const event of events) {
      const title = event && event.type === 'session/title' && event.data ? event.data.title : null
      if (typeof title === 'string' && title.trim().length > 0) return title.trim()
    }
    for (const event of events) {
      if (!event || event.type !== 'user/message' || !event.data) continue
      const text = typeof event.data.text === 'string' ? event.data.text : ''
      if (text.trim().length > 0) return text.trim().slice(0, 40)
    }
    return null
  }

  /** Seq-valued fields that must follow a renumbered event forward. */
  const SEQ_REF_KEYS = new Set(['throughSeq', 'headerSeq', 'messageSeqs', 'shadowedSeqs', 'sourceEventSeqs', 'startSeq', 'endSeq'])

  /** Shift seq references at or after `threshold` by one, so a fork marker fits. */
  function shiftSeqRefs(value, threshold, delta = 1, key = null) {
    if (Array.isArray(value)) return value.map((item) => shiftSeqRefs(item, threshold, delta, key))
    if (value && typeof value === 'object') {
      const out = {}
      for (const [childKey, child] of Object.entries(value)) out[childKey] = shiftSeqRefs(child, threshold, delta, childKey)
      return out
    }
    if (typeof value === 'number' && key !== null && SEQ_REF_KEYS.has(key) && value >= threshold) return value + delta
    return value
  }
  /**
   * Make a merged event list legal for the host: the store requires
   * `events[i].seq === i`, so dropping internal markers means renumbering every
   * remaining event and moving the seq references inside them along.
   */
  function compactEventSeq(events) {
    return renumberEvents(events, (event) => event.type === 'session/end-seed')
  }

  /**
   * Drop the events `shouldDrop` accepts, then renumber what is left and move
   * every seq reference along with it. Used when a log written by another DSH
   * build cannot be read here as-is (e.g. compaction bookkeeping the local
   * reader refuses), where keeping the conversation matters more than keeping
   * the optimization records.
   */
  function renumberEvents(events, shouldDrop) {
    const kept = []
    const mapping = new Map()
    for (const event of events) {
      if (!event) continue
      if (shouldDrop && shouldDrop(event)) continue
      const oldSeq = Number(event.seq)
      if (Number.isFinite(oldSeq)) mapping.set(oldSeq, kept.length)
      kept.push({ ...event, seq: kept.length })
    }
    const oldSeqs = [...mapping.keys()].sort((a, b) => a - b)
    const remap = (value, key = null) => {
      if (Array.isArray(value)) return value.map((item) => remap(item, key))
      if (value && typeof value === 'object') {
        const out = {}
        for (const [childKey, child] of Object.entries(value)) out[childKey] = remap(child, childKey)
        return out
      }
      if (typeof value !== 'number' || key === null || !SEQ_REF_KEYS.has(key)) return value
      if (mapping.has(value)) return mapping.get(value)
      // A `throughSeq` may point at a dropped marker: use the nearest kept seq.
      let low = 0
      let high = oldSeqs.length - 1
      let best = null
      while (low <= high) {
        const mid = (low + high) >> 1
        if (oldSeqs[mid] <= value) {
          best = oldSeqs[mid]
          low = mid + 1
        } else high = mid - 1
      }
      return best === null ? 0 : mapping.get(best)
    }
    for (const event of kept) {
      if (event.data && typeof event.data === 'object') event.data = remap(event.data)
      // `sourceEventSeqs` sits on the event itself, not inside `data`; the host
      // requires it to hold unique seqs earlier than the event.
      if (Array.isArray(event.sourceEventSeqs)) {
        const moved = event.sourceEventSeqs
          .map((value) => remap(value, 'sourceEventSeqs'))
          .filter((value) => Number.isFinite(value) && value < event.seq)
        event.sourceEventSeqs = [...new Set(moved)]
      }
    }
    return kept
  }
  /**
   * A flattened fork still quotes the parent's id inside its inherited events
   * (delivery markers, spliced inbox entries). The host rejects a current-
   * generation marker that names another Session, so every foreign id is
   * rewritten to the Session being imported.
   */
  function rewriteForeignSessionIds(events, ownId) {
    const ids = new Set()
    for (const event of events) {
      const text = JSON.stringify(event)
      for (const match of text.matchAll(/session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
        if (match[0].toLowerCase() !== String(ownId).toLowerCase()) ids.add(match[0])
      }
    }
    if (ids.size === 0) return events
    let serialized = JSON.stringify(events)
    for (const foreign of ids) serialized = serialized.split(foreign).join(ownId)
    return JSON.parse(serialized)
  }



  /**
   * Paths are rewritten at import time, so the same conversation reads differently
   * on the two machines (`D:\proj\x` here, `F:\proj\x` there). Comparing raw JSON
   * would call such logs "diverged" and fork a Session that only grew; replacing
   * path-shaped substrings with one token makes the comparison content-based.
   */
  const PATH_LIKE = /(?:[A-Za-z]:[\\/][^\s"'`<>|]*|\/(?:[^\s"'`<>|/]+\/)*[^\s"'`<>|]*)/g

  function normalizeForCompare(value, depth = 0) {
    if (depth > 12) return value
    if (typeof value === 'string') {
      // Event types look like paths (`turn/start`, `agent/inbox/spliced`); they
      // must never be rewritten to the path token or two logs stop matching.
      if (/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/.test(value)) return value
      return value.replace(PATH_LIKE, '<path>')
    }
    if (Array.isArray(value)) return value.map((item) => normalizeForCompare(item, depth + 1))
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, child] of Object.entries(value)) out[key] = normalizeForCompare(child, depth + 1)
      return out
    }
    return value
  }
  /** Log bookkeeping that each machine writes for itself, never shared content. */
  function isBookkeepingEvent(event) {
    if (!event || typeof event.type !== 'string') return false
    return event.type.startsWith('session-log-') || event.type === 'session/end-seed'
  }

  /**
   * Where each bundled project goes on this machine: an explicit per-project
   * mapping wins, then `<rootDir>/<title>`, then the original path. Shared by the
   * import and the pre-import check so both agree on the mapping.
   */
  function planTargets(workspaceDoc, rootDir, remapInput) {
    const targets = []
    const usedTargets = new Set()
    for (const workspace of workspaceDoc.workspaces ?? []) {
      const explicit = Object.prototype.hasOwnProperty.call(remapInput, workspace.path)
        ? String(remapInput[workspace.path] ?? '').trim()
        : ''
      let target
      if (explicit) {
        target = resolve(normalizeTargetPath(explicit))
      } else if (rootDir) {
        const base = safeSegment(workspace.title || basename(workspace.path), workspace.id)
        let candidate = join(rootDir, base)
        let suffix = 2
        while (usedTargets.has(normalKey(candidate))) {
          candidate = join(rootDir, `${base}-${suffix}`)
          suffix += 1
        }
        target = candidate
      } else {
        target = workspace.path
      }
      usedTargets.add(normalKey(target))
      targets.push({ source: workspace, target })
    }
    return targets
  }

  /** Root-mapping pairs, exactly the ones the import will apply. */
  function planPairs(targets, remapInput, localStyle) {
    const pairs = []
    for (const entry of targets) {
      if (entry.source.path === entry.target) continue
      pairs.push({ from: entry.source.path, to: entry.target, toStyle: localStyle })
    }
    for (const [from, to] of Object.entries(remapInput)) {
      if (!from || !to || String(from).trim() === String(to).trim()) continue
      if (targets.some((entry) => normalKey(entry.source.path) === normalKey(from))) continue
      pairs.push({ from: String(from), to: String(to), toStyle: localStyle })
    }
    pairs.sort((a, b) => normalKey(b.from).length - normalKey(a.from).length)
    return pairs
  }

  /**
   * Claim write ownership of a Session. DSH allows one writer at a time, so a
   * Session that is open in the UI (or running a turn) rejects the claim; retry
   * briefly, then give up with a message the user can act on.
   */
  async function openForWrite(id, attempts = 4, delayMs = 400) {
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await ctx.sessionPersistence.open(id, 'write')
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        const owned = /already owned|SessionAlreadyOwned/i.test(message) || error?.name === 'SessionAlreadyOwnedError'
        if (!owned || attempt === attempts) break
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    const owned = /already owned|SessionAlreadyOwned/i.test(message) || lastError?.name === 'SessionAlreadyOwnedError'
    throw new Error(
      owned
        ? '该会话正在 DSH 里打开着或正在运行，同一时间只允许一个写入者；请关闭该会话后重新导入'
        : message,
    )
  }

  /** Apply the import's path mapping to a copy of the bundle's events. */
  function mapEventPaths(events, pairs) {
    if (!pairs || pairs.length === 0) return events
    const stats = { count: 0 }
    const clone = JSON.parse(JSON.stringify(Array.isArray(events) ? events : []))
    for (const event of clone) {
      if (event && event.data && typeof event.data === 'object') event.data = rewritePaths(event.data, pairs, stats)
    }
    return clone
  }

  /** Key-order-insensitive JSON so a re-serialized event still compares equal. */
  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
      return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    }
    return JSON.stringify(value) ?? 'null'
  }

  function canonicalEvent(event) {
    // Compare content, not bookkeeping identity: a flattened fork is renumbered,
    // so its `seq` differs from the bundle's while the conversation is identical.
    if (!event || typeof event !== 'object') return stableStringify(event)
    return stableStringify(
      normalizeForCompare({ type: event.type ?? null, time: event.time ?? null, data: event.data ?? null }),
    )
  }

  /** First index where two content streams disagree, for diagnostics. */
  function firstDifference(localEvents, packEvents) {
    const a = localEvents.filter((event) => !isBookkeepingEvent(event))
    const b = packEvents.filter((event) => !isBookkeepingEvent(event))
    const min = Math.min(a.length, b.length)
    for (let index = 0; index < min; index += 1) {
      if (canonicalEvent(a[index]) !== canonicalEvent(b[index])) {
        return {
          index,
          localType: a[index]?.type ?? null,
          packType: b[index]?.type ?? null,
          local: canonicalEvent(a[index]).slice(0, 160),
          pack: canonicalEvent(b[index]).slice(0, 160),
        }
      }
    }
    return null
  }


  /**
   * Compare a local log with the bundled one by walking their common prefix.
   * identical  same content
   * packAhead  local is a strict prefix, so the bundle only adds
   * localAhead the bundle is a strict prefix, so this machine is newer
   * diverged   both changed, so neither side is safe to drop automatically
   */
  /**
   * Index of the first event where the local log and the bundle disagree, counting
   * bookkeeping events too. The append point hinges on this: filtering bookkeeping
   * can hide a missing enqueue splice and start the append one event too late.
   */
  function firstStrictDifference(localEvents, packEvents) {
    const min = Math.min(localEvents.length, packEvents.length)
    for (let index = 0; index < min; index += 1) {
      if (canonicalEvent(localEvents[index]) !== canonicalEvent(packEvents[index])) return index
    }
    return min
  }

  /**
   * Decide whether the bundle simply extends the local log, and where to start
   * appending. A local log written by an older build can hold a stray seed marker
   * where the bundle has an inbox splice, so a strict first-difference is the
   * anchor: when everything the local log has past that point is bookkeeping, the
   * bundle's events are renumbered onto the end instead of forking.
   */
  function appendPlan(localEvents, packEvents) {
    const local = Array.isArray(localEvents) ? localEvents : []
    const pack = Array.isArray(packEvents) ? packEvents : []
    const diverge = firstStrictDifference(local, pack)
    if (pack.length <= diverge) return null
    if (diverge >= local.length) return { start: local.length, delta: 0 }
    const extra = local.slice(diverge)
    if (extra.every((event) => isBookkeepingEvent(event))) {
      return { start: diverge, delta: local.length - diverge }
    }
    return null
  }

  function compareEvents(local, pack, pairs = null) {
    // Delivery markers and seed boundaries are per-machine bookkeeping, so
    // they are dropped before comparing: otherwise a Session that merely got
    // opened on this machine looks "diverged" from the bundle.
    const a = (Array.isArray(local) ? local : []).filter((event) => !isBookkeepingEvent(event))
    // The bundle still carries the old machine's paths. Applying the same mapping
    // the import would apply makes a moved project compare by content instead of
    // by drive letter, and it handles paths containing spaces (which the path
    // token normalization below cannot match).
    const mapped = mapEventPaths(pack, pairs)
    const b = (Array.isArray(mapped) ? mapped : []).filter((event) => !isBookkeepingEvent(event))
    const min = Math.min(a.length, b.length)
    let index = 0
    while (index < min) {
      if (canonicalEvent(a[index]) !== canonicalEvent(b[index])) return 'diverged'
      index += 1
    }
    if (a.length === b.length) return 'identical'
    return index === a.length ? 'packAhead' : 'localAhead'
  }

  /** Load one locally stored session so it can be compared with the bundle. */
  async function readLocalSession(id) {
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      return { events }
    } finally {
      await handle.close()
    }
  }

  /** Count the plugins recorded in a bundle; 0 when there is no list. */
  /** Count the plugins recorded in a bundle; 0 when there is no list. */
  async function countBundlePlugins(view) {
    try {
      const raw = await view.read('plugins.json')
      if (!raw) return 0
      const doc = JSON.parse(raw.toString('utf8'))
      return Array.isArray(doc.plugins) ? doc.plugins.length : 0
    } catch {
      return 0
    }
  }

  /**
   * The Workspace that hosts plugin-install conversations. Plugins are machine
   * setup, not project work, so they get their own place instead of landing in
   * whichever project the user happened to be looking at.
   */
  async function setupWorkspace() {
    const home = dshHome()
    const dir = join(home, 'plugin-setup')
    const title = '插件安装'
    const existing = ctx.workspaceRegistry.list().find((workspace) => normalKey(workspace.path) === normalKey(dir))
    if (existing) return { id: String(existing.id), path: existing.path, title: existing.title, created: false }
    await fsp.mkdir(dir, { recursive: true })
    const entity = await ctx.workspaceRegistry.create(dir, title)
    try {
      await entity.setTitle(title)
    } catch {
      /* the created title is good enough */
    }
    return { id: String(entity.id), path: dir, title, created: true }
  }


  async function auditBundle(bundlePath, options = {}) {
    if (!bundlePath) throw new Error('缺少迁移包路径')
    const view = await openBundleView(bundlePath)
    try {
      return await auditBundleView(bundlePath, view, options)
    } finally {
      await view.close()
    }
  }

  /** `YYYY-MM-DD HH:mm` for a timestamp that may be seconds or milliseconds. */
  function formatStamp(value) {
    if (value === null || value === undefined) return ''
    const raw = typeof value === 'number' ? value : Date.parse(String(value))
    if (!Number.isFinite(raw) || raw <= 0) return ''
    const date = new Date(raw < 1e12 ? raw * 1000 : raw)
    const pad = (number) => String(number).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  async function auditBundleView(bundlePath, view, options = {}) {
    const dir = resolve(String(bundlePath))
    const manifest = await readManifestView(view)
    // The check runs before the import, so it has to plan the same targets the
    // import will use; otherwise a moved project looks "diverged" only because
    // its paths differ.
    let checkPairs = []
    try {
      const rootDir = options.rootDir ? resolve(normalizeTargetPath(String(options.rootDir))) : null
      const remapInput = options.remap && typeof options.remap === 'object' ? options.remap : {}
      if (rootDir || Object.keys(remapInput).length > 0) {
        const rawWorkspaces = await view.read('workspaces.json')
        const workspaceDoc = rawWorkspaces ? JSON.parse(rawWorkspaces.toString('utf8')) : { workspaces: [] }
        const targets = planTargets(workspaceDoc, rootDir, remapInput)
        checkPairs = planPairs(targets, remapInput, styleOfPlatform(platform()))
      }
    } catch {
      checkPairs = []
    }
    const problems = []
    let totalRefs = 0
    let totalMissing = 0
    let scanned = 0
    const comparisons = []
    let localIds = new Set()
    try {
      localIds = new Set((await ctx.sessionPersistence.list()).map((snapshot) => String(snapshot.header.id)))
    } catch {
      localIds = new Set()
    }
    for (const meta of manifest.sessions ?? []) {
      let document
      try {
        document = await loadSessionDocument(view, meta)
      } catch {
        continue
      }
      scanned += 1
      const result = auditDocument(document)
      totalRefs += result.refs
      totalMissing += result.missing
      const id = String(meta.id)
      const stamp = formatStamp(meta.createdAt ?? document.header?.createdAt)
      const title = sessionTitle(document) ?? (stamp ? `未命名会话 · ${stamp}` : '未命名会话')
      if (result.missing > 0) {
        problems.push({
          id,
          title,
          cwd: meta.cwd ?? null,
          refs: result.refs,
          missing: result.missing,
          missingIds: result.missingIds,
        })
      }
      // Same-name sessions decide what a re-import would do, so compare them now.
      const entry = {
        id,
        title,
        packTitle: title,
        packEvents: Array.isArray(document.events) ? document.events.length : 0,
        localEvents: null,
        verdict: 'new',
      }
      if (localIds.has(id)) {
        try {
          const local = await readLocalSession(id)
          entry.localEvents = Array.isArray(local.events) ? local.events.length : 0
          // The sidebar shows the local title; a bundle exported before a rename
          // still carries the old one, so prefer the local title and keep the pack's
          // as a hint when they differ.
          const localTitle = sessionTitle(local)
          if (localTitle) entry.title = localTitle
          entry.verdict = compareEvents(local.events, document.events, checkPairs)
        } catch {
          entry.verdict = 'unreadable'
        }
      }
      comparisons.push(entry)
    }
    const attachmentsInBundle = await view.has('attachments')
    const pluginsInBundle = await countBundlePlugins(view)
    return {
      path: dir,
      sessions: (manifest.sessions ?? []).length,
      scanned,
      attachmentsInBundle,
      attachmentService: Boolean(ctx.get('attachments')),
      totalRefs,
      totalMissing,
      plugins: pluginsInBundle,
      comparisons,
      problems,
      advice:
        totalMissing === 0
          ? null
          : attachmentsInBundle
            ? '包内带了 attachments 目录：勾选「包含图片附件」会把它们装到本机；导入后仍提示缺失，说明该附件在旧机器上就已经不在了。'
            : '包内没有附件。把旧机器的 ~/.dsh/attachments 整个拷到新机器同名位置，或重新导出并勾选附件。',
    }
  }

  /**
   * Batch import: one file per project is the natural handover, so the caller
   * may hand over several bundles at once. Each bundle is imported on its own
   * and the reports are merged; failures in one never stop the rest.
   */
  /** Counts from one bundle without importing it, used by the confirm step. */
  async function bundleInfo(path) {
    const target = resolve(String(path ?? ''))
    try {
      if (looksLikeBundleFile(target)) {
        const manifest = await readArchiveManifest(target)
        if (!manifest) return { path: target, error: '不是有效的迁移包' }
        return {
          path: target,
          name: basename(target),
          file: true,
          sessions: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
          workspaces: Array.isArray(manifest.workspaces) ? manifest.workspaces.length : 0,
          createdAt: manifest.createdAt ?? null,
          bytes: (await fsp.stat(target)).size,
        }
      }
      const manifest = await readManifest(target)
      return {
        path: target,
        name: basename(target),
        file: false,
        sessions: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
        workspaces: Array.isArray(manifest.workspaces) ? manifest.workspaces.length : 0,
        createdAt: manifest.createdAt ?? null,
        bytes: manifest.bytes ?? null,
      }
    } catch (error) {
      return { path: target, error: error instanceof Error ? error.message : String(error) }
    }
  }



  /** Resolve what to do with a Session that already exists locally. */
  async function resolveDecision(opts, sourceId, view, meta, decisions, diagnostics, pairs) {
    const explicit = decisions[sourceId]
    if (typeof explicit === 'string' && explicit.length > 0) return explicit
        // Batch mode has nobody to ask per Session, so pick the safe default:
        // append when the bundle is strictly ahead, fork when both grew, skip
        // when this machine is already ahead or the logs are identical.
        if (!opts.autoDecide) return 'skip'
        try {
          const local = await readLocalSession(sourceId)
          const packDocument = await loadSessionDocument(view, meta)
          // The bundle may extend a log that carries a stray seed marker where the
          // bundle has an inbox splice; that is still an append, only its start
          // index moves earlier so the splice is not skipped.
          if (appendPlan(local.events, packDocument.events)) return 'append'
          const verdict = compareEvents(local.events, packDocument.events, pairs)
          if (verdict === 'packAhead') return 'append'
          if (verdict === 'diverged') {
            const diff = firstDifference(local.events, packDocument.events)
            if (diff && diagnostics) diagnostics.push({ id: sourceId, ...diff })
            return 'fork'
          }
          return 'skip'
        } catch {
          return 'skip'
        }

  }

  /**
   * Import several bundles in one pass: preview/体检 already produced the
   * per-Session decisions, so each bundle is imported with the same decision map
   * and the reports are merged. One undone record is written for the whole run.
   */
  async function runBatchImport(task, options) {
    const paths = Array.isArray(options.bundlePaths) ? options.bundlePaths.map(String).filter(Boolean) : []
    if (paths.length === 0) throw new Error('没有选中的迁移包')
    const merged = {
      mode: 'batch',
      path: paths[0],
      batch: paths.length,
      bundles: [],
      workspaces: [],
      importedSessions: [],
      sessionsImported: 0,
      sessionsAppended: [],
      sessionsForked: [],
      sessionsSkipped: [],
      warnings: [],
      subagentSkipped: 0,
      flattened: 0,
      ungrouped: 0,
      unreadable: [],
      orphans: [],
      unattached: [],
      rewritten: 0,
      renamedFiles: 0,
      missingAttachments: 0,
      attachmentGaps: [],
      filesCopied: 0,
      attachments: false,
      recordSink: { workspaces: [], sessions: [], counts: {} },
    }
    let index = 0
    for (const bundlePath of paths) {
      index += 1
      task.message = `导入第 ${index}/${paths.length} 个包：${basename(bundlePath)}`
      try {
        const info = await bundleInfo(bundlePath)
        if (info.sessions === 0 && info.workspaces === 0) {
          merged.bundles.push({ path: bundlePath, ok: true, skipped: '空包（无会话、无工作区）' })
          continue
        }
        const one = await runImport(task, {
          ...options,
          bundlePath,
          recordSink: merged.recordSink,
        })
        merged.bundles.push({ path: bundlePath, ok: true, sessions: one.sessionsImported, warnings: one.warnings.length })
        merged.sessionsImported += one.sessionsImported
        merged.importedSessions.push(...one.importedSessions)
        merged.sessionsAppended.push(...one.sessionsAppended)
        merged.sessionsForked.push(...one.sessionsForked)
        merged.sessionsSkipped.push(...one.sessionsSkipped)
        merged.workspaces.push(...one.workspaces)
        merged.warnings.push(...one.warnings)
        merged.subagentSkipped += one.subagentSkipped ?? 0
        merged.flattened += one.flattened ?? 0
        merged.ungrouped += one.ungrouped ?? 0
        merged.rewritten += one.rewritten ?? 0
        merged.unreadable.push(...(one.unreadable ?? []))
        merged.orphans.push(...(one.orphans ?? []))
        merged.renamedFiles += one.renamedFiles ?? 0
        merged.missingAttachments += one.missingAttachments ?? 0
        merged.attachmentGaps.push(...(one.attachmentGaps ?? []))
        merged.filesCopied += one.filesCopied ?? 0
        merged.attachments = merged.attachments || Boolean(one.attachments)
      } catch (error) {
        merged.bundles.push({ path: bundlePath, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    await writeLastImport({
      at: new Date().toISOString(),
      bundle: null,
      workspaces: merged.recordSink.workspaces,
      sessions: merged.recordSink.sessions,
      counts: merged.recordSink.counts,
      contentCounts: merged.recordSink.contentCounts,
    })
    task.done += 1
    return merged
  }

  async function runImport(task, options) {
    if (!options.bundlePath) throw new Error('缺少迁移包路径')
    // A bundle is read through one view: a folder is used in place, a .dshmig is
    // read entry by entry, so no temporary copy of the package is made.
    const view = await openBundleView(options.bundlePath)
    try {
      return await runImportFromView(task, options, view)
    } finally {
      await view.close()
    }
  }

  async function runImportFromView(task, options, view) {
    const dir = resolve(String(options.bundlePath ?? ''))
    const manifest = await readManifestView(view)
    const workspaceDoc = JSON.parse((await view.read('workspaces.json')).toString('utf8'))
    const rootDir =
      options.rootDir && String(options.rootDir).trim() ? resolve(normalizeTargetPath(options.rootDir)) : null
    const remapInput = options.remap && typeof options.remap === 'object' ? options.remap : {}

    // Resolve one target directory per bundled project: an explicit per-project
    // mapping wins, then <rootDir>/<project title>, then the original path.
    const targets = planTargets(workspaceDoc, rootDir, remapInput)

    // A root on a drive that does not exist (wrong letter, unmounted disk) used
    // to fail halfway: sessions imported, files missing, and the report only said
    // "mkdir '\\?'". Refuse the whole import up front so nothing is half-done.
    if (rootDir) {
      const driveRoot = parse(rootDir).root
      const localStyleForRoot = styleOfPlatform(platform())
      if (localStyleForRoot === 'win' && driveRoot && driveRoot.length >= 2 && !(await pathExists(driveRoot))) {
        throw new Error(`目标根目录不可用：${driveRoot} 不存在（盘符不对，或磁盘/移动盘未挂载）`)
      }
      try {
        await fsp.mkdir(rootDir, { recursive: true })
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : String(error)
        throw new Error(`无法创建目标根目录：${rootDir}（${code}）`)
      }
    }

    // The bundle records which OS it came from and which one it was packed
    // for; when the two styles differ the separators inside remapped paths
    // have to be converted, or the path stops resolving on the target.
    const bundleStyle = styleOfPlatform(manifest.source?.platform ?? platform())
    const localStyle = styleOfPlatform(platform())
    const declaredTarget = normalizeTargetPlatform(manifest.target?.platform)
    const crossOs = bundleStyle !== localStyle

    const pairs = []
    for (const entry of targets) {
      if (entry.source.path === entry.target) continue
      pairs.push({ from: entry.source.path, to: entry.target, toStyle: localStyle })
    }
    for (const [from, to] of Object.entries(remapInput)) {
      if (!from || !to || String(from).trim() === String(to).trim()) continue
      if (targets.some((entry) => normalKey(entry.source.path) === normalKey(from))) continue
      pairs.push({ from: String(from), to: String(to), toStyle: localStyle })
    }
    pairs.sort((a, b) => normalKey(b.from).length - normalKey(a.from).length)

    // File names Windows cannot store are sanitized before anything is imported,
    // and each rename is added to the path pairs so Session text that mentions the
    // old name is rewritten to the new one instead of pointing at nothing.
    const renamePairs = []
    const fileRenames = new Map()
    if (localStyle === 'win') {
      for (const entry of targets) {
        const workspace = entry.source
        const folder = workspace.folder ? String(workspace.folder) : safeName(workspace.id)
        for (const name of await view.list(`files/${folder}`)) {
          const relative = name.slice(`files/${folder}/`.length)
          const safe = sanitizeRelativeName(relative, localStyle)
          if (!safe) continue
          fileRenames.set(`${folder}/${relative}`, safe)
          // Two spellings: the tail after a root rewrite may keep forward
          // slashes, so both a Windows and a POSIX form must match.
          const renameFrom = join(entry.target, ...relative.split('/'))
          const renameTo = join(entry.target, ...safe.split('/'))
          renamePairs.push({ from: renameFrom, to: renameTo, toStyle: 'win' })
          renamePairs.push({ from: renameFrom, to: renameTo, toStyle: 'posix' })
        }
      }
      if (fileRenames.size > 0) {
        // `report` is declared further down; only the ordering matters here.
        renamePairs.sort((a, b) => normalKey(b.from).length - normalKey(a.from).length)
      }
    }

    const forkDiagnostics = []
    const decisions =
      options.sessionDecisions && typeof options.sessionDecisions === 'object' ? options.sessionDecisions : {}

    const newWorkspaceIds = []
    const newSessionIds = []
    const sessionCounts = {}
    const contentCounts = {}
    const report = {
      path: dir,
      crossOs,
      bundleStyle,
      localStyle,
      illegalNames: manifest.target?.illegalNames ?? 0,
      rootDir,
      workspaces: [],
      sessionsImported: 0,
      importedSessions: [],
      sessionsSkipped: [],
      sessionsAppended: [],
      sessionsForked: [],
      sessionsCopied: [],
      subagentSkipped: 0,
      flattened: 0,
      ungrouped: 0,
      rewritten: 0,
      missingAttachments: 0,
      attachmentGaps: [],
      filesCopied: 0,
      filesNew: 0,
      filesUnchanged: 0,
      filesSkippedExisting: 0,
      fileSkips: [],
      attachments: false,
      renamedFiles: fileRenames.size,
      unreadable: [],
      orphans: [],
      unattached: [],
      warnings: [],
    }
    const willInstallAttachments = Boolean(options.includeAttachments) && (await view.has('attachments'))

    const snapshots = await ctx.sessionPersistence.list()
    const localVersion = pickFormatVersion(snapshots)
    if (manifest.formatVersion && localVersion && localVersion < manifest.formatVersion) {
      report.warnings.push(
        `迁移包来自更新的格式 v${manifest.formatVersion}，本机是 v${localVersion}；会话可能无法导入，建议两台机器使用同一版本的 DSH。`,
      )
    }

    const preOrder = ctx.workspaceRegistry.list().map((workspace) => String(workspace.id))
    const preExisting = new Set(preOrder)
    const created = []
    // Which Workspace each imported Session belongs to, for the attach check.
    const attachTargets = new Map()
    task.total = (workspaceDoc.workspaces ?? []).length + (manifest.sessions ?? []).length + 2

    for (const entry of targets) {
      try {
        await fsp.mkdir(entry.target, { recursive: true })
        const entity = await ctx.workspaceRegistry.create(entry.target, entry.source.title)
        if (entry.source.title && entity.title !== entry.source.title && !preExisting.has(String(entity.id))) {
          try {
            await entity.setTitle(entry.source.title)
          } catch {
            /* rename is cosmetic; keep the created title */
          }
        }
        created.push({ source: entry.source, entity, target: entry.target })
        if (!preExisting.has(String(entity.id))) createdWorkspaces.add(String(entity.id))
        if (!preExisting.has(String(entity.id))) newWorkspaceIds.push(String(entity.id))
        report.workspaces.push({ id: String(entity.id), path: entry.target, title: entity.title, from: entry.source.path })
      } catch (error) {
        report.warnings.push(
          `项目「${entry.source.title}」创建失败（${entry.target}）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      task.done += 1
      task.message = `已创建项目 ${created.length}/${targets.length}`
    }

    const tailAnchor = preOrder[0]
    for (let index = created.length - 1; index >= 0; index -= 1) {
      const anchor = created[index + 1]?.entity.id ?? tailAnchor
      try {
        await ctx.workspaceRegistry.insertBefore(created[index].entity.id, anchor)
      } catch {
        /* order is cosmetic */
      }
    }

    const existing = new Set(snapshots.map((snapshot) => String(snapshot.header.id)))
    const attached = new Set()

    for (const meta of manifest.sessions ?? []) {
      const sourceId = String(meta.id)
      // Subagent transcripts belong to the machinery, not the user's list: an
      // import that flattened them into normal Sessions produced untitled rows
      // that also failed to load, so skip them outright.
      if (meta.origin === 'subagent') {
        report.subagentSkipped += 1
        task.done += 1
        continue
      }
      let id = sourceId
      if (existing.has(sourceId)) {
        const choice = await resolveDecision(options, sourceId, view, meta, decisions, forkDiagnostics, pairs)
        if (options.autoDecide && !decisions[sourceId]) report.autoDecided += 1
        if (choice === 'append') {
          // The bundle only adds events, so extend the local log in place.
          try {
            const local = await readLocalSession(sourceId)
            const packDocument = await loadSessionDocument(view, meta)
            const packEvents = Array.isArray(packDocument.events) ? packDocument.events : []
            const localEvents = Array.isArray(local.events) ? local.events : []
            const localCount = localEvents.length
            // Align on the first strict difference. A local log written by an
            // older build can carry a stray `session/end-seed`, which hides the
            // bundle's inbox splice: appending from `localCount` would then start
            // after the enqueue and the next splice would remove nothing.
            const diverge = firstStrictDifference(localEvents, packEvents)
            const extraLocal = localEvents.slice(diverge)
            const onlyBookkeeping = extraLocal.every((event) => isBookkeepingEvent(event))
            const start = diverge < localCount && onlyBookkeeping ? diverge : localCount
            if (packEvents.length > start) {
              const handle = await openForWrite(sourceId)
              const delta = localCount - start
              const tail = JSON.parse(JSON.stringify(packEvents.slice(start)))
              try {
                // Appended events come from the old machine: rewrite their paths
                // so the continued history points at this machine, not the other one.
                for (const event of tail) {
                  if (Number.isFinite(event.seq)) event.seq += delta
                  if (delta !== 0 && event.data && typeof event.data === 'object') {
                    event.data = shiftSeqRefs(event.data, 0, delta)
                  }
                  if (delta !== 0 && Array.isArray(event.sourceEventSeqs)) {
                    event.sourceEventSeqs = event.sourceEventSeqs.map((value) => value + delta)
                  }
                  if (options.rewritePaths !== false) {
                    if (event.data && typeof event.data === 'object') {
                      const stats = { count: 0 }
                      event.data = rewritePaths(event.data, pairs, stats)
                      if (renamePairs.length > 0) event.data = rewritePaths(event.data, renamePairs, stats)
                      report.rewritten += stats.count
                    }
                  }
                }
                await handle.append(tail)
                await handle.flush()
              } finally {
                await handle.close()
              }
              report.sessionsAppended.push({ id: sourceId, added: tail.length, resequenced: delta })
            } else {
              report.sessionsSkipped.push({ id: sourceId, reason: '包内没有更多内容' })
            }
          } catch (error) {
            report.warnings.push(
              `追加更新失败：${sourceId}（${error instanceof Error ? error.message : String(error)}）`,
            )
          }
          task.done += 1
          continue
        }

        if (choice === 'fork') {
          const why = forkDiagnostics.find((entry) => entry.id === sourceId)
          if (why) {
            report.warnings.push(`会话 ${sourceId} 判定为两边都有新增：第 ${why.index} 条不同（本地 ${why.localType} / 包 ${why.packType}）`)
          }
          // A fork keeps both sides: the shared prefix is copied verbatim from
          // this machine, then the bundle's branch continues after the marker.
          try {
            const local = await readLocalSession(sourceId)
            const packDocument = await loadSessionDocument(view, meta)
            const localEvents = Array.isArray(local.events) ? local.events : []
            const packEvents = Array.isArray(packDocument.events) ? packDocument.events : []
            let prefix = 0
            const min = Math.min(localEvents.length, packEvents.length)
            while (prefix < min && JSON.stringify(localEvents[prefix]) === JSON.stringify(packEvents[prefix])) {
              prefix += 1
            }
            if (prefix === 0) throw new Error('两边没有共同前缀，无法分叉')
            const forkId = `session-${randomUUID()}`
            // The Host only exempts events before the inherited cut from the
            // "delivery marker names the right session" rule, so the tail must
            // own the new id while the inherited prefix keeps the parent's.
            let tailEvents = packEvents.slice(prefix).map((event) => JSON.parse(JSON.stringify(event)))
            if (sourceId !== forkId) {
              tailEvents = JSON.parse(JSON.stringify(tailEvents).split(sourceId).join(forkId))
            }
            // Give the branch a title; DSH puts its title event right after the
            // fork marker, and an unnamed child is hard to pick out in the list.
            const packTitle = sessionTitle(packDocument) || sessionTitle(local)
            const titleTemplate = packEvents.find((event) => event && event.type === 'session/title')
            const titleEvent = titleTemplate && packTitle
              ? (() => {
                  const clone = JSON.parse(JSON.stringify(titleTemplate))
                  clone.data = { ...(clone.data || {}), title: `${packTitle}（分叉）` }
                  return clone
                })()
              : null
            const delta = titleEvent ? 2 : 1
            const tail = tailEvents.map((event, index) => {
              const clone = event
              clone.seq = prefix + delta + index
              if (clone.data !== undefined) clone.data = shiftSeqRefs(clone.data, prefix, delta)
              return clone
            })
            if (titleEvent) titleEvent.seq = prefix + 1
            if (options.rewritePaths !== false && pairs.length > 0) {
              const stats = { count: 0 }
              for (const event of tail) {
                if (event && event.data && typeof event.data === 'object') {
                  event.data = rewritePaths(event.data, pairs, stats)
                }
              }
              report.rewritten += stats.count
            }
            const marker = { type: 'session/end-seed', seq: prefix, time: Date.now(), data: { inherited: true } }
            const header = { ...packDocument.header }
            // Undefined keys would survive as own properties and then vanish in
            // JSON, which the Host rejects as "not losslessly serializable".
            delete header.origin
            header.id = forkId
            header.parentSession = sourceId
            header.isSeeded = true
            header.delegationDepth = 0
            if (typeof localVersion === 'number') header.version = localVersion
            for (const key of Object.keys(header)) {
              if (header[key] === undefined) delete header[key]
            }
            if (header.cwd && pairs.length > 0 && typeof header.cwd === 'string') {
              header.cwd = mapPath(header.cwd, pairs)
            }
            // A seeded header is only valid together with the exact inherited
            // prefix length, which the Host validates at create time.
            const handle = await ctx.sessionPersistence.create(header, { inheritedEventCount: prefix })
            // What the Host actually kept decides whether this can be a fork at
            // all: a seeded header without its parent cannot pass the delivery
            // marker rule, so report that instead of writing a broken log.
            const kept = handle.header ?? {}
            if (kept.parentSession !== sourceId || kept.isSeeded !== true) {
              try {
                await handle.close()
              } catch {
                /* nothing was written yet */
              }
              throw new Error(
                `Host 未保留分叉头（parentSession=${kept.parentSession ?? '缺失'}, isSeeded=${kept.isSeeded ?? '缺失'}）`,
              )
            }
            try {
              const branch = [...localEvents.slice(0, prefix), marker]
              if (titleEvent) branch.push(titleEvent)
              branch.push(...tail)
              await handle.append(branch)
              await handle.flush()
            } finally {
              await handle.close()
            }
            // Read it back immediately: a fork the Host refuses to open is worse
            // than no fork, so refuse to leave one behind.
            try {
              const probe = await ctx.sessionPersistence.open(forkId, 'read')
              try {
                await probe.read()
              } finally {
                await probe.close()
              }
            } catch (error) {
              try {
                await removeSessionDirs(home, forkId)
              } catch {
                /* removal is the fallback; the warning below still reports it */
              }
              throw new Error(`写入后自检未通过，已删除该分叉：${error instanceof Error ? error.message : String(error)}`)
            }
            report.sessionsForked.push({ id: forkId, from: sourceId, prefix, tail: tail.length })
            sessionCounts[forkId] = prefix + (titleEvent ? 1 : 0) + tail.length + 1
            contentCounts[forkId] = contentEventCount([...localEvents.slice(0, prefix), marker, ...(titleEvent ? [titleEvent] : []), ...tail])
            newSessionIds.push(forkId)
            const match = created.find((entry) => normalKey(header.cwd ?? '') === normalKey(entry.target))
            if (match) {
              try {
                await match.entity.attachSession(forkId)
              } catch {
                /* attachment to a workspace is best effort */
              }
            }
          } catch (error) {
            // Forking needs Host support the build may lack: fall back to a plain
            // copy so the branch content still arrives, clearly marked as a copy.
            const reason = error instanceof Error ? error.message : String(error)
            try {
              const packDocument = await loadSessionDocument(view, meta)
              const copyId = `session-${randomUUID()}`
              const copyHeader = { ...packDocument.header, id: copyId, isSeeded: false, delegationDepth: 0 }
              delete copyHeader.origin
              delete copyHeader.parentSession
              if (typeof localVersion === 'number') copyHeader.version = localVersion
              for (const key of Object.keys(copyHeader)) {
                if (copyHeader[key] === undefined) delete copyHeader[key]
              }
              if (copyHeader.cwd && pairs.length > 0 && typeof copyHeader.cwd === 'string') {
                copyHeader.cwd = mapPath(copyHeader.cwd, pairs)
              }
              const packEvents = Array.isArray(packDocument.events) ? packDocument.events : []
              let copyEvents = JSON.parse(JSON.stringify(packEvents).split(sourceId).join(copyId))
              if (options.rewritePaths !== false && pairs.length > 0) {
                const stats = { count: 0 }
                for (const event of copyEvents) {
                  if (event && event.data && typeof event.data === 'object') {
                    event.data = rewritePaths(event.data, pairs, stats)
                  }
                }
                report.rewritten += stats.count
              }
              const strippedCopy = stripInheritedSeedMarkers(copyEvents)
              copyEvents = strippedCopy.events
              if (strippedCopy.stripped > 0) report.inheritedMarkersStripped = (report.inheritedMarkersStripped ?? 0) + strippedCopy.stripped
              const copyHandle = await ctx.sessionPersistence.create(copyHeader)
              try {
                if (copyEvents.length > 0) await copyHandle.append(copyEvents)
                await copyHandle.flush()
              } finally {
                await copyHandle.close()
              }
              report.sessionsCopied.push({ id: copyId, from: sourceId, reason })
              sessionCounts[copyId] = copyEvents.length
              contentCounts[copyId] = contentEventCount(copyEvents)
              newSessionIds.push(copyId)
              const target = created.find((entry) => normalKey(copyHeader.cwd ?? '') === normalKey(entry.target))
              if (target) {
                try {
                  await target.entity.attachSession(copyId)
                } catch {
                  /* attachment to a workspace is best effort */
                }
              }
            } catch (copyError) {
              report.warnings.push(
                `导入同名会话失败：${sourceId}（分叉：${reason}；副本：${copyError instanceof Error ? copyError.message : String(copyError)}）`,
              )
            }
          }
          task.done += 1
          continue
        }
        report.sessionsSkipped.push({ id: sourceId, reason: '本机已存在同名会话' })
        task.done += 1
        continue
      }
      try {
        const document = await loadSessionDocument(view, meta)
        // Older bundles do not record `origin` in the manifest, so the document
        // itself is the only place left to spot a subagent transcript.
        if (document.header && document.header.origin === 'subagent') {
          report.subagentSkipped += 1
          task.done += 1
          continue
        }
        if (!willInstallAttachments) {
          const audit = auditDocument(document)
          if (audit.missing > 0) {
            report.missingAttachments += 1
            report.attachmentGaps.push({ id, missing: audit.missing, total: audit.refs })
          }
        }
        let events = Array.isArray(document.events) ? document.events : []
        let header = {
          ...document.header,
          version: typeof localVersion === 'number' ? localVersion : document.header.version,
        }
        if (header.cwd) {
          header.cwd = mapPath(header.cwd, pairs)
          if (pairs.length > 0 && isUnderTargets(header.cwd, targets)) {
            try {
              await fsp.mkdir(header.cwd, { recursive: true })
            } catch {
              /* creating the working directory is best effort */
            }
          }
        }

        // Historical tool calls and results still name the old machine's paths.
        if (options.rewritePaths !== false && pairs.length > 0) {
          const stats = { count: 0 }
          for (const event of events) {
            if (event && event.data && typeof event.data === 'object') {
              event.data = rewritePaths(event.data, pairs, stats)
            }
          }
          report.rewritten += stats.count
          // Renames apply to the *target* layout, so they run after the root
          // mapping has turned source paths into target ones.
          if (renamePairs.length > 0) {
            const after = { count: 0 }
            for (const event of events) {
              if (event && event.data && typeof event.data === 'object') {
                event.data = rewritePaths(event.data, renamePairs, after)
              }
            }
            report.rewritten += after.count
          }
        }

        if (header.isSeeded) {
          const inherited = Number(document.inheritedEventCount ?? 0)
          const parentId = header.parentSession ? String(header.parentSession) : null
          const parentMeta = parentId ? (manifest.sessions ?? []).find((entry) => String(entry.id) === parentId) : null
          const markerIndex = events.findIndex((event) => event && event.type === 'session/end-seed')
          if (markerIndex > 0) {
            // A DSH fork carries its inherited prefix inside its own log: the
            // events before the marker are a verbatim copy of the parent, so the
            // conversation is complete even when the parent file is absent.
            // Keep everything, drop the marker and renumber: the Session becomes
            // a normal, standalone conversation instead of a fork the host cannot
            // resolve on this machine.
            // Keep the event stream verbatim (see the plain-session branch below):
            // the embedded prefix already makes the conversation complete, and the
            // marker stays where DSH put it.
            header = { ...header, isSeeded: false, parentSession: undefined, origin: undefined, delegationDepth: undefined }
            report.flattened += 1
            report.embeddedFlattened = (report.embeddedFlattened ?? 0) + 1
          } else if (parentMeta && inherited > 0) {
            const parentDocument = await loadSessionDocument(view, parentMeta)
            const parentEvents = Array.isArray(parentDocument.events) ? parentDocument.events : []
            if (parentEvents.length < inherited) {
              report.sessionsSkipped.push({ id, reason: '分叉会话的父会话事件不足以还原种子，已跳过' })
              task.done += 1
              continue
            }
            // The seed marker is an internal boundary: a flattened Session must
            // carry none, and removing it leaves a hole in the sequence the host
            // checks (`seq === index`), so the merged list is renumbered and every
            // seq reference inside the events is moved along with it.
            events = [...parentEvents.slice(0, inherited), ...events]
            header = { ...header, isSeeded: false, parentSession: undefined, origin: undefined, delegationDepth: undefined }
            report.flattened += 1
          } else if (markerIndex === 0) {
            // The prefix was not embedded and the parent is unavailable: import
            // the branch alone, which is what the user can still open, and say so.
            header = { ...header, isSeeded: false, parentSession: undefined, origin: undefined, delegationDepth: undefined }
            report.truncatedForks = (report.truncatedForks ?? 0) + 1
          } else {
            report.sessionsSkipped.push({ id, reason: '分叉会话既没有内嵌前缀也没有父会话，无法还原，已跳过' })
            task.done += 1
            continue
          }
        }
        if (!header.isSeeded) {
          const strippedFork = stripInheritedSeedMarkers(events)
          events = strippedFork.events
          if (strippedFork.stripped > 0) report.inheritedMarkersStripped = (report.inheritedMarkersStripped ?? 0) + strippedFork.stripped
        }
        if (!header.isSeeded) {
          // Plain sessions legitimately carry `session/end-seed` markers: DSH
          // writes one whenever a fork boundary is recorded, and a long-running
          // conversation can hold dozens. Stripping them (and renumbering) used
          // to leave the log subtly different from what the Host wrote, and a
          // session whose markers were removed could no longer be continued.
          // Import the stream exactly as it was exported.
          report.seedMarkersPreserved = (report.seedMarkersPreserved ?? 0) + events.filter((event) => event && event.type === 'session/end-seed').length
        }

        // 旧版 DSH 会把 compaction/prune 写在 compaction/start 之前（上下文先被裁，
        // 之后才记一次压缩）。新版读取器要求每个 checkpoint 都有匹配的 start，于是
        // 整条会话报 "compaction checkpoint has no matching compaction/start"。
        // 这种「prune 早于任何 start」的日志自动按兼容模式处理，不必让用户勾选。
        let autoDropCompaction = false
        if (options.dropCompaction !== true) {
          const firstStart = events.findIndex((event) => event && event.type === 'compaction/start')
          const earlyPrune = events.some(
            (event, index) => event && event.type === 'compaction/prune' && (firstStart < 0 || index < firstStart),
          )
          if (earlyPrune) {
            autoDropCompaction = true
            report.compactionAutoDropped = (report.compactionAutoDropped ?? 0) + 1
          }
        }
        // 可选兼容模式：旧版 DSH 写的日志里带 compaction/prune 记账，本地读取器会
        // 以「shadowedSeqs 不是当前 surface 的精确区间」拒绝整条会话。丢掉这些记账
        // 事件（消息本身都在），再重编号并搬移所有 seq 引用。
        if (options.dropCompaction === true || autoDropCompaction) {
          const before = events.length
          // compaction/* 与「压缩产出」的 checkpoint 消息是一体的：只丢前者，后者会
          // 变成「没有 start 的 checkpoint」，新版读取器照样拒绝。两者一起丢。
          const kept = events.filter(
            (event) =>
              !/^compaction\//.test(String(event && event.type)) &&
              event?.data?.source?.kind !== 'compact-checkpoint',
          )
          if (kept.length !== before) {
            events = renumberEvents(kept, null)
            report.compactionDropped = (report.compactionDropped ?? 0) + (before - kept.length)
            // 删掉事件后，原来那些 `surfaceOp: replace` 的区间（tool/result 覆盖、
            // checkpoint 收敛等）就落在「当前 surface」之外了，新版读取器会报
            // "replacement range is not on the current surface"。
            // 兼容模式里把覆盖改成追加：内容都在，只是同一段上下文会多出一条记录。
            let flattenedOps = 0
            for (const event of events) {
              if (event && event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
                event.surfaceOp = 'append'
                delete event.sourceEventSeqs
                flattenedOps += 1
              }
            }
            if (flattenedOps > 0) report.replaceOpsFlattened = (report.replaceOpsFlattened ?? 0) + flattenedOps
            // 压缩重放出来的旧 turn/step 事件一并清掉，否则新版读取器报
            // "tool/result does not match an open turn and step"。
            const repaired = dropOutOfTurnEvents(events)
            if (repaired.dropped > 0) {
              events = renumberEvents(repaired.kept, null)
              report.turnStepRepaired = (report.turnStepRepaired ?? 0) + repaired.dropped
            }
          }
            // 整段历史可能远超模型窗口（本例约 3.4M token）。导入前先按预算裁到最近
            // 若干回合，否则会出现「导入成功，一发消息就 CONTEXT_WINDOW_EXCEEDED」。
            const budgetChars = Number(options.contextBudgetChars) > 0 ? Number(options.contextBudgetChars) : 700_000
            const estimate = Math.round(surfaceTextLength(events) / 2)
            if (estimate > budgetChars / 2) {
              const trimmed = trimToContextBudget(events, budgetChars)
              if (trimmed.dropped > 0) {
                // 裁剪会切断「请求」链：llm/retry 之类记账事件找不到匹配的
                // request/header，新版读取器报 "retry provider does not match the
                // open request/header"。这些纯记账事件一并丢掉，内容事件不受影响。
                const content = trimmed.kept.filter(
                  (event) =>
                    !/^llm\//.test(String(event && event.type)) &&
                    !/^request\//.test(String(event && event.type)) &&
                    !/^session-log-/.test(String(event && event.type)) &&
                    !/-llm-request$/.test(String(event && event.type)) &&
                    String(event && event.type) !== 'assistant/attempt' &&
                    // 收件箱拼接依赖此前状态，裁剪后首条 splice 往往落在区间外
                    // （invalid persisted inbox splice）；队列记账一并丢掉。
                    String(event && event.type) !== 'agent/inbox/spliced',
                )
                const machineryDropped = trimmed.kept.length - content.length
                if (machineryDropped > 0) report.machineryDropped = (report.machineryDropped ?? 0) + machineryDropped
                events = renumberTurns(renumberEvents(content, null))
                report.contextTrimmed = (report.contextTrimmed ?? 0) + 1
                report.contextTrimmedEvents = (report.contextTrimmedEvents ?? 0) + trimmed.dropped
                report.contextTrimmedTurns = trimmed.turns ?? null
                report.contextEstimatedTokens = Math.round(surfaceTextLength(events) / 2)
              }
            }
            // 兜底：确认表层第一条是受保护的 system/message（缺了就补一条）。
            const head = ensureProtectedHead(events)
            if (head.inserted > 0) {
              events = head.events
              report.headInserted = (report.headInserted ?? 0) + 1
            }
        }
        // Inherited events may still name the parent Session; make them name this one.
        events = rewriteForeignSessionIds(events, id)
        // Setting a key to `undefined` leaves an own property that JSON drops, and
        // the host then rejects the header as "not losslessly JSON-serializable".
        // Delete those keys instead of assigning them.
        for (const key of Object.keys(header)) {
          if (header[key] === undefined) delete header[key]
        }
        // 最后一道防线：unseeded 日志里绝不能残留 inherited end-seed 标记，
        // 否则 DSH 整条拒读。上面任何分支（展开/合并/降级副本）都可能拼进父事件。
        if (!header.isSeeded) {
          const strippedFinal = stripInheritedSeedMarkers(events)
          events = strippedFinal.events
          if (strippedFinal.stripped > 0) {
            report.inheritedMarkersStripped = (report.inheritedMarkersStripped ?? 0) + strippedFinal.stripped
          }
        }
        const handle = await ctx.sessionPersistence.create(header)
        try {
          if (events.length > 0) await handle.append(events)
          await handle.flush()
        } finally {
          await handle.close()
        }
        existing.add(id)
        createdSessions.add(id)
        newSessionIds.push(id)
        sessionCounts[id] = events.length
        contentCounts[id] = contentEventCount(events)
        report.sessionsImported += 1
        report.importedSessions.push(id)

        const match = created.find((entry) => normalKey(header.cwd ?? '') === normalKey(entry.target))
        if (match) attachTargets.set(id, match.entity)
        if (match && !attached.has(`${match.entity.id}:${id}`)) {
          try {
            await match.entity.attachSession(id)
            attached.add(`${match.entity.id}:${id}`)
          } catch (error) {
            report.warnings.push(`会话 ${id} 归属到项目失败：${error instanceof Error ? error.message : String(error)}`)
          }
        } else if (!match) {
          report.ungrouped += 1
        }
      } catch (error) {
        report.sessionsSkipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
      }
      task.done += 1
      task.message = `已导入会话 ${report.sessionsImported}/${(manifest.sessions ?? []).length}`
    }

    for (const id of workspaceDoc.pinned ?? []) {
      if (!existing.has(String(id))) continue
      try {
        await ctx.workspaceRegistry.pinSession(String(id))
      } catch {
        /* pin is cosmetic */
      }
    }
    for (const id of workspaceDoc.archived ?? []) {
      if (!existing.has(String(id))) continue
      try {
        await ctx.workspaceRegistry.archiveSession(String(id))
      } catch {
        /* archive is cosmetic */
      }
    }

    if (options.includeFiles) {
      for (const entry of targets) {
        const workspace = entry.source
        const folder = workspace.folder ? String(workspace.folder) : safeName(workspace.id)
        const names = await view.list(`files/${folder}`)
        if (names.length === 0) continue
        try {
          // Copy per file, not per directory: on a second import the project
          // already has files, and skipping the whole tree would silently drop
          // everything the old machine added since (test-3.md and friends).
          let copied = 0
          let unchanged = 0
          let skipped = 0
          for (const name of names) {
            const relative = name.slice(`files/${folder}/`.length)
            const finalRelative = fileRenames.get(`${folder}/${relative}`) ?? relative
            const destination = join(entry.target, ...finalRelative.split('/'))
            const data = await view.read(name)
            if (!data) continue
            let existing = null
            try {
              existing = await fsp.readFile(destination)
            } catch {
              existing = null
            }
            if (existing) {
              if (existing.equals(data)) {
                unchanged += 1
                continue
              }
              if (!options.overwriteFiles) {
                skipped += 1
                if (report.fileSkips.length < 20) {
                  report.fileSkips.push({ path: destination, reason: '目标已存在且内容不同，未覆盖' })
                }
                continue
              }
            }
            await fsp.mkdir(dirname(destination), { recursive: true })
            await fsp.writeFile(destination, data)
            copied += 1
          }
          if (copied > 0) report.filesCopied += 1
          report.filesNew = (report.filesNew ?? 0) + copied
          report.filesUnchanged = (report.filesUnchanged ?? 0) + unchanged
          report.filesSkippedExisting = (report.filesSkippedExisting ?? 0) + skipped
        } catch (error) {
          report.warnings.push(`复制项目文件失败：${entry.target}（${error instanceof Error ? error.message : String(error)}）`)
        }
      }
    }

    if (options.includeAttachments && (await view.has('attachments'))) {
      try {
        const names = await view.list('attachments')
        for (const name of names) {
          const relative = name.slice('attachments/'.length)
          const destination = join(dshHome(), 'attachments', ...relative.split('/'))
          const data = await view.read(name)
          if (!data) continue
          await fsp.mkdir(dirname(destination), { recursive: true })
          // 已存在且大小一致的附件不动它：既省时间，也避免撞上被别的进程占用的文件
          // （Windows 上表现为 EPERM: operation not permitted）。
          try {
            const existing = await fsp.stat(destination)
            if (existing.size === data.length) continue
          } catch {
            /* 不存在就照常写 */
          }
          try {
            await fsp.writeFile(destination, data)
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
            if (code !== 'EPERM' && code !== 'EACCES') throw error
            try {
              await fsp.chmod(destination, 0o666)
            } catch {
              /* 去只读失败就再试一次写入 */
            }
            await fsp.writeFile(destination, data)
          }
        }
        report.attachments = names.length > 0
      } catch (error) {
        report.warnings.push(`复制附件失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Read every imported Session back: a file that was written but cannot be
    // parsed shows up in the sidebar as a broken entry, so the report must say
    // so instead of claiming a clean import.
    const existingIds = new Set(snapshots.map((snapshot) => String(snapshot.header.id)))
    const importedIds = new Set(newSessionIds)
    const brokenIds = []
    for (const id of newSessionIds) {
      try {
        const local = await readLocalSession(id)
        if (!Array.isArray(local.events) || local.events.length === 0) {
          report.unreadable.push({ id, reason: '导入后读取为空' })
          brokenIds.push(id)
        }
      } catch (error) {
        report.unreadable.push({ id, reason: error instanceof Error ? error.message : String(error) })
        brokenIds.push(id)
      }
    }
    // A session the host cannot read is worse than a missing one: it breaks the
    // project list in the sidebar. Move those aside instead of leaving them.
    if (brokenIds.length > 0) {
      try {
        const moved = await trashSessionDirs(dshHome(), brokenIds)
        report.brokenRemoved = brokenIds.length
        if (moved && moved.trashDir) report.brokenTrash = moved.trashDir
      } catch (error) {
        report.warnings.push(`清理无法读取的会话失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // A Session whose parent is neither in this bundle nor on this machine will
    // open as a headless fragment, so name it rather than leaving it silent.
    for (const meta of manifest.sessions ?? []) {
      const id = String(meta.id)
      if (!importedIds.has(id)) continue
      const parentId = meta.parent ? String(meta.parent) : null
      if (!parentId) continue
      if (importedIds.has(parentId) || existingIds.has(parentId)) continue
      report.orphans.push({ id, parent: parentId })
    }

    // The sidebar lists a Session under a Workspace through the registry, so a
    // Session that never got attached looks like an empty project. Verify and
    // retry once, then report what still is not attached.
    for (const id of report.importedSessions) {
      const attachedNow = ctx.workspaceRegistry
        .list()
        .some((workspace) => [...(workspace.sessionIds ?? [])].map(String).includes(id))
      if (attachedNow) continue
      const home = attachTargets.get(id)
      if (home) {
        try {
          await home.attachSession(id)
        } catch {
          /* reported below */
        }
      }
      const ok = ctx.workspaceRegistry
        .list()
        .some((workspace) => [...(workspace.sessionIds ?? [])].map(String).includes(id))
      if (!ok) report.unattached.push(id)
    }

    if (options.recordSink) {
      options.recordSink.workspaces.push(...newWorkspaceIds)
      options.recordSink.sessions.push(...newSessionIds)
      Object.assign(options.recordSink.counts, sessionCounts)
      if (options.recordSink.contentCounts) Object.assign(options.recordSink.contentCounts, contentCounts)
    } else if (newWorkspaceIds.length === 0 && newSessionIds.length === 0) {
      // A run that only appended (or only skipped) creates nothing to undo; keep
      // the previous record so「撤销上一次导入」still knows the sessions it made.
      const kept = await probeLastImport()
      if (kept) report.undoKept = true
    } else {
      await writeLastImport({
        at: new Date().toISOString(),
        bundle: dir,
        workspaces: newWorkspaceIds,
        sessions: newSessionIds,
        counts: sessionCounts,
        contentCounts,
      })
    }
    task.done += 1
    return report
  }

  // ── 会话路径（独立功能：就地修改会话的工作目录，不涉及跨机迁移） ──────────
  // 只读写本机 ~/.dsh 的三处：会话日志首行的 header.cwd、日志所在目录名、投影缓存。
  // 不调用迁移的任何代码路径，也不复用迁移的导入/导出逻辑。
  const SESSION_PATH_PREFIX = '/api/dsh-session-path'

  function sessionsStoreRoot() {
    return join(dshHome(), 'sessions')
  }

  function sessionProjCacheRoot() {
    return join(dshHome(), 'storages', 'session_projcache', 'sessions')
  }

  /** 把会话的工作目录编码成 DSH 的目录名：冒号丢弃、分隔符换 -、空格与汉字转 ~XXXX。 */
  function encodeSessionDirName(cwd) {
    let out = ''
    for (const ch of String(cwd)) {
      if (ch === ':') continue
      if (ch === '\\' || ch === '/') {
        out += '-'
        continue
      }
      if (/[A-Za-z0-9._-]/.test(ch)) {
        out += ch
        continue
      }
      if (ch === ' ') {
        out += '~0020'
        continue
      }
      out += '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    }
    return `--${out}--`
  }

  /** zstd 帧长度：会话日志是多个帧拼接，改首行需要能定位每一帧。 */
  function zstdFrameLength(buffer, offset) {
    if (buffer.readUInt32LE(offset) !== 0xFD2FB528) throw new Error('会话日志不是 zstd 格式')
    let pointer = offset + 4
    const descriptor = buffer[pointer]
    pointer += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictFlag = descriptor & 3
    if (!singleSegment) pointer += 1
    pointer += [0, 1, 2, 4][dictFlag]
    pointer += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    for (;;) {
      const header = buffer[pointer] | (buffer[pointer + 1] << 8) | (buffer[pointer + 2] << 16)
      pointer += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >>> 3
      pointer += type === 1 ? 1 : size
      if (last) break
    }
    if (checksum) pointer += 4
    return pointer - offset
  }

  /** 解出会话日志的全部帧，按行拼成文本。 */
  function decodeSessionLog(buffer) {
    const chunks = []
    let offset = 0
    let frames = 0
    while (offset < buffer.length) {
      const length = zstdFrameLength(buffer, offset)
      chunks.push(zstdDecompressSync(buffer.subarray(offset, offset + length)))
      offset += length
      frames += 1
    }
    return { text: Buffer.concat(chunks).toString('utf8'), frames }
  }

  /** 会话 id → 日志目录。 */
  async function sessionDirsById() {
    const root = sessionsStoreRoot()
    const map = new Map()
    let projects = []
    try {
      projects = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return map
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      let entries = []
      try {
        entries = await fsp.readdir(join(root, project.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        map.set(entry.name, join(root, project.name, entry.name))
      }
    }
    return map
  }

  async function sessionMetaFromCache(id) {
    try {
      const raw = await fsp.readFile(join(sessionProjCacheRoot(), `${id}.json`), 'utf8')
      const parsed = JSON.parse(raw)
      const rows = parsed?.record?.rows ?? {}
      const titleCell = rows.title
      const title = titleCell && typeof titleCell === 'object' && typeof titleCell.val === 'string'
        ? titleCell.val
        : typeof titleCell === 'string'
          ? titleCell
          : ''
      const metaCell = rows.sessionListMetadata
      const metaVal = metaCell && typeof metaCell === 'object' && metaCell.val && typeof metaCell.val === 'object' ? metaCell.val : null
      const blank = metaVal && typeof metaVal.blank === 'boolean' ? metaVal.blank : null
      const lastPromptAt = metaVal && typeof metaVal.lastPromptAt === 'number' ? metaVal.lastPromptAt : null
      return { title, blank, lastPromptAt }
    } catch {
      return { title: '', blank: null, lastPromptAt: null }
    }
  }

  async function sessionPathRows() {
    const snapshots = await ctx.sessionPersistence.list()
    const dirs = await sessionDirsById()
    const workspaces = ctx.workspaceRegistry.list().map((workspace) => ({
      id: String(workspace.id),
      path: workspace.path,
      title: workspace.title,
    }))
    const liveId = process.env.DSH_SESSION_ID ? String(process.env.DSH_SESSION_ID) : null
    const archived = new Set((ctx.workspaceRegistry.archivedSessionIds ?? []).map(String))
    const rows = []
    for (const snapshot of snapshots) {
      const id = String(snapshot.header.id)
      // 空会话 / 目录已丢失的会话不展示：既占地方也容易误操作
      if (!dirs.has(id)) continue
      if (typeof snapshot.eventCount === 'number' && snapshot.eventCount === 0) continue
      // 子代理会话：侧栏不显示（属于父会话），这里也不列
      if (snapshot.header.origin === 'subagent' || snapshot.header.parentSession) continue
      // 已归档的会话不列
      if (archived.has(id)) continue
      const cwd = snapshot.header.cwd ? String(snapshot.header.cwd) : ''
      const meta = await sessionMetaFromCache(id)
      // 空会话（DSH 自己标记 blank）直接不展示
      if (meta.blank === true) continue
      rows.push({
        id,
        cwd,
        title: meta.title,
        createdAt: snapshot.header.createdAt ?? null,
        events: snapshot.eventCount ?? null,
        hasDir: dirs.has(id),
        live: liveId !== null && liveId === id,
        workspaceId: workspaces.find((workspace) => normalKey(workspace.path) === normalKey(cwd))?.id ?? null,
      })
    }
    rows.sort((a, b) => String(a.cwd).localeCompare(String(b.cwd)) || String(a.title).localeCompare(String(b.title)))
    // 按工作目录分组：界面按「项目/工作区」展示，支持整体更换或单条更换
    const groups = []
    const byCwd = new Map()
    for (const row of rows) {
      const key = normalKey(row.cwd)
      let group = byCwd.get(key)
      if (!group) {
        const workspace = workspaces.find((item) => normalKey(item.path) === key) || null
        group = {
          cwd: row.cwd,
          title: workspace ? workspace.title : row.cwd ? basename(row.cwd) : '',
          workspaceId: workspace ? workspace.id : null,
          sessions: [],
        }
        byCwd.set(key, group)
        groups.push(group)
      }
      group.sessions.push(row)
    }
    return { home: dshHome(), groups, sessions: rows, workspaces }
  }

  /** 若已有会话位于目标 cwd，复用它的目录名，避免编码差异导致同一 cwd 出现两个目录。 */
  async function sessionDirNameForCwd(cwd) {
    const snapshots = await ctx.sessionPersistence.list()
    const dirs = await sessionDirsById()
    for (const snapshot of snapshots) {
      if (normalKey(snapshot.header.cwd ?? '') !== normalKey(cwd)) continue
      const dir = dirs.get(String(snapshot.header.id))
      if (dir) return basename(dirname(dir))
    }
    return encodeSessionDirName(cwd)
  }

  function replaceStringsInJson(value, from, to) {
    if (typeof value === 'string') return value.split(from).join(to)
    if (Array.isArray(value)) return value.map((item) => replaceStringsInJson(item, from, to))
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, item] of Object.entries(value)) out[key] = replaceStringsInJson(item, from, to)
      return out
    }
    return value
  }

  async function moveSessionCwd(body) {
    const sessionId = String(body?.sessionId ?? '')
    const newCwdRaw = String(body?.newCwd ?? '').trim()
    const rewritePathRefs = body?.rewritePaths === true
    const skipWorkspace = body?.skipWorkspace === true
    if (!sessionId) throw new Error('缺少会话 id')
    if (!newCwdRaw) throw new Error('缺少新路径')
    const newCwd = resolve(newCwdRaw)
    if (!(await pathExists(newCwd))) throw new Error(`目标目录不存在：${newCwd}`)
    const targetStat = await fsp.stat(newCwd)
    if (!targetStat.isDirectory()) throw new Error(`目标不是目录：${newCwd}`)
    if (process.env.DSH_SESSION_ID && String(process.env.DSH_SESSION_ID) === sessionId) {
      throw new Error('不能修改当前正在使用的会话')
    }
    const snapshots = await ctx.sessionPersistence.list()
    const snapshot = snapshots.find((item) => String(item.header.id) === sessionId)
    if (!snapshot) throw new Error('找不到该会话')
    const oldCwd = snapshot.header.cwd ? String(snapshot.header.cwd) : ''
    if (!oldCwd) throw new Error('该会话没有记录工作目录')
    if (normalKey(oldCwd) === normalKey(newCwd)) throw new Error('新旧路径相同')
    const dirs = await sessionDirsById()
    const sourceDir = dirs.get(sessionId)
    if (!sourceDir) throw new Error('找不到会话日志目录（可能已被移走）')
    const logFile = join(sourceDir, 'session.v4.jsonl.zstd')
    if (!(await pathExists(logFile))) throw new Error('会话日志文件不存在')

    // 1) 备份（可逐字节回滚）
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(dshHome(), 'trash', `session-path-${stamp}`, sessionId)
    await fsp.mkdir(backupDir, { recursive: true })
    await fsp.copyFile(logFile, join(backupDir, 'session.v4.jsonl.zstd'))
    const cacheFile = join(sessionProjCacheRoot(), `${sessionId}.json`)
    const cacheExists = await pathExists(cacheFile)
    if (cacheExists) await fsp.copyFile(cacheFile, join(backupDir, 'projcache.json'))

    // 2) 改日志首行 header.cwd（可选：同时改写事件里的旧路径）
    const buffer = await fsp.readFile(logFile)
    const { text, frames } = decodeSessionLog(buffer)
    const lines = text.split('\n')
    const headerIndex = lines.findIndex((line) => line.trim().length > 0)
    if (headerIndex < 0) throw new Error('会话日志为空')
    const header = JSON.parse(lines[headerIndex])
    header.cwd = newCwd
    lines[headerIndex] = JSON.stringify(header)
    let rewritten = 0
    if (rewritePaths) {
      const stats = { count: 0 }
      const pairs = [{ from: oldCwd, to: newCwd, toStyle: styleOfPlatform(platform()) }]
      for (let index = 0; index < lines.length; index += 1) {
        if (index === headerIndex || !lines[index].trim()) continue
        let event
        try {
          event = JSON.parse(lines[index])
        } catch {
          continue
        }
        if (event && event.data && typeof event.data === 'object') {
          event.data = rewritePaths(event.data, pairs, stats)
          lines[index] = JSON.stringify(event)
        }
      }
      rewritten = stats.count
    }
    // DSH 要求「第一帧 = 且仅 = 一行 header」，其余事件另起帧；否则整条日志被判损坏、会话不再出现在列表里
    const headerText = lines[headerIndex].endsWith('\n') ? lines[headerIndex] : `${lines[headerIndex]}\n`
    const bodyLines = lines.slice(headerIndex + 1).filter((line) => line.trim().length > 0)
    const bodyText = bodyLines.length > 0 ? `${bodyLines.join('\n')}\n` : ''
    const firstFrame = zstdCompressSync(Buffer.from(headerText, 'utf8'))
    const restFrames = bodyText.length > 0 ? zstdCompressSync(Buffer.from(bodyText, 'utf8')) : Buffer.alloc(0)
    const tempFile = `${logFile}.tmp-${randomUUID()}`
    await fsp.writeFile(tempFile, Buffer.concat([firstFrame, restFrames]))
    await fsp.rename(tempFile, logFile)

    // 3) 移动日志目录到新的 encoded cwd 下
    const destDirName = encodeSessionDirName(newCwd)
    const destParent = join(sessionsStoreRoot(), destDirName)
    await fsp.mkdir(destParent, { recursive: true })
    const destDir = join(destParent, sessionId)
    let moved = false
    if (normalKey(destDir) !== normalKey(sourceDir)) {
      if (await pathExists(destDir)) throw new Error(`目标目录下已存在同名会话：${destDir}`)
      await fsp.rename(sourceDir, destDir)
      moved = true
    }

    // 4) 投影缓存里的 cwd 一起改
    let cachePatched = false
    if (cacheExists) {
      try {
        const raw = await fsp.readFile(cacheFile, 'utf8')
        const patched = replaceStringsInJson(JSON.parse(raw), oldCwd, newCwd)
        await fsp.writeFile(cacheFile, JSON.stringify(patched, null, 2))
        cachePatched = true
      } catch {
        /* 缓存改不动不影响会话本身 */
      }
    }

    // 5) 工作区归属：从旧路径的工作区摘掉，挂到新路径的工作区（若存在）
    let fromWorkspace = null
    let toWorkspace = null
    if (!skipWorkspace) try {
      const oldWorkspace = await ctx.workspaceRegistry.resolveByPath(oldCwd)
      const newWorkspace = await ctx.workspaceRegistry.resolveByPath(newCwd)
      if (oldWorkspace) {
        fromWorkspace = String(oldWorkspace.id)
        await oldWorkspace.detachSession(sessionId).catch(() => {})
      }
      if (newWorkspace) {
        toWorkspace = String(newWorkspace.id)
        await newWorkspace.attachSession(sessionId).catch(() => {})
      }
    } catch {
      /* 工作区归属是加分项，失败不报错 */
    }

    await recordMovedSessions(newCwd, [sessionId])
    return {
      ok: true,
      sessionId,
      oldCwd,
      newCwd,
      frames,
      rewritten,
      cachePatched,
      backupDir,
      dir: destDir,
      moved,
      fromWorkspace,
      toWorkspace,
      requiresRestart: true,
    }
  }

  function pathMoveJournalFile() {
    return join(dshHome(), 'storages', 'dsh-migrate-path-moves.json')
  }

  /** 记录被搬动的会话，供重启后重新挂到工作区（运行中宿主的工作区索引不会立刻更新）。 */
  async function recordMovedSessions(newCwd, sessionIds) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return
    try {
      const file = pathMoveJournalFile()
      let entries = []
      try {
        entries = JSON.parse(await fsp.readFile(file, 'utf8'))
      } catch {
        entries = []
      }
      entries.push({ at: new Date().toISOString(), newCwd, sessionIds: sessionIds.map(String) })
      await fsp.mkdir(dirname(file), { recursive: true })
      await fsp.writeFile(file, JSON.stringify(entries, null, 2))
    } catch {
      /* 记账失败不影响移动本身 */
    }
  }

  /**
   * 宿主启动后把 journal 里记录的会话重新挂到新路径的工作区。
   * 运行中改日志头不会刷新宿主的工作区索引，attachSession 会被拒绝；重启后索引重建，
   * 这里调用就能成功，会话也会重新出现在侧栏对应工作区里。
   */
  async function reconcileMovedSessions() {
    const file = pathMoveJournalFile()
    let entries = []
    try {
      entries = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      return
    }
    if (!Array.isArray(entries) || entries.length === 0) return
    const snapshots = await ctx.sessionPersistence.list()
    const byId = new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot]))
    const remaining = []
    let attached = 0
    for (const entry of entries) {
      const newCwd = String(entry.newCwd ?? '')
      const ids = (Array.isArray(entry.sessionIds) ? entry.sessionIds : []).filter((id) => byId.has(String(id)))
      if (!newCwd || ids.length === 0) continue
      let workspace = null
      try {
        workspace = await ctx.workspaceRegistry.resolveByPath(newCwd)
        if (!workspace) workspace = await ctx.workspaceRegistry.create(newCwd, basename(newCwd))
      } catch {
        workspace = null
      }
      if (!workspace) {
        remaining.push(entry)
        continue
      }
      for (const id of ids) {
        if (String(byId.get(String(id)).header.cwd ?? '') !== newCwd) continue
        try {
          await workspace.attachSession(id)
          attached += 1
        } catch {
          /* 留待下次启动再试 */
        }
      }
    }
    try {
      if (remaining.length === 0) await fsp.rm(file, { force: true })
      else await fsp.writeFile(file, JSON.stringify(remaining, null, 2))
    } catch {
      /* ignore */
    }
    if (attached > 0) ctx.logger?.info?.(`[dsh-migrate] 已把 ${attached} 个会话重新挂到新路径的工作区`)
    return { attached }
  }

  /**
   * 按 cwd 把「没挂在工作区上」的会话补挂回去。用于路径改过之后侧栏看不到会话的情况：
   * 工作区按路径匹配，会话日志头已指向新路径，但注册表里没登记 sessionIds。
   */
  async function reconcileAllWorkspaces() {
    const snapshots = await ctx.sessionPersistence.list()
    const workspaces = ctx.workspaceRegistry.list()
    const byPath = new Map(workspaces.map((workspace) => [normalKey(workspace.path), workspace]))
    let attached = 0
    let matched = 0
    const errors = []
    const touched = new Set()
    for (const snapshot of snapshots) {
      const id = String(snapshot.header.id)
      const cwd = snapshot.header.cwd ? String(snapshot.header.cwd) : ''
      if (!cwd) continue
      const workspace = byPath.get(normalKey(cwd))
      if (!workspace) continue
      matched += 1
      if ((workspace.sessionIds || []).some((existing) => String(existing) === id)) continue
      try {
        await workspace.attachSession(id)
        attached += 1
        touched.add(String(workspace.id))
      } catch (error) {
        if (errors.length < 3) errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { attached, matched, sessions: snapshots.length, workspaces: [...touched], errors }
  }
  /** 复制目录树（用于「换个路径」时把项目文件一起带过去）。 */
  async function copyTree(from, to) {
    const stats = { files: 0, bytes: 0 }
    const walk = async (source, target) => {
      await fsp.mkdir(target, { recursive: true })
      let entries = []
      try {
        entries = await fsp.readdir(source, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const src = join(source, entry.name)
        const dst = join(target, entry.name)
        if (entry.isDirectory()) {
          await walk(src, dst)
        } else if (entry.isFile()) {
          try {
            const info = await fsp.stat(src)
            await fsp.copyFile(src, dst)
            stats.files += 1
            stats.bytes += info.size
          } catch {
            /* 单个文件失败跳过 */
          }
        }
      }
    }
    await walk(from, to)
    return stats
  }
  /**
   * 把「离线修复」脚本和批处理摆到 ~/.dsh/storages 下，方便用户在 DSH 关闭后一键运行。
   * 运行中宿主不会刷新工作区登记表，只有关闭后改文件才生效。
   */
  async function ensureOfflineFixTool(force = false) {
    const dir = join(dshHome(), 'storages')
    const script = join(dir, 'dsh-migrate-fix-workspace.mjs')
    const bat = join(dir, 'dsh-migrate-fix-workspace.bat')
    try {
      await fsp.mkdir(dir, { recursive: true })
      const source = join(dirname(fileURLToPath(import.meta.url)), 'tools', 'fix-workspace-sessions.mjs')
      if (force || !(await pathExists(script))) {
        await fsp.copyFile(source, script)
      }
      if (force || !(await pathExists(bat))) {
        const lines = [
          '@echo off',
          'chcp 65001 >nul',
          'tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" | find /I "DeepSeek Harness.exe" >nul && (',
          '  echo 检测到 DSH 仍在运行，请先完全退出（含托盘）再运行本脚本。',
          '  pause',
          '  exit /b 1',
          ')',
          `"${process.execPath}" "${script}"`,
          'pause',
        ]
        await fsp.writeFile(bat, lines.join('\r\n'))
      }
      return { script, bat }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  async function moveWorkspaceCwd(body) {
    const fromCwd = resolve(String(body?.cwd ?? '').trim())
    const newCwdRaw = String(body?.newCwd ?? '').trim()
    const rewritePathRefs = body?.rewritePaths === true
    if (!fromCwd) throw new Error('缺少原工作目录')
    if (!newCwdRaw) throw new Error('缺少新路径')
    const newCwd = resolve(newCwdRaw)
    if (!(await pathExists(newCwd))) throw new Error(`目标目录不存在：${newCwd}`)
    const snapshots = await ctx.sessionPersistence.list()
    const targets = snapshots.filter((snapshot) => normalKey(snapshot.header.cwd ?? '') === normalKey(fromCwd))
    if (targets.length === 0) throw new Error('这个目录下没有会话')
    if (normalKey(fromCwd) === normalKey(newCwd)) throw new Error('新旧路径相同')
    const liveId = process.env.DSH_SESSION_ID ? String(process.env.DSH_SESSION_ID) : null
    if (liveId && targets.some((snapshot) => String(snapshot.header.id) === liveId)) {
      throw new Error('这个工作区包含当前正在使用的会话，不能整体更换')
    }
    const results = []
    let rewritten = 0
    for (const snapshot of targets) {
      const one = await moveSessionCwd({
        sessionId: String(snapshot.header.id),
        newCwd,
        rewritePaths: rewritePathRefs,
        skipWorkspace: true,
      })
      results.push(one)
      rewritten += one.rewritten || 0
    }
    // 可选：把项目文件一起带过去（默认由前端传入）
    let filesCopied = 0
    if (body?.moveFiles === true) {
      const copied = await copyTree(fromCwd, newCwd)
      filesCopied = copied.files
    }
    // 工作区登记：新路径建（或复用）一个工作区，把会话挂上去，再删掉旧登记
    let workspace = null
    try {
      const oldWorkspace = await ctx.workspaceRegistry.resolveByPath(fromCwd)
      const title = oldWorkspace ? oldWorkspace.title : basename(newCwd)
      const next = await ctx.workspaceRegistry.create(newCwd, title)
      for (const one of results) await next.attachSession(one.sessionId).catch(() => {})
      if (oldWorkspace && String(oldWorkspace.id) !== String(next.id)) {
        await ctx.workspaceRegistry.delete(oldWorkspace.id).catch(() => {})
      }
      workspace = { id: String(next.id), title: next.title, removed: oldWorkspace ? String(oldWorkspace.id) : null }
    } catch {
      /* 工作区登记失败不影响日志迁移 */
    }
    await recordMovedSessions(newCwd, results.map((one) => one.sessionId))
    return { ok: true, fromCwd, newCwd, sessions: results.length, rewritten, filesCopied, workspace, requiresRestart: true }
  }
  async function sessionPathHandler(req, res) {
    const auth = authenticate(req)
    if (auth.status) {
      const message =
        auth.reason === 'unavailable'
          ? '宿主未提供 connection 认证服务，已拒绝处理'
          : auth.status === 401
            ? '需要先在 Harness 中登录（缺少或无效的浏览器凭据）'
            : '拒绝跨站请求'
      sendJson(res, auth.status, { error: message })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(SESSION_PATH_PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && route === '/list') {
        const rows = await sessionPathRows()
        sendJson(res, 200, { ...rows, fixTool: await ensureOfflineFixTool() })
        return
      }
      if (req.method === 'POST' && route === '/make-fixer') {
        sendJson(res, 200, await ensureOfflineFixTool(true))
        return
      }
      if (req.method === 'POST' && route === '/apply') {
        sendJson(res, 200, await moveSessionCwd(await readJson(req)))
        return
      }
      if (req.method === 'POST' && route === '/workspace-apply') {
        sendJson(res, 200, await moveWorkspaceCwd(await readJson(req)))
        return
      }
      if (req.method === 'POST' && route === '/reconcile') {
        sendJson(res, 200, await reconcileAllWorkspaces())
        return
      }
      sendJson(res, 404, { error: '未知接口' })
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // ── HTTP surface ─────────────────────────────────────────────────────────

  function sendJson(res, status, value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  async function readJson(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1_000_000) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /**
   * 身份认证。宿主提供 `connection` 服务时必须用它：
   *   ctx.connection.admit({ headers }) 会校验浏览器签名凭据（或 API token），
   *   返回 `{}` 或 `{ rejection: 401 | 403 }`。
   * 没有该服务（老宿主）时退回 Origin 检查，并额外要求 Origin 存在——
   * 缺 Origin 的请求只可能来自非浏览器客户端。
   */
  /**
   * 身份认证。只认宿主的 `connection` 服务：
   *   ctx.connection.requestRejection({ headers }) —— 宿主自带的 Host/Origin 围栏
   *   + 浏览器签名凭据（login-token cookie）校验，被拒时返回 401/403。
   * 没有这个服务就**直接拒绝**：Origin/Host 只是请求头，客户端可以随便写，
   * 不能当身份凭据用。迁移、回滚、清理这类会写盘的操作宁可不可用，也不可无认证。
   */
  function authenticate(req) {
    const connection = ctx.get('connection')
    if (!connection) return { status: 503, reason: 'unavailable' }
    try {
      if (typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection({ headers: req.headers })
        return rejection ? { status: rejection } : {}
      }
      const admission = connection.admit({ headers: req.headers })
      if (admission && admission.rejection) return { status: admission.rejection }
      return {}
    } catch {
      return { status: 401 }
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // 会话路径是独立功能：命中它的前缀就交给自己的处理函数，与迁移路由互不干扰
    if (url.pathname === SESSION_PATH_PREFIX || url.pathname.startsWith(`${SESSION_PATH_PREFIX}/`)) {
      await sessionPathHandler(req, res)
      return
    }
    const auth = authenticate(req)
    if (auth.status) {
      const message =
        auth.reason === 'unavailable'
          ? '宿主未提供 connection 认证服务，已拒绝处理（不做无身份校验的迁移）'
          : auth.status === 401
            ? '需要先在 Harness 中登录（缺少或无效的浏览器凭据）'
            : '拒绝跨站请求'
      sendJson(res, auth.status, { error: message })
      return
    }
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && route === '/inventory') {
        sendJson(res, 200, await inventory())
        return
      }
      if (req.method === 'GET' && route === '/bundle-info') {
        sendJson(res, 200, await bundleInfo(url.searchParams.get('path')))
        return
      }
      if (req.method === 'GET' && route === '/scan') {
        sendJson(res, 200, await scanBundleDir(url.searchParams.get('dir')))
        return
      }
      if (req.method === 'GET' && route === '/preview') {
        sendJson(res, 200, await preview(url.searchParams.get('path')))
        return
      }
      if (req.method === 'GET' && route === '/check') {
        // The client sends the same rootDir/remap it will use for the import, so
        // the verdict here matches what the import will actually decide.
        let remap = {}
        try {
          const raw = url.searchParams.get('remap')
          if (raw) remap = JSON.parse(raw)
        } catch {
          remap = {}
        }
        sendJson(res, 200, await auditBundle(url.searchParams.get('path'), {
          rootDir: url.searchParams.get('rootDir') || null,
          remap,
        }))
        return
      }
      if (req.method === 'GET' && route === '/last-import') {
        sendJson(res, 200, { lastImport: await probeLastImport() })
        return
      }
      if (req.method === 'GET' && route === '/task') {
        sendJson(res, 200, taskView(url.searchParams.get('id')))
        return
      }
      if (req.method === 'POST' && route === '/export') {
        const body = await readJson(req)
        const task = startTask('export')
        const runner = Array.isArray(body.bundlePaths) && body.bundlePaths.length > 0 ? runUpdateMany : runExport
        runner(task, body).then((result) => succeed(task, result)).catch((error) => fail(task, error))
        sendJson(res, 200, { taskId: task.id })
        return
      }
      if (req.method === 'POST' && route === '/import') {
        const body = await readJson(req)
        const task = startTask('import')
        const runner = Array.isArray(body.bundlePaths) && body.bundlePaths.length > 0 ? runBatchImport : runImport
        runner(task, body).then((result) => succeed(task, result)).catch((error) => fail(task, error))
        sendJson(res, 200, { taskId: task.id })
        return
      }
      if (req.method === 'POST' && route === '/rollback') {
        sendJson(res, 200, await rollback(await readJson(req)))
        return
      }
      if (req.method === 'POST' && route === '/cleanup') {
        sendJson(res, 200, await cleanupWorkspaces(await readJson(req)))
        return
      }
      if (req.method === 'POST' && route === '/setup-workspace') {
        sendJson(res, 200, await setupWorkspace())
        return
      }
      sendJson(res, 404, { error: '未知接口' })
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  // 启动后把上次搬动过、但运行中没能挂上工作区的会话补挂一次（重启后索引已重建）
  ctx.effect(() => {
    // 启动时服务可能还没完全就绪：隔几秒重试几次，并把结果写到日志，便于排查
    const logFile = join(dshHome(), 'storages', 'dsh-migrate-reconcile.log')
    const writeLog = async (line) => {
      try {
        await fsp.mkdir(dirname(logFile), { recursive: true })
        await fsp.appendFile(logFile, `${new Date().toISOString()} ${line}\n`)
      } catch {
        /* ignore */
      }
    }
    const run = async (attempt) => {
      try {
        const moved = await reconcileMovedSessions()
        const all = await reconcileAllWorkspaces()
        await writeLog(`attempt ${attempt}: journal-attached=${moved?.attached ?? 0} workspace-attached=${all.attached} matched=${all.matched} sessions=${all.sessions} errors=${(all.errors || []).join(' | ') || 'none'}`)
        return all.attached
      } catch (error) {
        await writeLog(`attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`)
        return 0
      }
    }
    ;(async () => {
      for (const [index, delay] of [1500, 4000, 10000, 20000].entries()) {
        await new Promise((resolve) => setTimeout(resolve, delay))
        const attached = await run(index + 1)
        if (attached > 0 && index >= 1) break
      }
    })().catch(() => {})
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))
  // 会话路径是独立功能：单独的前缀与处理函数，handler 内部按前缀分派
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: SESSION_PATH_PREFIX, handler }))
  ctx.effect(() => () => {
    tasks.clear()
  })
}
