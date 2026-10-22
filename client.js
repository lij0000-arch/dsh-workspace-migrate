window.__ModuleLoader__.load({
  id: 'dsh-workspace-migrate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const NS = 'dsh-migrate'
    const API = '/api/dsh-migrate'

    const ZH = {
      title: '迁移到另一台电脑',
      subtitle: '把工作区、项目成果和对话内容打包带走，在新电脑上还原。导出在旧电脑做，导入在新电脑做。',
      tabExport: '导出（旧电脑）',
      tabImport: '导入（新电脑）',
      projects: '工作区',
      projectsHint: '选中的工作区会连同归属的会话一起打包；子会话会自动带上。',
      selectAll: '全选',
      selectNone: '清空',
      sessionCount: '个会话',
      files: '同时打包项目文件',
      filesHint: '排除 node_modules、.git 等可重建目录。',
      attachments: '同时打包图片附件',
      outDir: '导出位置',
      outDirHint: '留空则用 ~/.dsh/migrations。',
      startExport: '开始导出',
      exportRunning: '正在导出…',
      exportDone: '导出完成',
      exportFailed: '导出失败',
      bundlePath: '迁移包路径',
      loadPreview: '读取迁移包',
      recent: '最近导出',
      preview: '迁移包内容',
      source: '来源',
      createdAt: '创建时间',
      formatVersion: '日志格式',
      sessions: '会话',
      remap: '路径映射',
      remapHint: '新电脑没有同样的盘符或目录时，填新的目标路径；目录不存在会自动创建。',
      from: '原路径',
      to: '新路径',
      importFiles: '导入项目文件',
      overwrite: '目标目录非空时仍覆盖',
      startImport: '开始导入',
      importRunning: '正在导入…',
      importDone: '导入完成',
      importFailed: '导入失败',
      report: '结果',
      imported: '已导入会话',
      skipped: '跳过',
      flattened: '展开的 fork 会话',
      warnings: '提醒',
      undo: '撤销这次导入',
      undoConfirm: '将删除本次导入创建的项目登记和会话文件，确定吗？',
      undone: '已撤销本次导入',
      refused: '拒绝',
      update: '增量更新已有迁移包',
      updateHint: '只复制新增或修改过的文件，未变化的文件与会话直接复用。适合同一个包反复同步。',
      updateNow: '开始增量更新',
      reused: '复用会话',
      copied: '复制文件',
      unchanged: '未变',
      removed: '已删除',
      importRoot: '导入到（新根目录）',
      importRootHint: '每个项目自动建在「根目录 \\ 项目名」下；下面每一行仍可单独改。',
      rewritePaths: '重写对话里提到的旧路径',
      rewritePathsHint: '工具调用与结果中的旧绝对路径会换成新路径，续聊时模型才找得到文件。',
      rewrittenPaths: '重写路径',
      ungrouped: '未归属项目的会话',
      cleaned: '已清理失效项目',
      cleanup: '清理失效项目',
      checkup: '导入前体检',
      checkupRunning: '正在检查…',
      refs: '附件引用',
      missingRefs: '缺失',
      attachmentAdvice: '建议',
      missingAttachments: '缺失附件的会话',
      noBundles: '还没有迁移包。先在旧电脑上导出。',
      loading: '加载中…',
      empty: '没有数据',
      bytes: '大小',
      close: '关闭',
    }
    const EN = {
      title: 'Migrate to another computer',
      subtitle: 'Package workspaces, project files, and conversations, then restore them on the new machine. Export on the old computer, import on the new one.',
      tabExport: 'Export (old computer)',
      tabImport: 'Import (new computer)',
      projects: 'Workspaces',
      projectsHint: 'Selected workspaces carry their sessions; sub-sessions are included automatically.',
      selectAll: 'All',
      selectNone: 'None',
      sessionCount: 'sessions',
      files: 'Include project files',
      filesHint: 'Skips rebuildable directories such as node_modules and .git.',
      attachments: 'Include image attachments',
      outDir: 'Export location',
      outDirHint: 'Empty uses ~/.dsh/migrations.',
      startExport: 'Start export',
      exportRunning: 'Exporting…',
      exportDone: 'Export finished',
      exportFailed: 'Export failed',
      bundlePath: 'Bundle path',
      loadPreview: 'Read bundle',
      recent: 'Recent exports',
      preview: 'Bundle contents',
      source: 'Source',
      createdAt: 'Created',
      formatVersion: 'Log format',
      sessions: 'Sessions',
      remap: 'Path mapping',
      remapHint: 'When the new machine lacks the same drive or folder, enter the target path; missing folders are created.',
      from: 'From',
      to: 'To',
      importFiles: 'Import project files',
      overwrite: 'Overwrite when the target folder is not empty',
      startImport: 'Start import',
      importRunning: 'Importing…',
      importDone: 'Import finished',
      importFailed: 'Import failed',
      report: 'Result',
      imported: 'Sessions imported',
      skipped: 'Skipped',
      flattened: 'Flattened forks',
      warnings: 'Notes',
      undo: 'Undo this import',
      undoConfirm: 'This deletes the workspace registrations and session files created by this import. Continue?',
      undone: 'Import undone',
      refused: 'refused',
      update: 'Update an existing bundle',
      updateHint: 'Copies only added or changed files and reuses unchanged sessions, so repeated syncs stay cheap.',
      updateNow: 'Start incremental update',
      reused: 'sessions reused',
      copied: 'files copied',
      unchanged: 'unchanged',
      removed: 'removed',
      importRoot: 'Import into (new root)',
      importRootHint: 'Each project is created at <root> / <project name>; every row below can still be edited.',
      rewritePaths: 'Rewrite old paths mentioned in conversations',
      rewritePathsHint: 'Absolute paths inside tool calls and results are replaced with the new ones, so a resumed conversation finds its files.',
      rewrittenPaths: 'paths rewritten',
      ungrouped: 'sessions not attached to a project',
      cleaned: 'stale projects removed',
      cleanup: 'Clean up stale projects',
      checkup: 'Pre-flight check',
      checkupRunning: 'Checking…',
      refs: 'attachment refs',
      missingRefs: 'missing',
      attachmentAdvice: 'Advice',
      missingAttachments: 'sessions with missing attachments',
      noBundles: 'No bundle yet. Export on the old computer first.',
      loading: 'Loading…',
      empty: 'Nothing here',
      bytes: 'Size',
      close: 'Close',
    }

    const C = {
      page: { padding: '26px 30px 48px', maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 18 },
      h1: { margin: 0, fontSize: 19, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      sub: { margin: '6px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      tabs: { display: 'flex', gap: 6, borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      tab: {
        appearance: 'none', border: 'none', background: 'transparent', cursor: 'pointer',
        padding: '9px 12px', fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)',
        borderBottom: '2px solid transparent', marginBottom: -1,
      },
      tabActive: { color: 'var(--dsw-alias-label-primary)', borderBottomColor: 'var(--dsw-alias-brand-primary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12,
      },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      cardTitle: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
      row: {
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      rowText: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 },
      rowTitle: { fontSize: 13, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      badge: {
        fontSize: 11, padding: '1px 7px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: 12.5,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, outline: 'none',
      },
      button: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8,
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        padding: '7px 13px', fontSize: 12.5, cursor: 'pointer',
      },
      primary: {
        appearance: 'none', border: 'none', borderRadius: 8, background: 'var(--dsw-alias-brand-primary)',
        color: '#fff', padding: '8px 16px', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
      },
      primaryOff: { opacity: 0.5, cursor: 'default' },
      label: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      bar: { height: 4, borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' },
      barFill: { height: '100%', background: 'var(--dsw-alias-brand-primary)', transition: 'width .25s ease' },
      warn: { fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-state-warn-primary)' },
      error: { fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-state-error-primary)' },
      ok: { fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-state-success-primary)' },
      kv: { display: 'flex', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      kvKey: { minWidth: 72, color: 'var(--dsw-alias-label-secondary)' },
      kvVal: { color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' },
    }

    function fmtBytes(n) {
      if (!n || n < 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let value = n
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
    }

    function fmtTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    async function request(path, options) {
      const response = await fetch(API + path, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      return payload
    }

    const api = {
      get: (path) => request(path, { headers: { accept: 'application/json' } }),
      post: (path, body) =>
        request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }),
    }

    function Checkbox(props) {
      return h('input', {
        type: 'checkbox',
        checked: Boolean(props.checked),
        disabled: Boolean(props.disabled),
        onChange: (event) => props.onChange(event.target.checked),
        style: { marginTop: 2, accentColor: 'var(--dsw-alias-brand-primary)' },
      })
    }

    function Kv(props) {
      return h(
        'div',
        { style: C.kv },
        h('span', { style: C.kvKey }, props.label),
        h('span', { style: C.kvVal }, props.value),
      )
    }

    function Progress(props) {
      const task = props.task
      if (!task) return null
      const total = Number(task.total) || 0
      const done = Number(task.done) || 0
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : task.phase === 'done' ? 100 : 8
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
        h('div', { style: C.bar }, h('div', { style: { ...C.barFill, width: `${percent}%` } })),
        h(
          'div',
          { style: task.phase === 'failed' ? C.error : C.hint },
          task.phase === 'failed' ? task.error || task.message : task.message || '',
        ),
      )
    }

    function TaskResult(props) {
      const { t, task, kind } = props
      if (!task || task.phase !== 'done' || !task.result) return null
      const result = task.result
      if (kind === 'export') {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          h('div', { style: C.ok }, `${t('exportDone')} · ${result.sessions} ${t('sessions')} · ${fmtBytes(result.bytes)}`),
          result.mode === 'update'
            ? h(
                'div',
                { style: C.hint },
                `${t('reused')} ${result.sessionsReused} · ${t('copied')} ${result.filesCopied} (${fmtBytes(result.bytesCopied)}) · ${t('unchanged')} ${result.filesUnchanged} · ${t('removed')} ${result.filesRemoved}`,
              )
            : null,
          h('div', { style: C.mono }, result.path),
          (result.warnings || []).length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                ...result.warnings.map((text, index) => h('div', { key: index, style: C.warn }, `• ${text}`)),
              )
            : null,
        )
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: C.ok }, `${t('importDone')} · ${t('imported')} ${result.sessionsImported} · ${t('skipped')} ${result.sessionsSkipped.length}`),
        result.flattened > 0 ? h('div', { style: C.hint }, `${t('flattened')}: ${result.flattened}`) : null,
        result.rewritten > 0 ? h('div', { style: C.hint }, `${t('rewrittenPaths')}: ${result.rewritten}`) : null,
        result.missingAttachments > 0
          ? h('div', { style: C.warn }, `${t('missingAttachments')}: ${result.missingAttachments}`)
          : null,
        result.ungrouped > 0 ? h('div', { style: C.warn }, `${t('ungrouped')}: ${result.ungrouped}`) : null,
        result.warnings.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              ...result.warnings.map((text, index) => h('div', { key: index, style: C.warn }, `• ${text}`)),
            )
          : null,
        result.sessionsSkipped.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 180, overflowY: 'auto' } },
              ...result.sessionsSkipped.map((item, index) =>
                h('div', { key: index, style: C.hint }, `• ${item.id} — ${item.reason}`),
              ),
            )
          : null,
      )
    }

    function usePolling(t) {
      const [taskId, setTaskId] = useState(null)
      const [task, setTask] = useState(null)
      const [error, setError] = useState(null)

      useEffect(() => {
        if (!taskId) return undefined
        let stopped = false
        let timer = null
        const tick = async () => {
          try {
            const value = await api.get(`/task?id=${encodeURIComponent(taskId)}`)
            if (stopped) return
            if (value && value.error) {
              setError(value.error)
              setTask({ phase: 'failed', error: value.error, message: value.error, done: 0, total: 0 })
              return
            }
            setTask(value)
            if (value.phase === 'running') timer = setTimeout(tick, 450)
          } catch (cause) {
            if (!stopped) {
              const message = cause instanceof Error ? cause.message : String(cause)
              setError(message)
              setTask({ phase: 'failed', error: message, message, done: 0, total: 0 })
            }
          }
        }
        timer = setTimeout(tick, 250)
        return () => {
          stopped = true
          if (timer) clearTimeout(timer)
        }
      }, [taskId])

      const run = useCallback(async (kind, body) => {
        setError(null)
        setTask({ phase: 'running', message: t(kind === 'export' ? 'exportRunning' : 'importRunning'), done: 0, total: 0 })
        try {
          const started = await api.post(`/${kind}`, body)
          setTaskId(started.taskId)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(message)
          setTask({ phase: 'failed', error: message, message, done: 0, total: 0 })
        }
      }, [t])

      return { task, error, run }
    }

    function ExportPane(props) {
      const { t, inventory, reload } = props
      const [selected, setSelected] = useState(null)
      const [includeFiles, setIncludeFiles] = useState(true)
      const [includeAttachments, setIncludeAttachments] = useState(true)
      const [outDir, setOutDir] = useState('')
      const [updateTarget, setUpdateTarget] = useState('')
      const [cleanupNote, setCleanupNote] = useState(null)
      const { task, run } = usePolling(t)

      const workspaces = inventory ? inventory.workspaces : []
      const bundles = inventory && inventory.bundles ? inventory.bundles : []
      const active = selected === null ? new Set(workspaces.map((workspace) => workspace.id)) : selected

      useEffect(() => {
        if (!updateTarget && bundles.length > 0) setUpdateTarget(bundles[0].path)
      }, [bundles, updateTarget])

      const toggle = (id) => {
        const next = new Set(active)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setSelected(next)
      }

      const cleanup = async () => {
        try {
          const result = await api.post('/cleanup', {})
          const removed = (result.removed || []).filter((entry) => entry.removed).length
          setCleanupNote(`${t('cleaned')} ${removed}`)
          reload()
        } catch (error) {
          setCleanupNote(error instanceof Error ? error.message : String(error))
        }
      }

      const running = task && task.phase === 'running'

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(
          'div',
          { style: C.card },
          h(
            'div',
            { style: C.cardHead },
            h('div', { style: C.cardTitle }, t('projects')),
            h(
              'div',
              { style: { display: 'flex', gap: 6 } },
              h('button', { style: C.button, onClick: () => setSelected(new Set(workspaces.map((w) => w.id))) }, t('selectAll')),
              h('button', { style: C.button, onClick: () => setSelected(new Set()) }, t('selectNone')),
              h('button', { style: C.button, onClick: cleanup }, t('cleanup')),
            ),
          ),
          h('div', { style: C.hint }, t('projectsHint')),
          cleanupNote ? h('div', { style: C.hint }, cleanupNote) : null,
          workspaces.length === 0
            ? h('div', { style: C.hint }, t('empty'))
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column' } },
                ...workspaces.map((workspace) =>
                  h(
                    'div',
                    { key: workspace.id, style: C.row },
                    h(Checkbox, { checked: active.has(workspace.id), onChange: () => toggle(workspace.id) }),
                    h(
                      'div',
                      { style: C.rowText },
                      h('div', { style: C.rowTitle }, workspace.title),
                      h('div', { style: C.mono, title: workspace.path }, workspace.path),
                    ),
                    h('span', { style: C.badge }, `${workspace.sessionIds.length} ${t('sessionCount')}`),
                  ),
                ),
              ),
        ),
        h(
          'div',
          { style: C.card },
          h('label', { style: C.label }, h(Checkbox, { checked: includeFiles, onChange: setIncludeFiles }), t('files')),
          h('div', { style: C.hint }, t('filesHint')),
          h('label', { style: C.label }, h(Checkbox, { checked: includeAttachments, onChange: setIncludeAttachments }), t('attachments')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            h('div', { style: C.hint }, t('outDir')),
            h('input', {
              style: C.input,
              value: outDir,
              placeholder: inventory ? inventory.migrationsDir : '',
              onChange: (event) => setOutDir(event.target.value),
              spellCheck: false,
            }),
            h('div', { style: C.hint }, t('outDirHint')),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h(
              'button',
              {
                style: running || active.size === 0 ? { ...C.primary, ...C.primaryOff } : C.primary,
                disabled: running || active.size === 0,
                onClick: () =>
                  run('export', {
                    workspaceIds: [...active],
                    includeFiles,
                    includeAttachments,
                    outDir: outDir.trim() || null,
                  }),
              },
              running ? t('exportRunning') : t('startExport'),
            ),
          ),
          bundles.length > 0
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 7,
                    borderTop: '1px solid var(--dsw-alias-border-l1)',
                    paddingTop: 11,
                  },
                },
                h('div', { style: C.cardTitle }, t('update')),
                h('div', { style: C.hint }, t('updateHint')),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  bundles.length > 0
                    ? h(
                        'select',
                        {
                          style: { ...C.input, flex: 1 },
                          value: updateTarget,
                          onChange: (event) => setUpdateTarget(event.target.value),
                        },
                        ...bundles.map((bundle) =>
                          h(
                            'option',
                            { key: bundle.path, value: bundle.path },
                            `${bundle.name} · ${bundle.sessions} ${t('sessions')}`,
                          ),
                        ),
                      )
                    : null,
                  h(
                    'button',
                    {
                      style: running ? { ...C.button, ...C.primaryOff } : C.button,
                      disabled: running || !updateTarget,
                      onClick: () =>
                        run('export', {
                          mode: 'update',
                          bundlePath: updateTarget,
                          includeFiles,
                          includeAttachments,
                        }),
                    },
                    t('updateNow'),
                  ),
                ),
                h('input', {
                  style: C.input,
                  value: updateTarget,
                  placeholder: 'D:\\path\\to\\dsh-migration-…',
                  onChange: (event) => setUpdateTarget(event.target.value),
                  spellCheck: false,
                }),
              )
            : null,
          h(Progress, { task }),
          h(TaskResult, { t, task, kind: 'export' }),
        ),
        task && task.phase === 'done' && task.result
          ? h('button', { style: C.button, onClick: reload }, '刷新列表')
          : null,
      )
    }

    function ImportPane(props) {
      const { t, inventory, reload } = props
      const bundles = inventory ? inventory.bundles : []
      const [bundlePath, setBundlePath] = useState('')
      const [preview, setPreview] = useState(null)
      const [remap, setRemap] = useState({})
      const [includeFiles, setIncludeFiles] = useState(true)
      const [includeAttachments, setIncludeAttachments] = useState(true)
      const [overwriteFiles, setOverwriteFiles] = useState(false)
      const [rootDir, setRootDir] = useState('')
      const [rewritePaths, setRewritePaths] = useState(true)
      const [check, setCheck] = useState(null)
      const [checking, setChecking] = useState(false)
      const [loadError, setLoadError] = useState(null)
      const [undoNote, setUndoNote] = useState(null)
      const { task, run } = usePolling(t)
      const running = task && task.phase === 'running'

      const undo = async (result) => {
        if (!window.confirm(t('undoConfirm'))) return
        try {
          const report = await api.post('/rollback', {
            workspaceIds: (result.workspaces || []).map((workspace) => workspace.id),
            sessionIds: result.importedSessions || [],
          })
          const entries = [...(report.workspaces || []), ...(report.sessions || [])]
          const removed = entries.filter((entry) => entry.removed).length
          const refused = entries.filter((entry) => entry.refused).length
          setUndoNote(`${t('undone')} ${removed}${refused > 0 ? ` · ${t('refused')} ${refused}` : ''}`)
          reload()
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }

      useEffect(() => {
        if (!bundlePath && bundles.length > 0) setBundlePath(bundles[0].path)
      }, [bundles, bundlePath])

      const applyRoot = (value) => {
        setRootDir(value)
        if (!preview) return
        const base = value.trim().replace(/[\\/]+$/, '')
        const next = { ...remap }
        for (const workspace of preview.workspaces || []) {
          next[workspace.path] = base
            ? `${base}\\${String(workspace.title || workspace.path).replace(/[\\/:*?"<>|]/g, ' ').trim()}`
            : workspace.path
        }
        setRemap(next)
      }

      const runCheck = async () => {
        if (!bundlePath) return
        setChecking(true)
        setCheck(null)
        try {
          setCheck(await api.get(`/check?path=${encodeURIComponent(bundlePath)}`))
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        } finally {
          setChecking(false)
        }
      }

      const load = async (path) => {
        setCheck(null)
        setLoadError(null)
        setPreview(null)
        try {
          const value = await api.get(`/preview?path=${encodeURIComponent(path)}`)
          setPreview(value)
          const next = {}
          for (const workspace of value.workspaces || []) next[workspace.path] = workspace.path
          setRemap(next)
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(
          'div',
          { style: C.card },
          h('div', { style: C.cardTitle }, t('bundlePath')),
          bundles.length > 0
            ? h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h(
                  'select',
                  {
                    style: { ...C.input, flex: 1 },
                    value: bundlePath,
                    onChange: (event) => setBundlePath(event.target.value),
                  },
                  ...bundles.map((bundle) =>
                    h('option', { key: bundle.path, value: bundle.path },
                      `${bundle.name} · ${bundle.sessions} ${t('sessions')} · ${fmtBytes(bundle.bytes || 0)}`),
                  ),
                ),
                h('button', { style: C.button, onClick: () => load(bundlePath) }, t('loadPreview')),
              )
            : h('div', { style: C.hint }, t('noBundles')),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('input', {
              style: C.input,
              value: bundlePath,
              placeholder: 'D:\\path\\to\\dsh-migration-…',
              onChange: (event) => setBundlePath(event.target.value),
              spellCheck: false,
            }),
            h('button', { style: C.button, onClick: () => bundlePath && load(bundlePath) }, t('loadPreview')),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(
              'button',
              {
                style: checking ? { ...C.button, ...C.primaryOff } : C.button,
                disabled: checking || !bundlePath,
                onClick: runCheck,
              },
              checking ? t('checkupRunning') : t('checkup'),
            ),
            check
              ? h(
                  'span',
                  { style: check.totalMissing === 0 ? C.ok : C.warn },
                  `${check.sessions} ${t('sessions')} · ${check.totalRefs} ${t('refs')} · ${check.totalMissing} ${t('missingRefs')}`,
                )
              : null,
          ),
          check && check.advice ? h('div', { style: C.warn }, `${t('attachmentAdvice')}: ${check.advice}`) : null,
          check && check.problems.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 150, overflowY: 'auto' } },
                ...check.problems.map((problem) =>
                  h('div', { key: problem.id, style: C.hint }, `• ${problem.id} — ${problem.missing}/${problem.refs}`),
                ),
              )
            : null,
          loadError ? h('div', { style: C.error }, loadError) : null,
        ),
        preview
          ? h(
              'div',
              { style: C.card },
              h('div', { style: C.cardTitle }, t('preview')),
              h(Kv, { label: t('createdAt'), value: fmtTime(preview.createdAt) }),
              h(Kv, { label: t('source'), value: `${preview.source.host || '—'} · ${preview.source.platform || '—'}` }),
              h(Kv, { label: t('formatVersion'), value: preview.formatVersion ? `v${preview.formatVersion}` : '—' }),
              h(Kv, { label: t('sessions'), value: String(preview.sessions) }),
              h(Kv, { label: t('bytes'), value: fmtBytes(preview.bytes || 0) }),
            )
          : null,
        preview && (preview.workspaces || []).length > 0
          ? h(
              'div',
              { style: C.card },
              h('div', { style: C.cardTitle }, t('remap')),
              h('div', { style: C.hint }, t('remapHint')),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 5, padding: '4px 0 10px' } },
                h('div', { style: C.cardTitle }, t('importRoot')),
                h('input', {
                  style: C.input,
                  value: rootDir,
                  placeholder: 'E:\\DSH',
                  onChange: (event) => applyRoot(event.target.value),
                  spellCheck: false,
                }),
                h('div', { style: C.hint }, t('importRootHint')),
              ),
              ...(preview.workspaces || []).map((workspace) =>
                h(
                  'div',
                  { key: workspace.id, style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                    h('span', { style: C.rowTitle }, workspace.title),
                    h('span', { style: C.badge }, `${workspace.sessions} ${t('sessionCount')} · ${fmtBytes(workspace.bytes || 0)}`),
                  ),
                  h('div', { style: C.mono }, `${t('from')}: ${workspace.path}`),
                  h('input', {
                    style: C.input,
                    value: remap[workspace.path] ?? workspace.path,
                    onChange: (event) => setRemap({ ...remap, [workspace.path]: event.target.value }),
                    spellCheck: false,
                  }),
                ),
              ),
            )
          : null,
        preview
          ? h(
              'div',
              { style: C.card },
              h('label', { style: C.label }, h(Checkbox, { checked: includeFiles, onChange: setIncludeFiles }), t('importFiles')),
              preview.attachments
                ? h('label', { style: C.label }, h(Checkbox, { checked: includeAttachments, onChange: setIncludeAttachments }), t('attachments'))
                : null,
              h('label', { style: C.label }, h(Checkbox, { checked: overwriteFiles, onChange: setOverwriteFiles }), t('overwrite')),
              h('label', { style: C.label }, h(Checkbox, { checked: rewritePaths, onChange: setRewritePaths }), t('rewritePaths')),
              h('div', { style: C.hint }, t('rewritePathsHint')),
              h(
                'button',
                {
                  style: running ? { ...C.primary, ...C.primaryOff } : C.primary,
                  disabled: running,
                  onClick: () => run('import', {
                    bundlePath,
                    remap,
                    rootDir: rootDir.trim() || null,
                    rewritePaths,
                    includeFiles,
                    includeAttachments,
                    overwriteFiles,
                  }),
                },
                running ? t('importRunning') : t('startImport'),
              ),
              h(Progress, { task }),
              h(TaskResult, { t, task, kind: 'import' }),
              task && task.phase === 'done'
                ? h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    h('button', { style: C.button, onClick: reload }, '刷新列表'),
                    (task.result.workspaces || []).length > 0
                      ? h('button', { style: C.button, onClick: () => undo(task.result) }, t('undo'))
                      : null,
                    undoNote ? h('span', { style: C.ok }, undoNote) : null,
                  )
                : null,
            )
          : null,
      )
    }

    function MigrateSection(props) {
      const t = props.t
      const [tab, setTab] = useState('export')
      const [inventory, setInventory] = useState(null)
      const [loadError, setLoadError] = useState(null)

      const load = useCallback(async () => {
        try {
          const value = await api.get('/inventory')
          setInventory(value)
          setLoadError(null)
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      return h(
        'div',
        { style: C.page },
        h('div', null, h('h1', { style: C.h1 }, t('title')), h('p', { style: C.sub }, t('subtitle'))),
        loadError ? h('div', { style: C.error }, loadError) : null,
        !inventory && !loadError ? h('div', { style: C.hint }, t('loading')) : null,
        h(
          'div',
          { style: C.tabs },
          h('button', { style: { ...C.tab, ...(tab === 'export' ? C.tabActive : {}) }, onClick: () => setTab('export') }, t('tabExport')),
          h('button', { style: { ...C.tab, ...(tab === 'import' ? C.tabActive : {}) }, onClick: () => setTab('import') }, t('tabImport')),
        ),
        tab === 'export'
          ? h(ExportPane, { t, inventory, reload: load })
          : h(ImportPane, { t, inventory, reload: load }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dicts = { zh: ZH, en: EN }
        const locale = ctx.get('locale')
        ctx.effect(() => ctx.locale.register(NS, 'zh', dicts.zh))
        ctx.effect(() => ctx.locale.register(NS, 'en', dicts.en))
        const translate = ctx.locale.bind(NS)
        const t = (key) => {
          try {
            return translate(key) || key
          } catch {
            return key
          }
        }

        function Section() {
          if (locale && locale.subscribe) {
            React.useSyncExternalStore(
              (callback) => ctx.locale.subscribe(callback),
              () => ctx.locale.getSnapshot(),
              () => ctx.locale.getSnapshot(),
            )
          }
          return h(MigrateSection, { t })
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'migration',
              order: 30,
              label: () => t('title'),
            },
            Section,
          ),
        )
      },
    }
  },
})
