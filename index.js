import { promises as fsp } from 'node:fs'
import { join, resolve, basename, dirname, relative, isAbsolute } from 'node:path'
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
  async function probeLastImport() {
    const record = await readLastImport()
    if (!record) return null
    const counts = record.counts && typeof record.counts === 'object' ? record.counts : {}
    const changed = []
    const missing = []
    for (const [id, recorded] of Object.entries(counts)) {
      try {
        const handle = await ctx.sessionPersistence.open(id, 'read')
        try {
          const { events } = await handle.read()
          const current = Array.isArray(events) ? events.length : 0
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
      if (!entry.isDirectory()) continue
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
      codeVersion: 11,
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
        folder: workspace.folder ?? null,
        sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
        hasFiles: true,
      }))
    } catch {
      workspaces = []
    }
    const sizes = {}
    for (const workspace of workspaces) {
      const files = join(dir, 'files', workspace.folder ? String(workspace.folder) : safeName(workspace.id))
      sizes[workspace.id] = (await pathExists(files)) ? await dirSize(files) : 0
    }
    let plugins = null
    try {
      const doc = JSON.parse(await fsp.readFile(join(dir, 'plugins.json'), 'utf8'))
      plugins = {
        profile: doc.profile ?? null,
        list: Array.isArray(doc.plugins) ? doc.plugins : [],
      }
    } catch {
      plugins = null
    }
    return {
      path: dir,
      createdAt: manifest.createdAt ?? null,
      formatVersion: manifest.formatVersion ?? null,
      source: manifest.source ?? {},
      excludes: manifest.excludes ?? [],
      sessions: Array.isArray(manifest.sessions) ? manifest.sessions.length : 0,
      workspaces: workspaces.map((workspace) => ({ ...workspace, bytes: sizes[workspace.id] ?? 0 })),
      plugins,
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
    // The plugin list travels as its own file: it is informational only, and an
    // unreadable profile must never block the export. Users can leave it out or
    // narrow it down, because the list itself says which tools they run.
    let pluginsWritten = 0
    try {
      if (options.includePlugins !== false) {
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

    await rememberBundle(dir)
    return {
      path: dir,
      mode: updating ? 'update' : 'full',
      sessions: manifestSessions.length,
      sessionsReused,
      subagents: subagentSkipped,
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

  /** Render a session timestamp (seconds or milliseconds) as a local date. */
  function formatStamp(value) {
    const num = Number(value)
    if (!Number.isFinite(num) || num <= 0) return ''
    const date = new Date(num > 1e12 ? num : num * 1000)
    if (Number.isNaN(date.getTime())) return ''
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
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
  const SEQ_REF_KEYS = new Set(['throughSeq', 'headerSeq', 'messageSeqs', 'shadowedSeqs'])

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
   * Compare a local log with the bundled one by walking their common prefix.
   * identical  same content
   * packAhead  local is a strict prefix, so the bundle only adds
   * localAhead the bundle is a strict prefix, so this machine is newer
   * diverged   both changed, so neither side is safe to drop automatically
   */
  function compareEvents(local, pack) {
    const a = Array.isArray(local) ? local : []
    const b = Array.isArray(pack) ? pack : []
    const min = Math.min(a.length, b.length)
    let index = 0
    while (index < min) {
      if (JSON.stringify(a[index]) !== JSON.stringify(b[index])) return 'diverged'
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
  async function countBundlePlugins(dir) {
    try {
      const doc = JSON.parse(await fsp.readFile(join(dir, 'plugins.json'), 'utf8'))
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

  async function auditBundle(bundlePath) {
    if (!bundlePath) throw new Error('缺少迁移包路径')
    const dir = resolve(String(bundlePath))
    const manifest = await readManifest(dir)
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
        document = await loadSessionDocument(dir, meta)
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
        packEvents: Array.isArray(document.events) ? document.events.length : 0,
        localEvents: null,
        verdict: 'new',
      }
      if (localIds.has(id)) {
        try {
          const local = await readLocalSession(id)
          entry.localEvents = Array.isArray(local.events) ? local.events.length : 0
          entry.verdict = compareEvents(local.events, document.events)
        } catch {
          entry.verdict = 'unreadable'
        }
      }
      comparisons.push(entry)
    }
    const attachmentsInBundle = await pathExists(join(dir, 'attachments'))
    const pluginsInBundle = await countBundlePlugins(dir)
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

  async function runImport(task, options) {
    const dir = resolve(String(options.bundlePath ?? ''))
    if (!options.bundlePath) throw new Error('缺少迁移包路径')
    const manifest = await readManifest(dir)
    const workspaceDoc = JSON.parse(await fsp.readFile(join(dir, 'workspaces.json'), 'utf8'))
    const rootDir =
      options.rootDir && String(options.rootDir).trim() ? resolve(normalizeTargetPath(options.rootDir)) : null
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

    const decisions =
      options.sessionDecisions && typeof options.sessionDecisions === 'object' ? options.sessionDecisions : {}

    const newWorkspaceIds = []
    const newSessionIds = []
    const sessionCounts = {}
    const report = {
      path: dir,
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
        if (!preExisting.has(String(entity.id))) newWorkspaceIds.push(String(entity.id))
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
        const choice = String(decisions[sourceId] ?? 'skip')
        if (choice === 'append') {
          // The bundle only adds events, so extend the local log in place.
          try {
            const local = await readLocalSession(sourceId)
            const packDocument = await loadSessionDocument(dir, meta)
            const packEvents = Array.isArray(packDocument.events) ? packDocument.events : []
            const localCount = Array.isArray(local.events) ? local.events.length : 0
            if (packEvents.length > localCount) {
              const handle = await ctx.sessionPersistence.open(sourceId, 'write')
              try {
                await handle.append(packEvents.slice(localCount))
                await handle.flush()
              } finally {
                await handle.close()
              }
              report.sessionsAppended.push({ id: sourceId, added: packEvents.length - localCount })
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
          // A fork keeps both sides: the shared prefix is copied verbatim from
          // this machine, then the bundle's branch continues after the marker.
          try {
            const local = await readLocalSession(sourceId)
            const packDocument = await loadSessionDocument(dir, meta)
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
              const packDocument = await loadSessionDocument(dir, meta)
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
              const copyHandle = await ctx.sessionPersistence.create(copyHeader)
              try {
                if (copyEvents.length > 0) await copyHandle.append(copyEvents)
                await copyHandle.flush()
              } finally {
                await copyHandle.close()
              }
              report.sessionsCopied.push({ id: copyId, from: sourceId, reason })
              sessionCounts[copyId] = copyEvents.length
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
        const document = await loadSessionDocument(dir, meta)
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
        newSessionIds.push(id)
        sessionCounts[id] = events.length
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
        const source = join(dir, 'files', entry.source?.folder ? String(entry.source.folder) : safeName(entry.source.id))
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

    await writeLastImport({
      at: new Date().toISOString(),
      bundle: dir,
      workspaces: newWorkspaceIds,
      sessions: newSessionIds,
      counts: sessionCounts,
    })
    task.done += 1
    return report
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
      }      if (req.method === 'POST' && route === '/setup-workspace') {
        sendJson(res, 200, await setupWorkspace())
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
