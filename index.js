import { promises as fsp } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { homedir, hostname, platform } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * Host half of the migration plugin: exports the three durable layers of a
 * Harness install (workspace registry, session logs, project files) into one
 * portable folder, and replays that folder on another machine through the
 * public `sessionPersistence` / `workspaceRegistry` services.
 */

const ROUTE_PREFIX = '/api/dsh-migrate'
const BUNDLE_SCHEMA = 1
const BUNDLE_KIND = 'dsh-migration-bundle'
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
    return new Date().toISOString().replace('T', '-').replace(/:/g, '').slice(0, 15)
  }

  function normalKey(path) {
    const text = String(path)
    return process.platform === 'win32' ? text.toLowerCase().replace(/\//g, '\\') : text
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
        const variants = [
          [pair.from, pair.to],
          [String(pair.from).replace(/\\/g, '/'), String(pair.to).replace(/\\/g, '/')],
        ]
        for (const [from, to] of variants) {
          if (!from || from.length < 4) continue
          const pattern = new RegExp(escapeRegExp(from), 'gi')
          text = text.replace(pattern, () => {
            stats.count += 1
            return to
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

  async function listBundles() {
    const root = join(dshHome(), 'migrations')
    const bundles = []
    let entries
    try {
      entries = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return bundles
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name)
      try {
        const manifest = JSON.parse(await fsp.readFile(join(path, 'manifest.json'), 'utf8'))
        if (manifest.kind !== BUNDLE_KIND) continue
        bundles.push({
          path,
          name: entry.name,
          createdAt: manifest.createdAt ?? null,
          formatVersion: manifest.formatVersion ?? null,
          workspaces: Array.isArray(manifest.workspaces) ? manifest.workspaces.length : 0,
          sessions: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
          sourceHost: manifest.source?.host ?? null,
          bytes: manifest.bytes ?? null,
        })
      } catch {
        continue
      }
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
    return {
      home,
      migrationsDir: join(home, 'migrations'),
      codeVersion: 9,
      workspaces,
      sessions,
      archived: sets.archived,
      pinned: sets.pinned,
      hasAttachments: await pathExists(attachmentsRoot),
      bundles: await listBundles(),
      excludes: [...excludes],
    }
  }

  async function readManifest(dir) {
    const manifest = JSON.parse(await fsp.readFile(join(dir, 'manifest.json'), 'utf8'))
    if (manifest.kind !== BUNDLE_KIND) throw new Error('这不是迁移包：manifest.kind 不匹配')
    if (Number(manifest.schema) > BUNDLE_SCHEMA) throw new Error(`迁移包结构版本 ${manifest.schema} 高于插件支持的 ${BUNDLE_SCHEMA}`)
    return manifest
  }

  async function preview(bundlePath) {
    if (!bundlePath) throw new Error('缺少迁移包路径')
    const dir = resolve(String(bundlePath))
    const manifest = await readManifest(dir)
    let workspaces = []
    try {
      const doc = JSON.parse(await fsp.readFile(join(dir, 'workspaces.json'), 'utf8'))
      workspaces = (doc.workspaces ?? []).map((workspace) => ({
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
        hasFiles: true,
      }))
    } catch {
      workspaces = []
    }
    const sizes = {}
    for (const workspace of workspaces) {
      const files = join(dir, 'files', safeName(workspace.id))
      sizes[workspace.id] = (await pathExists(files)) ? await dirSize(files) : 0
    }
    return {
      path: dir,
      createdAt: manifest.createdAt ?? null,
      formatVersion: manifest.formatVersion ?? null,
      source: manifest.source ?? {},
      excludes: manifest.excludes ?? [],
      sessions: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
      workspaces: workspaces.map((workspace) => ({ ...workspace, bytes: sizes[workspace.id] ?? 0 })),
      attachments: await pathExists(join(dir, 'attachments')),
      bytes: manifest.bytes ?? null,
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

  // ── export ───────────────────────────────────────────────────────────────

  async function runExport(task, options) {
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
      dir = join(outRoot, `dsh-migration-${stamp()}`)
      await fsp.mkdir(join(dir, 'sessions'), { recursive: true })
    }

    task.message = '刷新会话日志…'
    await ctx.sessionPersistence.flush()

    const snapshots = await ctx.sessionPersistence.list()
    const snapshotById = new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot]))
    const allWorkspaces = ctx.workspaceRegistry.list()
    // An update keeps the bundle's own workspace set: re-selecting everything
    // would silently pull unrelated projects into a bundle meant for a subset.
    const selected =
      Array.isArray(options.workspaceIds) && options.workspaceIds.length > 0
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
    let bytes = 0
    let sessionsReused = 0

    const zstd = await loadZstd()
    for (const id of ordered) {
      const snapshot = snapshotById.get(id)
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

    const sets = await readRegistrySets(home)
    const workspaceDoc = {
      version: 1,
      order: selected.map((workspace) => String(workspace.id)),
      workspaces: selected.map((workspace) => ({
        id: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
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
      const dest = join(dir, 'files', safeName(workspace.id))
      const current = await walkFiles(source, excludes)
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
        await fsp.rm(join(dir, 'files', oldId), { recursive: true, force: true })
      }
    }

    let attachmentsBytes = 0
    const attachmentsRoot = join(home, 'attachments')
    if (options.includeAttachments && (await pathExists(attachmentsRoot))) {
      await fsp.cp(attachmentsRoot, join(dir, 'attachments'), { recursive: true, force: true })
      attachmentsBytes = await dirSize(join(dir, 'attachments'))
    }

    const filesBytes = await dirSize(join(dir, 'files'))
    // Ship this plugin itself so the target machine can install it without a
    // separate copy; the bundle is useless there without the same plugin.
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      await fsp.cp(here, join(dir, 'plugin', 'dsh-migrate'), {
        recursive: true,
        force: true,
        filter: (entry) => !normalKey(entry).includes('node_modules'),
      })
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
    await fsp.writeFile(
      join(dir, 'state.json'),
      JSON.stringify({ version: 1, createdAt: new Date().toISOString(), sessions: sessionState, files: filesState }),
    )
    task.done += 1

    return {
      path: dir,
      mode: updating ? 'update' : 'full',
      sessions: manifestSessions.length,
      sessionsReused,
      workspaces: workspaceDoc.workspaces.length,
      bytes: totalBytes,
      sessionBytes: bytes,
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

  async function loadSessionDocument(dir, meta) {
    const candidates = []
    if (meta.file) candidates.push(meta.file)
    candidates.push(`${safeName(meta.id)}.json.zst`, `${safeName(meta.id)}.json`)
    for (const name of candidates) {
      const full = join(dir, 'sessions', name)
      let buffer
      try {
        buffer = await fsp.readFile(full)
      } catch (error) {
        if (error && error.code === 'ENOENT') continue
        throw error
      }
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

  async function rollback(payload) {
    const workspaceIds = Array.isArray(payload.workspaceIds) ? payload.workspaceIds.map(String) : []
    const sessionIds = Array.isArray(payload.sessionIds) ? payload.sessionIds.map(String) : []
    const result = { workspaces: [], sessions: [] }
    for (const id of workspaceIds) {
      if (!createdWorkspaces.has(id)) {
        result.workspaces.push({ id, refused: '不是本次运行创建的项目，已拒绝删除' })
        continue
      }
      try {
        result.workspaces.push({ id, removed: await ctx.workspaceRegistry.delete(id) })
      } catch (error) {
        result.workspaces.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const root = join(dshHome(), 'sessions')
    for (const id of sessionIds) {
      if (!createdSessions.has(id)) {
        result.sessions.push({ id, refused: '不是本次运行导入的会话，已拒绝删除' })
        continue
      }
      try {
        result.sessions.push({ id, removed: await removeSessionDirs(root, id) })
      } catch (error) {
        result.sessions.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
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

  async function auditBundle(bundlePath) {
    if (!bundlePath) throw new Error('缺少迁移包路径')
    const dir = resolve(String(bundlePath))
    const manifest = await readManifest(dir)
    const problems = []
    let totalRefs = 0
    let totalMissing = 0
    let scanned = 0
    for (const meta of manifest.sessions ?? []) {
      let document
      try {
        document = await loadSessionDocument(dir, meta)
      } catch {
        continue
      }
      scanned += 1
      const result = auditDocument(document)
      totalRefs += result.refs
      totalMissing += result.missing
      if (result.missing > 0) {
        problems.push({
          id: String(meta.id),
          cwd: meta.cwd ?? null,
          refs: result.refs,
          missing: result.missing,
          missingIds: result.missingIds,
        })
      }
    }
    const attachmentsInBundle = await pathExists(join(dir, 'attachments'))
    return {
      path: dir,
      sessions: (manifest.sessions ?? []).length,
      scanned,
      attachmentsInBundle,
      attachmentService: Boolean(ctx.get('attachments')),
      totalRefs,
      totalMissing,
      problems,
      advice:
        totalMissing === 0
          ? null
          : attachmentsInBundle
            ? '包内带了 attachments 目录：勾选「包含图片附件」会把它们装到本机；导入后仍提示缺失，说明该附件在旧机器上就已经不在了。'
            : '包内没有附件。把旧机器的 ~/.dsh/attachments 整个拷到新机器同名位置，或重新导出并勾选附件。',
    }
  }

  async function runImport(task, options) {
    const dir = resolve(String(options.bundlePath ?? ''))
    if (!options.bundlePath) throw new Error('缺少迁移包路径')
    const manifest = await readManifest(dir)
    const workspaceDoc = JSON.parse(await fsp.readFile(join(dir, 'workspaces.json'), 'utf8'))
    const rootDir = options.rootDir && String(options.rootDir).trim() ? resolve(String(options.rootDir)) : null
    const remapInput = options.remap && typeof options.remap === 'object' ? options.remap : {}

    // Resolve one target directory per bundled project: an explicit per-project
    // mapping wins, then <rootDir>/<project title>, then the original path.
    const targets = []
    const usedTargets = new Set()
    for (const workspace of workspaceDoc.workspaces ?? []) {
      const explicit = Object.prototype.hasOwnProperty.call(remapInput, workspace.path)
        ? String(remapInput[workspace.path] ?? '').trim()
        : ''
      let target
      if (explicit) {
        target = resolve(explicit)
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

    const pairs = []
    for (const entry of targets) {
      if (entry.source.path === entry.target) continue
      pairs.push({ from: entry.source.path, to: entry.target })
    }
    for (const [from, to] of Object.entries(remapInput)) {
      if (!from || !to || String(from).trim() === String(to).trim()) continue
      if (targets.some((entry) => normalKey(entry.source.path) === normalKey(from))) continue
      pairs.push({ from: String(from), to: String(to) })
    }
    pairs.sort((a, b) => normalKey(b.from).length - normalKey(a.from).length)

    const report = {
      path: dir,
      rootDir,
      workspaces: [],
      sessionsImported: 0,
      importedSessions: [],
      sessionsSkipped: [],
      flattened: 0,
      ungrouped: 0,
      rewritten: 0,
      missingAttachments: 0,
      attachmentGaps: [],
      filesCopied: 0,
      fileSkips: [],
      attachments: false,
      warnings: [],
    }
    const willInstallAttachments = Boolean(options.includeAttachments) && (await pathExists(join(dir, 'attachments')))

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
        report.workspaces.push({ id: String(entity.id), path: entry.target, title: entity.title, from: entry.source.path })
      } catch (error) {
        report.warnings.push(
          `项目「${entry.source.title}」创建失败：${error instanceof Error ? error.message : String(error)}`,
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
      const id = String(meta.id)
      if (existing.has(id)) {
        report.sessionsSkipped.push({ id, reason: '本机已存在同名会话' })
        task.done += 1
        continue
      }
      try {
        const document = await loadSessionDocument(dir, meta)
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
        }

        if (header.isSeeded) {
          const inherited = Number(document.inheritedEventCount ?? 0)
          const parentId = header.parentSession ? String(header.parentSession) : null
          const parentMeta = parentId ? (manifest.sessions ?? []).find((entry) => String(entry.id) === parentId) : null
          if (!parentMeta || inherited <= 0) {
            report.sessionsSkipped.push({ id, reason: 'fork 会话缺少父会话种子，已跳过' })
            task.done += 1
            continue
          }
          const parentDocument = await loadSessionDocument(dir, parentMeta)
          const parentEvents = Array.isArray(parentDocument.events) ? parentDocument.events : []
          if (parentEvents.length < inherited) {
            report.sessionsSkipped.push({ id, reason: 'fork 会话的父会话事件不足，已跳过' })
            task.done += 1
            continue
          }
          events = [...parentEvents.slice(0, inherited), ...events]
          header = { ...header, isSeeded: false, parentSession: undefined, origin: undefined, delegationDepth: undefined }
          report.flattened += 1
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
        report.sessionsImported += 1
        report.importedSessions.push(id)

        const match = created.find((entry) => normalKey(header.cwd ?? '') === normalKey(entry.target))
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
      for (const entry of created) {
        const source = join(dir, 'files', safeName(entry.source.id))
        if (!(await pathExists(source))) continue
        try {
          const items = await fsp.readdir(entry.target)
          if (items.length > 0 && !options.overwriteFiles) {
            report.fileSkips.push({ path: entry.target, reason: '目标目录非空，已跳过文件复制' })
            continue
          }
          await fsp.cp(source, entry.target, { recursive: true, force: true })
          report.filesCopied += 1
        } catch (error) {
          report.warnings.push(`复制项目文件失败：${entry.target}（${error instanceof Error ? error.message : String(error)}）`)
        }
      }
    }

    if (options.includeAttachments && (await pathExists(join(dir, 'attachments')))) {
      try {
        await fsp.cp(join(dir, 'attachments'), join(dshHome(), 'attachments'), { recursive: true, force: true })
        report.attachments = true
      } catch (error) {
        report.warnings.push(`复制附件失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    task.done += 1
    return report
  }

  // ── HTTP surface ─────────────────────────────────────────────────────────

  function sendJson(res, status, value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  function sameOrigin(req) {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
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

  async function handler(req, res) {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: '拒绝跨站请求' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && route === '/inventory') {
        sendJson(res, 200, await inventory())
        return
      }
      if (req.method === 'GET' && route === '/preview') {
        sendJson(res, 200, await preview(url.searchParams.get('path')))
        return
      }
      if (req.method === 'GET' && route === '/check') {
        sendJson(res, 200, await auditBundle(url.searchParams.get('path')))
        return
      }
      if (req.method === 'GET' && route === '/task') {
        sendJson(res, 200, taskView(url.searchParams.get('id')))
        return
      }
      if (req.method === 'POST' && route === '/export') {
        const body = await readJson(req)
        const task = startTask('export')
        runExport(task, body).then((result) => succeed(task, result)).catch((error) => fail(task, error))
        sendJson(res, 200, { taskId: task.id })
        return
      }
      if (req.method === 'POST' && route === '/import') {
        const body = await readJson(req)
        const task = startTask('import')
        runImport(task, body).then((result) => succeed(task, result)).catch((error) => fail(task, error))
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
      sendJson(res, 404, { error: '未知接口' })
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))
  ctx.effect(() => () => {
    tasks.clear()
  })
}
