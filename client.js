window.__ModuleLoader__.load({
  id: 'dsh-workspace-migrate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const NS = 'dsh-migrate'
    const API = '/api/dsh-migrate'
    // 反馈渠道：插件页底部展示；打赏链接填在这里（填写后自动出现按钮）
    const SUPPORT_EMAIL = 'lij0000@sina.com'
    const DONATE_URL = 'https://afdian.com/a/J-Lee'

    const ZH = {
      title: '迁移到另一台电脑',
      subtitle: '把工作区、项目成果和对话内容打包带走，在新电脑上还原。导出在旧电脑做，导入在新电脑做。',
      tabExport: '导出（旧电脑）',
      tabImport: '导入（新电脑）',
        supportFeedback: '问题反馈与技术交流',
        supportDonate: '这个插件帮到你了？请我喝杯咖啡 ☕',
      projects: '工作区',
      projectsHint: '选中的工作区会连同归属的会话一起打包；子会话会自动带上。',
      selectAll: '全选',
      selectNone: '清空',
      sessionCount: '个会话',
      files: '同时打包项目文件',
      filesHint: '排除 node_modules、.git 等可重建目录。',
      attachments: '同时打包图片附件',
        targetOs: '迁移目标系统',
        targetOsHint: '决定导入时如何转换对话里的路径分隔符。同系统迁移选默认即可。',
        targetSame: '同系统（{os}）',
        targetMac: 'Windows → macOS',
        targetLinux: 'Windows → Linux',
        targetWindows: 'macOS → Windows',
        targetLinuxFromMac: 'macOS → Linux',
        targetWinFromLinux: 'Linux → Windows',
        targetMacFromLinux: 'Linux → macOS',
        perProjectHint: '每个项目导出成一个 .dshmig 文件；导入时可多选，一次导入。',
        scanTitle: '目录里找到的迁移包',
        scanEmpty: '这个目录里没有 .dshmig 迁移包',
        perProjectDone: '已导出 {n} 个项目文件',
        crossOsTitle: '跨系统迁移',
        crossOsLine: '本包来自 {from}，当前系统是 {to}。导入时会把对话里的路径分隔符转成本机风格。',
        crossOsIllegal: '包内有 {n} 个文件名在 Windows 上不合法（含星号、问号、冒号、竖线等），复制会失败，需要先改名。',
        crossOsOk: '同系统迁移，路径按原样重写。',
      outDir: '导出位置',
      outDirHint: '留空则用 {path}。',
        browse: '浏览…',
        changePath: '修改路径',
        resetPath: '恢复默认',
        newPath: '新路径',
        pluginsExport: '同时记录已装插件清单',
        pluginsExportHint: '只记录插件名、版本和来源，不含插件内容；新电脑上不会自动安装。',
        linkNotExported: '本地链接插件不随包导出；迁移会话后可在对话里安装。',
        installSection: '在新电脑上安装这些插件',
        installSectionHint: '不会自动安装。勾选后点下面的按钮，会新建一个对话并填好提示词，你确认后再发送。',
        installNone: '先勾选要安装的插件',
        createInstallSession: '一键创建安装会话',
        installPromptProfile: '请装到 profile',
        installPromptIntro: '请帮我在本机安装下面这些 DSH 插件，它们来自一个迁移包的插件清单：',
        installPromptRules: '要求：\n- 逐条执行，先确认包存在、版本一致（例如 npm view <包名> version）\n- 只装我列出的这些，不要额外安装别的东西\n- 任何一条失败就停下来告诉我原因，不要跳过、不要换版本\n- 全部装完后确认插件已启用，并告诉我需要重启 DSH 才能生效\n- 本地链接（link:）插件依赖旧电脑的路径，无法迁移，不在清单里',
        disabled: '不可选',
        pluginsTitle: '插件清单（来源电脑）',
        pluginsHint: '仅作参考，不会自动安装。复制命令到新电脑执行。',
        pluginsEmpty: '这个包没有记录插件清单',
        pluginsOnlyHint: '没有勾选工作区：将只导出插件清单。',
        attachmentsCount: '个附件',
        pluginsCount: '个插件',
        undoLastTitle: '上一次导入',
        undoLastHint: '记录的是最近一次导入新建的项目与会话。撤销会移除项目登记，并把会话移入回收目录（可恢复），不动已有数据。',
        undoLastDo: '撤销上一次导入',
        undoLastConfirm: '将移除 {w} 个项目登记，并把 {s} 个会话移入回收目录 ~/.dsh/trash（可手动恢复）。项目文件夹里的文件不动。继续？',
        undoLastDone: '已撤销',
        undoLastTrash: '已移入',
        undoLastNone: '没有可撤销的导入记录',
        undoLastRefused: '部分条目被拒绝',
        undoLastBlocked: '导入后有 {n} 个会话又聊过，撤销会丢掉新内容，已禁用',
        sessionsDiff: '同名会话比对',
        choiceAppend: '更新（只追加）',
        choiceFork: '作为分叉',
        choiceSkip: '跳过',
        sessionsDiffMore: '还有 {n} 个未显示',
        verdictNew: '本机没有，将导入',
        verdictIdentical: '与本机一致，将跳过',
        verdictPackAhead: '包内多 {n} 条，可更新',
        verdictLocalAhead: '本机多 {n} 条，包里更旧',
        verdictDiverged: '两边都有新增（本机 {local} / 包 {pack}）',
        verdictUnreadable: '本机会话读取失败',
        pluginsProfile: 'profile',
        copyCommand: '复制命令',
        copied: '已复制',
        typeOfficial: '官方',
        typeNpm: 'npm',
        typeLink: '本地链接',
        typeGit: 'Git',
        typeTarball: '压缩包',
      startExport: '开始导出',
      exportRunning: '正在导出…',
      exportDone: '导出完成',
      exportFailed: '导出失败',
      bundlePath: '迁移包路径',
        batchTitle: '批量导入（多选）',
        batchHint: '选中多个迁移包，按默认策略一次导入：包内更新则追加，两边都有新增则分叉，其余跳过。',
        batchImport: '导入选中的 {n} 个包',
        browseFolder: '浏览…',
        scanClose: '收起',
        scanExpand: '展开',
        scanHint: '勾选一个立即读取；勾选多个后点下方按钮，一次性对比全部会话。',
        scanImported: '已导入',
        scanPartial: '部分已存在 {n}',
        hostTooOld: '宿主插件还是旧版本（缺少文件浏览接口）。请完全退出 DSH（含托盘）后重新打开，仅刷新页面不会重载宿主代码。',
        hostVersion: '宿主接口',
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
        restartTitle: '导入完成 → 请重启 DSH',
        restartBody: '会话与工作区已经写入磁盘，但侧栏、会话列表和缓存要等 DSH 重新加载后才完全刷新。',
        restartSteps: '做法：完全退出 DSH（含托盘图标），再重新打开；只刷新页面不会重载宿主。',
      reportAppended: '追加更新',
      reportForked: '作为分叉合并',
      reportCopied: '作为副本导入（分叉不可用）',
        subagentsSkipped: '个子代理会话未导出（内部记录）',
      eventsCount: '条事件',
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
        updateHint: '只复制新增或修改过的文件，未变化的会话与文件直接复用。目标可以填 .dshmig 文件，也可以填旧版文件夹包。',
      updateNow: '开始增量更新',
      reused: '复用会话',
      copied: '复制文件',
      unchanged: '未变',
      removed: '已删除',
      importRoot: '导入到（新工作路径）',
      importRootHint: '每个项目会自动建一个以项目名命名的子文件夹；下面每一行仍可单独改。',
      rewritePaths: '重写对话里提到的旧路径',
      rewritePathsHint: '工具调用与结果中的旧绝对路径会换成新路径，续聊时模型才找得到文件。',
      rewrittenPaths: '重写路径',
        renamedFiles: '重命名的文件',
        filesNew: '新增文件',
        filesUnchanged: '未变文件',
        filesSkippedExisting: '已存在未覆盖',
        unreadableImported: '导入后无法读取的会话',
        unreadableHint: '这些会话已写入磁盘但读不回来，通常是格式版本不一致；可用「撤销这次导入」清理。',
        brokenRemoved: '已把 {n} 个无法读取的会话移入回收站，避免左侧栏报错。',
        unattachedSessions: '未挂到工作区的会话（左栏可能不显示）',
        orphanSessions: '父会话缺失的会话',
        orphanHint: '这些会话指向的父会话既不在包里也不在本机，打开会像从中间截断。',
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
        supportFeedback: 'Feedback and technical discussion',
        supportDonate: 'Found this useful? Buy me a coffee ☕',
      projects: 'Workspaces',
      projectsHint: 'Selected workspaces carry their sessions; sub-sessions are included automatically.',
      selectAll: 'All',
      selectNone: 'None',
      sessionCount: 'sessions',
      files: 'Include project files',
      filesHint: 'Skips rebuildable directories such as node_modules and .git.',
      attachments: 'Include image attachments',
        targetOs: 'Target system',
        targetOsHint: 'Decides how path separators inside conversations are converted on import. Keep the default for same-system moves.',
        targetSame: 'Same system ({os})',
        targetMac: 'Windows → macOS',
        targetLinux: 'Windows → Linux',
        targetWindows: 'macOS → Windows',
        targetLinuxFromMac: 'macOS → Linux',
        targetWinFromLinux: 'Linux → Windows',
        targetMacFromLinux: 'Linux → macOS',
        perProjectHint: 'Each project becomes one .dshmig file; import several of them at once.',
        scanTitle: 'Bundles found in this folder',
        scanEmpty: 'No .dshmig bundle in this folder',
        perProjectDone: 'Exported {n} project files',
        crossOsTitle: 'Cross-system move',
        crossOsLine: 'This bundle came from {from} and this machine is {to}; path separators inside conversations are converted on import.',
        crossOsIllegal: '{n} file names in the bundle are illegal on Windows (asterisk, question mark, colon, pipe and similar), so copying them will fail until they are renamed.',
        crossOsOk: 'Same system; paths are rewritten as they are.',
      outDir: 'Export location',
      outDirHint: 'Empty uses {path}.',
        browse: 'Browse…',
        changePath: 'Change path',
        resetPath: 'Reset',
        newPath: 'New path',
        pluginsExport: 'Include the installed-plugin list',
        pluginsExportHint: 'Names, versions and sources only — no plugin content, and nothing is installed on the new machine.',
        linkNotExported: 'Local-link plugins are not exported; install them from a conversation after migrating.',
        installSection: 'Install these plugins on this machine',
        installSectionHint: 'Nothing is installed automatically. Pick what you need, press the button, and a new conversation opens with the prompt filled in — you still send it.',
        installNone: 'Select at least one plugin first',
        createInstallSession: 'Create install conversation',
        installPromptProfile: 'Install into profile',
        installPromptIntro: 'Please install these DSH plugins on this machine. They come from a migration bundle plugin list:',
        installPromptRules: 'Rules:\n- Work through them one at a time and verify each package exists at the exact version first (for example npm view <name> version)\n- Install only the packages listed here, nothing else\n- Stop and tell me the reason if any of them fails; do not skip and do not substitute versions\n- When everything is installed, confirm the plugins are enabled and tell me DSH has to restart\n- Local-link (link:) plugins point at paths on the old machine and cannot be migrated, so they are not listed',
        disabled: 'unavailable',
        pluginsTitle: 'Plugins on the source machine',
        pluginsHint: 'Reference only — nothing is installed. Copy the command on the new machine.',
        pluginsEmpty: 'This bundle has no plugin list',
        pluginsOnlyHint: 'No workspace selected: the bundle will contain only the plugin list.',
        attachmentsCount: 'attachments',
        pluginsCount: 'plugins',
        undoLastTitle: 'Last import',
        undoLastHint: 'Records the Workspaces and Sessions the most recent import created. Undo drops the Workspace registrations and moves the Sessions into a trash folder you can restore from.',
        undoLastDo: 'Undo last import',
        undoLastConfirm: 'This deletes {w} Workspace registrations and {s} Sessions created by that import. Files inside the project folders stay untouched. Continue?',
        undoLastDone: 'Undone',
        undoLastTrash: 'moved to',
        undoLastNone: 'Nothing to undo',
        undoLastRefused: 'some entries were refused',
        undoLastBlocked: '{n} imported sessions were continued after the import; undo would discard that, so it is disabled',
        sessionsDiff: 'Same-name sessions',
        choiceAppend: 'update (append only)',
        choiceFork: 'merge as fork',
        choiceSkip: 'skip',
        sessionsDiffMore: '{n} more not shown',
        verdictNew: 'new here, will import',
        verdictIdentical: 'same as local, will skip',
        verdictPackAhead: 'bundle has {n} more, can update',
        verdictLocalAhead: 'local has {n} more, bundle is older',
        verdictDiverged: 'both changed (local {local} / bundle {pack})',
        verdictUnreadable: 'local session unreadable',
        pluginsProfile: 'profile',
        copyCommand: 'Copy command',
        copied: 'Copied',
        typeOfficial: 'official',
        typeNpm: 'npm',
        typeLink: 'local link',
        typeGit: 'git',
        typeTarball: 'tarball',
      startExport: 'Start export',
      exportRunning: 'Exporting…',
      exportDone: 'Export finished',
      exportFailed: 'Export failed',
      bundlePath: 'Bundle path',
        batchTitle: 'Batch import (multi-select)',
        batchHint: 'Pick several bundles and import them in one go: bundle-ahead appends, both-grew forks, anything else is skipped.',
        batchImport: 'Import the {n} selected bundles',
        browseFolder: 'Browse…',
        scanClose: 'Hide',
        scanExpand: 'Show',
        scanHint: 'Tick one to load it at once; tick several and press the button to compare every Session together.',
        scanImported: 'imported',
        scanPartial: 'partly present {n}',
        hostTooOld: 'The running host plugin is outdated (no file-browser route). Quit DSH completely (including the tray) and reopen it; refreshing the page does not reload host code.',
        hostVersion: 'host interface',
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
        restartTitle: 'Import finished → restart DSH',
        restartBody: 'Sessions and workspaces are on disk, but the sidebar and caches only reload fully on the next start.',
        restartSteps: 'Quit DSH completely (including the tray icon) and open it again; refreshing the page does not reload the host.',
      reportAppended: 'Updated in place',
      reportForked: 'Merged as forks',
      reportCopied: 'Imported as copies (fork unavailable)',
        subagentsSkipped: 'subagent transcripts skipped',
      eventsCount: 'events',
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
      importRoot: 'Import into (new path)',
      importRootHint: 'Each project gets a subfolder named after it; every row below can still be edited.',
      rewritePaths: 'Rewrite old paths mentioned in conversations',
      rewritePathsHint: 'Absolute paths inside tool calls and results are replaced with the new ones, so a resumed conversation finds its files.',
      rewrittenPaths: 'paths rewritten',
        renamedFiles: 'files renamed',
        filesNew: 'files added',
        filesUnchanged: 'files unchanged',
        filesSkippedExisting: 'existing files skipped',
        unreadableImported: 'Sessions that cannot be read back',
        unreadableHint: 'Written to disk but unreadable, usually a format-version mismatch; use undo to clean up.',
        brokenRemoved: 'Moved {n} unreadable Session(s) to the trash so the sidebar stays usable.',
        unattachedSessions: 'Sessions not attached to a workspace',
        orphanSessions: 'Sessions with a missing parent',
        orphanHint: 'Their parent is neither in the bundle nor on this machine, so they open mid-conversation.',
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
        borderBottom: 'none', marginBottom: -1, boxShadow: 'inset 0 -2px 0 0 transparent',
      },
      tabActive: { color: 'var(--dsw-alias-label-primary)', boxShadow: 'inset 0 -2px 0 0 var(--dsw-alias-brand-primary)' },
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
        appearance: 'none',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: 8,
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, var(--dsw-alias-bg-base))',
        color: 'var(--dsw-alias-brand-primary)',
        padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
      },
      primaryOff: { opacity: 0.5, cursor: 'default' },
      linkButton: {
        appearance: 'none', border: 'none', background: 'none', padding: '2px 4px',
        color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline',
      },
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

    /** Platform-flavoured default migrations directory, for hints only. */
    function migrationsLabel(inventory) {
      const dir = inventory && inventory.migrationsDir ? String(inventory.migrationsDir) : ''
      const posix = dir.length > 0 ? dir.includes('/') && !dir.includes('\\') : false
      return posix ? '~/.dsh/migrations' : '%USERPROFILE%\\.dsh\\migrations'
    }

    /** Mirror the host's per-project target rule for previews. */
    function joinTarget(root, title, sep) {
      const cleaned = String(title || 'workspace')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '')
        .slice(0, 80)
      const base = root.replace(/[\\/]+$/, '')
      return `${base}${sep}${cleaned.length > 0 ? cleaned : 'workspace'}`
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
          h('div', { style: C.ok }, `${t('exportDone')} · ${result.sessions} ${t('sessions')} · ${fmtBytes(result.bytes)}${result.attachments > 0 ? ` · ${result.attachments} ${t('attachmentsCount')}` : ''}${result.plugins > 0 ? ` · ${result.plugins} ${t('pluginsCount')}` : ''}`),
          result.subagents > 0 ? h('div', { style: C.hint }, `${result.subagents} ${t('subagentsSkipped')}`) : null,
          result.files && result.files.length > 0
            ? h(
                'div',
                { style: C.hint },
                `${t('perProjectDone').replace('{n}', String(result.files.length))}`,
                ...result.files.slice(0, 5).map((file) => h('div', { key: file, title: file }, `· ${file}`)),
              )
            : null,
          result.mode === 'update'
            ? h(
                'div',
                { style: C.hint },
                `${t('reused')} ${result.sessionsReused} · ${t('copied')} ${result.filesCopied} (${fmtBytes(result.bytesCopied)}) · ${t('unchanged')} ${result.filesUnchanged} · ${t('removed')} ${result.filesRemoved}`,
              )
            : null,
          h('div', { style: C.mono, title: result.path }, result.path),
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
        (result.sessionsImported + (result.sessionsAppended || []).length + (result.sessionsForked || []).length + (result.workspaces || []).length) > 0
          ? h(
              'div',
              {
                style: {
                  ...C.card,
                  borderColor: 'var(--dsw-alias-state-warn-primary)',
                  borderWidth: 2,
                  background: 'var(--dsw-alias-bg-layer-2)',
                  padding: '10px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                },
              },
              h(
                'div',
                { style: { fontWeight: 700, color: 'var(--dsw-alias-state-warn-primary)' } },
                t('restartTitle'),
              ),
              h('div', { style: C.hint }, t('restartBody')),
              h('div', { style: C.hint }, t('restartSteps')),
            )
          : null,
        (result.sessionsAppended || []).length > 0
          ? h(
              'div',
              { style: C.ok },
              `${t('reportAppended')}: ${result.sessionsAppended.length}（+${result.sessionsAppended.reduce((sum, item) => sum + (item.added || 0), 0)} ${t('eventsCount')}）`,
            )
          : null,
        (result.sessionsForked || []).length > 0
          ? h('div', { style: C.ok }, `${t('reportForked')}: ${result.sessionsForked.length}`)
          : null,
        (result.sessionsCopied || []).length > 0
          ? h('div', { style: C.warn }, `${t('reportCopied')}: ${result.sessionsCopied.length}`)
          : null,
        result.subagentSkipped > 0
          ? h('div', { style: C.hint }, `· ${result.subagentSkipped} ${t('subagentsSkipped')}`)
          : null,
        result.flattened > 0 ? h('div', { style: C.hint }, `${t('flattened')}: ${result.flattened}`) : null,
        result.rewritten > 0 ? h('div', { style: C.hint }, `${t('rewrittenPaths')}: ${result.rewritten}`) : null,
        result.renamedFiles > 0 ? h('div', { style: C.hint }, `${t('renamedFiles')}: ${result.renamedFiles}`) : null,
        (result.filesNew || 0) + (result.filesUnchanged || 0) + (result.filesSkippedExisting || 0) > 0
          ? h('div', { style: C.hint }, `${t('filesNew')}: ${result.filesNew || 0} · ${t('filesUnchanged')}: ${result.filesUnchanged || 0} · ${t('filesSkippedExisting')}: ${result.filesSkippedExisting || 0}`)
          : null,
        (result.unattached || []).length > 0 ? h('div', { style: C.warn }, `${t('unattachedSessions')}: ${result.unattached.length}`) : null,
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
        (result.unreadable || []).length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
              h('div', { style: C.error }, `${t('unreadableImported')}: ${result.unreadable.length}`),
              h('div', { style: C.hint }, t('unreadableHint')),
              ...result.unreadable.slice(0, 4).map((item, index) =>
                h('div', { key: index, style: C.error }, `• ${item.id} — ${item.reason}`),
              ),
              result.brokenRemoved > 0 ? h('div', { style: C.warn }, t('brokenRemoved').replace('{n}', String(result.brokenRemoved))) : null,
            )
          : null,
        (result.orphans || []).length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
              h('div', { style: C.warn }, `${t('orphanSessions')}: ${result.orphans.length}`),
              h('div', { style: C.hint }, t('orphanHint')),
              ...result.orphans.slice(0, 4).map((item, index) =>
                h('div', { key: index, style: C.hint }, `• ${item.id} → ${item.parent}`),
              ),
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
          const raw = cause instanceof Error ? cause.message : String(cause)
          // A 404 here means the running host is an older build: say so instead of '未知接口'.
          const message = raw.includes('未知接口') || raw.includes('404') ? t('hostTooOld') : raw
          setError(message)
          setTask({ phase: 'failed', error: message, message, done: 0, total: 0 })
        }
      }, [t])

      return { task, error, run }
    }

    function ExportPane(props) {
      const { t, inventory, reload, pick, canPick } = props
      const [selected, setSelected] = useState(null)
      const [includeFiles, setIncludeFiles] = useState(true)
      const [includeAttachments, setIncludeAttachments] = useState(true)
      const [includePlugins, setIncludePlugins] = useState(false)
      const [pluginSelected, setPluginSelected] = useState(null)
      const [targetOs, setTargetOs] = useState('same')

      const [outDir, setOutDir] = useState('')
      const [updateTarget, setUpdateTarget] = useState('')
      const [updateScan, setUpdateScan] = useState(null)
      const [updatePicked, setUpdatePicked] = useState(new Set())
      const [updateError, setUpdateError] = useState(null)
      const [cleanupNote, setCleanupNote] = useState(null)
      const { task, run } = usePolling(t)
      /** Folder browse for the update target: real paths only, never an upload. */
      const browseUpdateTarget = async () => {
        setUpdateError(null)
        try {
          const dir = await pick()
          if (!dir) return
          // A legacy folder bundle is used as-is; otherwise list the .dshmig files
          // inside the chosen folder so the update hits the real file on disk.
          const info = await api.get(`/bundle-info?path=${encodeURIComponent(dir)}`).catch(() => null)
          if (info && !info.error) {
            setUpdateTarget(dir)
            setUpdateScan(null)
            return
          }
          const result = await api.get(`/scan?dir=${encodeURIComponent(dir)}`)
          const found = (result && result.bundles) || []
          setUpdateScan({ dir, bundles: found })
          if (found.length === 1) setUpdateTarget(found[0].path)
        } catch (error) {
          setUpdateError(error instanceof Error ? error.message : String(error))
        }
      }


      const hostPlatform = inventory && inventory.hostPlatform ? inventory.hostPlatform : 'win32'
      const hostLabel = hostPlatform === 'win32' ? 'Windows' : hostPlatform === 'darwin' ? 'macOS' : 'Linux'
      const targetOptions = [
        { value: 'same', label: t('targetSame').replace('{os}', hostLabel) },
        ...(hostPlatform === 'win32' ? [['darwin', t('targetMac')], ['linux', t('targetLinux')]] : []),
        ...(hostPlatform === 'darwin' ? [['win32', t('targetWindows')], ['linux', t('targetLinuxFromMac')]] : []),
        ...(hostPlatform === 'linux' ? [['win32', t('targetWinFromLinux')], ['darwin', t('targetMacFromLinux')]] : []),
      ].map((entry) => (Array.isArray(entry) ? { value: entry[0], label: entry[1] } : entry))

      const workspaces = inventory ? inventory.workspaces : []
      const bundles = inventory && inventory.bundles ? inventory.bundles : []
      const active = selected === null ? new Set(workspaces.map((workspace) => workspace.id)) : selected
      const pluginList = inventory && inventory.plugins && Array.isArray(inventory.plugins.plugins) ? inventory.plugins.plugins : []
      // Sessions/files, or just the plugin list: both are a valid export.
      const exportablePlugins = pluginList.filter(
        (plugin) => plugin.type !== 'link' && (pluginSelected === null || pluginSelected.has(plugin.name)),
      ).length
      const noWorkspaces = active.size === 0
      const canExport = active.size > 0 || (includePlugins && exportablePlugins > 0)

      useEffect(() => {
        if (task && task.phase === 'done') reload()
      }, [task])

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
          h(
            'label',
            {
              style: {
                ...C.label,
                opacity: noWorkspaces ? 0.45 : 1,
                cursor: noWorkspaces ? 'default' : 'pointer',
              },
            },
            h(Checkbox, { checked: includeFiles && !noWorkspaces, disabled: noWorkspaces, onChange: setIncludeFiles }),
            t('files'),
          ),
          h('div', { style: { ...C.hint, opacity: noWorkspaces ? 0.45 : 1 } }, t('filesHint')),
          h(
            'label',
            {
              style: {
                ...C.label,
                opacity: noWorkspaces ? 0.45 : 1,
                cursor: noWorkspaces ? 'default' : 'pointer',
              },
            },
            h(Checkbox, { checked: includeAttachments && !noWorkspaces, disabled: noWorkspaces, onChange: setIncludeAttachments }),
            t('attachments'),
          ),
          h('label', { style: C.label }, h(Checkbox, { checked: includePlugins, onChange: setIncludePlugins }), t('pluginsExport')),
          h('div', { style: C.hint }, t('pluginsExportHint')),
          includePlugins && pluginList.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 0 6px 22px' } },
                ...pluginList.map((plugin) => {
                  // Local links point at the old machine's paths, so they cannot
                  // travel; showing them greyed out explains what is missing.
                  const locked = plugin.type === 'link'
                  const active = !locked && (pluginSelected === null || pluginSelected.has(plugin.name))
                  return h(
                    'div',
                    { key: plugin.name, style: { display: 'flex', flexDirection: 'column', gap: 1 } },
                    h(
                      'label',
                      {
                        style: {
                          ...C.label,
                          fontWeight: 400,
                          cursor: locked ? 'default' : 'pointer',
                          opacity: locked ? 0.5 : 1,
                        },
                      },
                      h(Checkbox, {
                        checked: active,
                        disabled: locked,
                        onChange: () => {
                          const next = new Set(
                            pluginSelected === null
                              ? pluginList.filter((item) => item.type !== 'link').map((item) => item.name)
                              : pluginSelected,
                          )
                          if (next.has(plugin.name)) next.delete(plugin.name)
                          else next.add(plugin.name)
                          setPluginSelected(next)
                        },
                      }),
                      h('span', { style: C.mono }, plugin.name),
                      h('span', { style: { ...C.hint, marginLeft: 6, padding: 0 } }, pluginTypeLabel(t, plugin.type)),
                      locked ? h('span', { style: { ...C.hint, marginLeft: 6, padding: 0 } }, t('disabled')) : null,
                    ),
                  )
                }),
                pluginList.some((plugin) => plugin.type === 'link')
                  ? h('div', { style: { ...C.hint, paddingLeft: 22, fontSize: 11.5 } }, t('linkNotExported'))
                  : null,
              )
            : null,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            h('div', { style: C.hint }, t('targetOs')),
            h('select', {
              style: C.input,
              value: targetOs,
              onChange: (event) => setTargetOs(event.target.value),
            }, ...targetOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
            h('div', { style: C.hint }, t('targetOsHint')),
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            h('div', { style: C.hint }, t('outDir')),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                style: { ...C.input, flex: 1 },
                title: outDir || (inventory ? inventory.migrationsDir : ''),
                value: outDir,
                placeholder: inventory ? inventory.migrationsDir : '',
                onChange: (event) => setOutDir(event.target.value),
                spellCheck: false,
              }),
              canPick
                ? h('button', {
                    style: C.button,
                    onClick: async () => {
                      const dir = await pick()
                      if (dir) setOutDir(dir)
                    },
                  }, t('browse'))
                : null,
            ),
            h('div', { style: C.hint }, t('outDirHint').replace('{path}', migrationsLabel(inventory))),
            h('div', { style: C.hint }, t('perProjectHint')),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h(
              'button',
              {
                style: running || !canExport ? { ...C.primary, ...C.primaryOff } : C.primary,
                disabled: running || !canExport,
                onClick: () =>
                  run('export', {
                    workspaceIds: [...active],
                    // An empty selection is a real choice here: export the plugin
                    // list alone instead of silently falling back to everything.
                    onlyPlugins: active.size === 0,
                    includeFiles: includeFiles && active.size > 0,
                    includeAttachments: includeAttachments && active.size > 0,
                    outDir: outDir.trim() || null,
                    includePlugins,
                    pluginNames: pluginSelected === null ? null : [...pluginSelected],
                    targetPlatform: targetOs === 'same' ? undefined : targetOs,
                    packageFormat: 'perProject',
                  }),
              },
              running ? t('exportRunning') : t('startExport'),
            ),
            active.size === 0 && includePlugins && exportablePlugins > 0
              ? h('span', { style: C.hint }, t('pluginsOnlyHint'))
              : null,
        ),
          h(Progress, { task }),
          h(TaskResult, { t, task, kind: 'export' }),
        ),
        task && task.phase === 'done' && task.result
          ? h('button', { style: C.button, onClick: reload }, '刷新列表')
          : null,
        h(
          'div',
          { style: C.card },
          h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 7,


                  },
                },
                h('div', { style: C.cardTitle }, t('update')),
                h('div', { style: C.hint }, t('updateHint')),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  h('input', {
                    style: { ...C.input, flex: 1 },
                    title: updateTarget,
                    value: updateTarget,
                    placeholder: 'D:\\path\\to\\dsh-migration-…',
                    onChange: (event) => setUpdateTarget(event.target.value),
                    spellCheck: false,
                  }),
                  canPick
                    ? h(
                        'button',
                        {
                          style: C.button,
                          onClick: browseUpdateTarget,
                        },
                        t('browse'),
                      )
                    : null,
                  h(
                    'button',
                    {
                      style: running || !updateTarget ? { ...C.button, ...C.primaryOff } : C.button,
                      disabled: running || !updateTarget,
                      onClick: () =>
                        run('export',
                          updatePicked.size > 1
                            ? { mode: 'update', bundlePaths: [...updatePicked], includeFiles, includeAttachments }
                            : { mode: 'update', bundlePath: updateTarget, includeFiles, includeAttachments }),
                    },
                    updatePicked.size > 1 ? `${t('updateNow')} (${updatePicked.size})` : t('updateNow'),
          updateError ? h('div', { style: C.error }, updateError) : null,
                  ),
          updateScan && updateScan.bundles.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4, flexBasis: '100%' } },
                h('div', { style: C.hint }, t('scanTitle')),
                ...updateScan.bundles.map((bundle) =>
                  h('label', {
                    key: bundle.path,
                    style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' },
                    title: bundle.path,
                  },
                    h('input', {
                      type: 'checkbox',
                      checked: updatePicked.has(bundle.path),
                      onChange: () => {
                        const next = new Set(updatePicked)
                        if (next.has(bundle.path)) next.delete(bundle.path)
                        else next.add(bundle.path)
                        setUpdatePicked(next)
                        setUpdateTarget(next.has(bundle.path) ? bundle.path : ([...next][0] || ''))
                      },
                    }),
                    h('span', { style: { ...C.mono, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } },
                      `${bundle.name} · ${bundle.sessions} ${t('sessions')} · ${fmtBytes(bundle.bytes || 0)}`),
                  ),
                ),
              )
            : updateScan && updateScan.bundles.length === 0
              ? h('div', { style: C.hint }, t('scanEmpty'))
              : null,
                ),
              ),
        ),
      )
    }

    /** One line per same-name Session: what a re-import would do with it. */
    function verdictView(t, entry) {
      const local = entry.localEvents
      const pack = entry.packEvents
      switch (entry.verdict) {
        case 'identical':
          return { label: t('verdictIdentical'), style: C.hint }
        case 'packAhead':
          return { label: t('verdictPackAhead').replace('{n}', String(Math.max(0, (pack || 0) - (local || 0)))), style: C.ok }
        case 'localAhead':
          return { label: t('verdictLocalAhead').replace('{n}', String(Math.max(0, (local || 0) - (pack || 0)))), style: C.hint }
        case 'diverged':
          return { label: t('verdictDiverged').replace('{local}', String(local || 0)).replace('{pack}', String(pack || 0)), style: C.error }
        case 'unreadable':
          return { label: t('verdictUnreadable'), style: C.warn }
        default:
          return { label: t('verdictNew'), style: C.hint }
      }
    }
    /** One same-name Session row with its per-row choice buttons. */
    function comparisonRow(t, entry, sessionChoices, setSessionChoices) {
      const view = verdictView(t, entry)
      const choice =
        entry.verdict === 'packAhead'
          ? sessionChoices[entry.id] || 'append'
          : entry.verdict === 'diverged'
            ? sessionChoices[entry.id] || 'fork'
            : 'skip'
      const options =
        entry.verdict === 'packAhead'
          ? [
              ['append', t('choiceAppend')],
              ['skip', t('choiceSkip')],
            ]
          : entry.verdict === 'diverged'
            ? [
                ['fork', t('choiceFork')],
                ['skip', t('choiceSkip')],
              ]
            : []
      return h(
        'div',
        { key: entry.id, style: { display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 4 } },
        h(
          'div',
          { style: { ...view.style, display: 'flex', gap: 8, alignItems: 'baseline' } },
          h(
            'span',
            {
              style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: entry.title || entry.id,
            },
            entry.title || entry.id,
          ),
          entry.packTitle && entry.packTitle !== entry.title
            ? h('span', { style: { ...C.hint, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: entry.packTitle }, `(包里: ${entry.packTitle})`)
            : null,
          h('span', { style: { opacity: 0.75, whiteSpace: 'nowrap' } }, view.label),
        ),
        options.length > 0
          ? h(
              'div',
              { style: { display: 'flex', gap: 6, paddingLeft: 2 } },
              ...options.map(([value, label]) =>
                h(
                  'button',
                  {
                    key: value,
                    style: {
                      ...C.linkButton,
                      fontWeight: choice === value ? 600 : 400,
                      textDecoration: choice === value ? 'underline' : 'none',
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                    onClick: () => setSessionChoices({ ...sessionChoices, [entry.id]: value }),
                  },
                  label,
                ),
              ),
            )
          : null,
      )
    }

    /** Group rows by bundle so several packages stay readable in one table. */
    function comparisonGroups(t, comparisons, sessionChoices, setSessionChoices) {
      const groups = new Map()
      for (const entry of comparisons.slice(0, 40)) {
        const key = entry.bundle || ''
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(entry)
      }
      const nodes = []
      for (const [key, entries] of groups) {
        if (key) {
          nodes.push(
            h('div', { key: `group:${key}`, style: { ...C.cardTitle, fontSize: 12, paddingTop: 8 } }, key),
          )
        }
        for (const entry of entries) nodes.push(comparisonRow(t, entry, sessionChoices, setSessionChoices))
      }
      return nodes
    }

    function pluginTypeLabel(t, type) {
      const keys = { official: 'typeOfficial', npm: 'typeNpm', link: 'typeLink', git: 'typeGit', tarball: 'typeTarball' }
      return t(keys[type] || 'typeNpm')
    }

    /**
     * A DSH plugin can only be installed into a profile, so the command must say
     * which one: a bare `dsh plugin add` may land in another profile than the one
     * this bundle came from.
     */
    function installCommand(plugin, profile) {
      if (plugin.type === 'official') return ''
      const target = profile ? ` --profile ${profile}` : ''
      if (plugin.type === 'npm') {
        const version = String(plugin.spec || '').replace(/^[\^~]/, '')
        return `dsh plugin${target} add ${version ? `${plugin.name}@${version}` : plugin.name}`
      }
      return `dsh plugin${target} add ${plugin.spec}`
    }

    function installablePlugins(plugins) {
      return (plugins || []).filter((plugin) => plugin.type === 'npm' || plugin.type === 'git' || plugin.type === 'tarball')
    }

    /**
     * Build the prompt for a fresh Session. The plugin never installs anything:
     * it hands the list to the agent, which shows every command it runs.
     */
    function buildInstallPrompt(t, bundleLabel, profile, plugins) {
      const lines = plugins.map((plugin, index) => `${index + 1}. ${plugin.name} ${plugin.spec}\n   ${installCommand(plugin, profile)}`)
      return [
        `${t('installPromptIntro')}${bundleLabel ? `（${bundleLabel}）` : ''}`,
        '',
        ...lines,
        '',
        profile ? `${t('installPromptProfile')}：${profile}` : '',
        t('installPromptRules'),
      ].join('\n')
    }

    function CopyButton(props) {
      const { t, text } = props
      const [done, setDone] = useState(false)
      return h(
        'button',
        {
          style: C.linkButton,
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(text)
              setDone(true)
              setTimeout(() => setDone(false), 1600)
            } catch {
              /* clipboard may be blocked; the command stays selectable on screen */
            }
          },
        },
        done ? t('copied') : t('copyCommand'),
      )
    }

    const IMPORT_STATE_KEY = 'dsh-migrate:import-state'

    function readImportState() {
      try {
        const raw = localStorage.getItem(IMPORT_STATE_KEY)
        return raw ? JSON.parse(raw) : null
      } catch {
        return null
      }
    }

    function writeImportState(state) {
      try {
        localStorage.setItem(IMPORT_STATE_KEY, JSON.stringify(state))
      } catch {
        /* storage is a convenience; losing it only means retyping the path */
      }
    }

    function ImportPane(props) {
      const { t, inventory, reload, pick, canPick, startSession, canInstallSession } = props
      const bundles = inventory ? inventory.bundles : []
      // Creating the install Session navigates away and unmounts this pane, so
      // the bundle path and the per-project mapping survive in localStorage.
      const restored = readImportState()
      const [bundlePath, setBundlePath] = useState(restored && restored.bundlePath ? restored.bundlePath : '')
      const [preview, setPreview] = useState(null)
      const [remap, setRemap] = useState(restored && restored.remap ? restored.remap : {})
      const [includeFiles, setIncludeFiles] = useState(true)
      const [includeAttachments, setIncludeAttachments] = useState(true)
      const [overwriteFiles, setOverwriteFiles] = useState(false)
      const [rootDir, setRootDir] = useState(restored && restored.rootDir ? restored.rootDir : '')
      const [rewritePaths, setRewritePaths] = useState(true)
      const [check, setCheck] = useState(null)
      const [checking, setChecking] = useState(false)
      const [loadError, setLoadError] = useState(null)
      const [installSelection, setInstallSelection] = useState(new Set())
      const [sessionChoices, setSessionChoices] = useState({})
      const [undoNote, setUndoNote] = useState(null)
      const { task, run } = usePolling(t)
      const running = task && task.phase === 'running'
      const installable = preview ? installablePlugins(preview.plugins && preview.plugins.list) : []

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

      const posixTarget = Boolean(
        preview && (preview.workspaces || []).some((workspace) => String(workspace.path || '').startsWith('/')),
      )
      const targetSeparator = posixTarget ? '/' : '\\'

      const applyRoot = (value) => {
        setRootDir(value)
        if (!preview) return
        const trimmed = value.trim()
        // Follow the separator style of what was typed, then of the bundle:
        // a POSIX bundle imported on Linux must never grow backslashes.
        const separator =
          trimmed.startsWith('/') || (trimmed.includes('/') && !trimmed.includes('\\')) ? '/' : targetSeparator
        const base = trimmed.replace(/[\\/]+$/, '')
        const next = { ...remap }
        for (const workspace of preview.workspaces || []) {
          const name = String(workspace.title || workspace.path)
            .replace(/[\\/:*?"<>|]/g, ' ')
            .trim()
          next[workspace.path] = base ? `${base}${separator}${name}` : workspace.path
        }
        setRemap(next)
      }

      const [undoLastNote, setUndoLastNote] = useState(null)
      const [lastImportProbe, setLastImportProbe] = useState(null)


      useEffect(() => {
        let alive = true
        if (!inventory || !inventory.lastImport) {
          setLastImportProbe(null)
          return () => { alive = false }
        }
        api
          .get('/last-import')
          .then((result) => { if (alive) setLastImportProbe(result && result.lastImport) })
          .catch(() => { if (alive) setLastImportProbe(null) })
        return () => { alive = false }
      }, [inventory && inventory.lastImport && inventory.lastImport.at])

      const undoBlocked = Boolean(lastImportProbe && lastImportProbe.safe === false)
      const undoLast = async () => {
        const record = inventory && inventory.lastImport
        if (!record) return
        const message = t('undoLastConfirm')
          .replace('{w}', String((record.workspaces || []).length))
          .replace('{s}', String((record.sessions || []).length))
        if (!window.confirm(message)) return
        try {
          const result = await api.post('/rollback', { useLast: true })
          const removed = [...(result.workspaces || []), ...(result.sessions || [])].filter((item) => item.removed).length
          const refused = [...(result.workspaces || []), ...(result.sessions || [])].filter((item) => item.refused).length
          const trash = result.trashDir ? ` · ${t('undoLastTrash')} ${result.trashDir}` : ''
          const refusedNote = refused > 0 ? ` · ${t('undoLastRefused')} ${refused}` : ''
          setUndoLastNote(`${t('undoLastDone')} ${removed}${refusedNote}${trash}`)
          reload()
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }

      /** The mapping the import will use, so the check judges the same targets. */
      const checkQuery = (path) => {
        const params = new URLSearchParams({ path })
        const root = rootDir.trim()
        if (root) params.set('rootDir', root)
        if (remap && Object.keys(remap).length > 0) params.set('remap', JSON.stringify(remap))
        return params.toString()
      }
      const runCheck = async () => {
        // Selection comes from the folder list or from uploaded files; both fill
        // the same set, and bundlePath is only a fallback for a typed path.
        const picked = [...scanPicked].filter(Boolean)
        if (picked.length === 0 && !bundlePath) return
        setChecking(true)
        setCheck(null)
        setLoadError(null)
        try {
          // 体检 is now the only entry: it loads the preview as well, so there is
          // no separate "read bundle" step for the user to get wrong.
          const first = picked.length > 0 ? picked[0] : bundlePath
          setPreview(await api.get(`/preview?path=${encodeURIComponent(first)}`))
          setBundlePath(first)
          if (picked.length > 1) {
            const combined = []
            const totals = { sessions: 0, refs: 0, missing: 0 }
            const perBundle = []
            for (const path of picked) {
              const name = path.split(/[\\/]/).pop()
              const result = await api.get(`/check?${checkQuery(path)}`)
              perBundle.push({ path, name })
              totals.sessions += result.sessions || 0
              totals.refs += result.totalRefs || 0
              totals.missing += result.totalMissing || 0
              for (const entry of result.comparisons || []) {
                combined.push({ ...entry, bundle: name, bundlePath: path })
              }
            }
            setCheck({ comparisons: combined, problems: [], sessions: totals.sessions, totalRefs: totals.refs, totalMissing: totals.missing })
            setMulti(perBundle)
            return
          }
          setMulti(null)
          setCheck(await api.get(`/check?${checkQuery(first)}`))
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        } finally {
          setChecking(false)
        }
      }

      // Once an import finishes the uploaded copies are consumed: clear the
      // selection so a second run cannot point at deleted inbox files.
      useEffect(() => {
        if (task && task.phase === 'done' && task.kind === 'import') {
          setScanPicked(new Set())
          setMulti(null)
        }
      }, [task])

      const load = async (path) => {
        setCheck(null)
        setLoadError(null)
        setPreview(null)
        try {
          const value = await api.get(`/preview?path=${encodeURIComponent(path)}`)
          setPreview(value)
          // Keep only real overrides: an entry equal to the original path would
          // read as "override" and pin the target back to the old location.
          setRemap((previous) => {
            const next = {}
            for (const workspace of value.workspaces || []) {
              const key = workspace.path
              const kept = previous ? previous[key] : undefined
              if (typeof kept === 'string' && kept.trim().length > 0 && kept.trim() !== key) next[key] = kept
            }
            return next
          })
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }

      /** Native file dialog: the only way to point straight at a .dshmig file. */
      /** In-app file browser state: no native dialog is involved. */

      /** Native file dialog through the browser input, the same entry DSH uses. */
      /** Selected files wait here until the user confirms, never import directly. */
      const [scanned, setScanned] = useState(null)
      const [scanPicked, setScanPicked] = useState(new Set())
      const [multi, setMulti] = useState(null)
      const [scanCollapsed, setScanCollapsed] = useState(false)



      /**
       * Folder browse: the directory picker returns a REAL path, so bundles found
       * this way are read in place with no temp copy. That is why 0.7.0 showed the
       * true path, and it is kept as the primary entry for that reason.
       */
      const browseFolder = async () => {
        setLoadError(null)
        try {
          const dir = await pick()
          if (!dir) return
          const result = await api.get(`/scan?dir=${encodeURIComponent(dir)}`)
          const found = (result && result.bundles) || []
          setScanned({ dir, bundles: found })
          setScanCollapsed(false)
          const firstFresh = found.find((entry) => !(entry.total > 0 && entry.existing >= entry.total))
          setScanPicked(new Set(firstFresh ? [firstFresh.path] : []))
          if (found.length === 1) {
            setBundlePath(found[0].path)
            load(found[0].path)
          }
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }







      // Coming back from the install Session: restore the bundle the user had open.
      useEffect(() => {
        if (bundlePath) void load(bundlePath)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(() => {
        writeImportState({ bundlePath, remap, rootDir })
      }, [bundlePath, remap, rootDir])

      const pluginCard = preview && preview.plugins && (preview.plugins.list || []).length > 0
        ? h(
            'div',
            { style: C.card },
            h(
              'div',
              { style: C.cardTitle },
              preview.plugins.profile
                ? `${t('pluginsTitle')} · ${preview.plugins.profile}`
                : t('pluginsTitle'),
            ),
            h('div', { style: C.hint }, t('pluginsHint')),
            ...(preview.plugins.list || []).map((plugin) => {
              const command = installCommand(plugin, preview.plugins.profile)
              return h(
                'div',
                { key: plugin.name, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' } },
                h('span', { style: { ...C.mono, flex: 1, wordBreak: 'break-all' } }, `${plugin.name} ${plugin.spec}`),
                h('span', { style: C.badge }, pluginTypeLabel(t, plugin.type)),
                command ? h(CopyButton, { t, text: command }) : null,
              )
            }),
            canInstallSession && installable.length > 0
              ? h(
                  'div',
                  { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 8, paddingTop: 8 } },
                  h('div', { style: C.cardTitle }, t('installSection')),
                  h('div', { style: C.hint }, t('installSectionHint')),
                  ...installable.map((plugin) =>
                    h(
                      'label',
                      { key: `install-${plugin.name}`, style: { ...C.label, fontWeight: 400 } },
                      h(Checkbox, {
                        checked: installSelection.has(plugin.name),
                        onChange: () => {
                          const next = new Set(installSelection)
                          if (next.has(plugin.name)) next.delete(plugin.name)
                          else next.add(plugin.name)
                          setInstallSelection(next)
                        },
                      }),
                      h('span', { style: C.mono }, plugin.name),
                      h('span', { style: { ...C.hint, marginLeft: 6, padding: 0 } }, plugin.spec),
                    ),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6 } },
                    h(
                      'button',
                      {
                        style: installSelection.size === 0 ? { ...C.primary, ...C.primaryOff } : C.primary,
                        disabled: installSelection.size === 0,
                        onClick: async () => {
                          const chosen = installable.filter((plugin) => installSelection.has(plugin.name))
                          if (chosen.length === 0) return
                          const label = `${preview.plugins.profile || ''} · ${bundlePath}`
                          const prompt = buildInstallPrompt(t, label, preview.plugins.profile, chosen)
                          // Machine setup belongs in its own Workspace, not in a project.
                          let workspaceId
                          try {
                            const target = await api.post('/setup-workspace', {})
                            workspaceId = target && target.id
                          } catch {
                            workspaceId = undefined
                          }
                          startSession(workspaceId, { prompt, whenDraftExists: 'append' })
                        },
                      },
                      t('createInstallSession'),
                    ),
                    installSelection.size === 0 ? h('span', { style: C.hint }, t('installNone')) : null,
                  ),
                )
              : null,
          )
        : null

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
              )
            : h('div', { style: C.hint }, t('noBundles')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              style: { ...C.input, flex: 1 },
              title: bundlePath,
              value: bundlePath,
              placeholder: 'D:\\path\\to\\dsh-migration-…',
              onChange: (event) => setBundlePath(event.target.value),
              spellCheck: false,
            }),
            h('button', { style: C.button, onClick: browseFolder }, t('browseFolder')),
          scanned && scanned.bundles.length > 0
            ? h('div', { style: { ...C.card, flexBasis: '100%', marginTop: 8 } },
                h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                  h('div', { style: C.cardTitle }, t('scanTitle')),
                  h('button', {
                    style: C.linkButton,
                    onClick: () => setScanCollapsed((value) => !value),
                  }, scanCollapsed ? t('scanExpand') : t('scanClose')),
                ),
                scanCollapsed
                  ? null
                  : h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 170, overflowY: 'auto' } },
                        ...scanned.bundles.map((bundle) => {
                          const fullyImported = bundle.total > 0 && bundle.existing >= bundle.total
                          return h('label', {
                            key: bundle.path,
                            style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' },
                            title: bundle.path,
                          },
                            h('input', {
                              type: 'checkbox',
                              checked: scanPicked.has(bundle.path),
                              onChange: () => {
                                const next = new Set(scanPicked)
                                if (next.has(bundle.path)) next.delete(bundle.path)
                                else next.add(bundle.path)
                                setScanPicked(next)
                                setMulti(null)
                                if (next.size === 1 && next.has(bundle.path)) setBundlePath(bundle.path)
                              },
                            }),
                            h('span', { style: { ...C.mono, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' },
                              fontWeight: bundle.path === bundlePath ? 600 : 400 },
                              bundle.name),
                            h('span', { style: C.hint }, `${bundle.sessions} ${t('sessions')} · ${fmtBytes(bundle.bytes || 0)}`),
                            fullyImported
                              ? h('span', { style: C.ok }, t('scanImported'))
                              : bundle.existing > 0
                                ? h('span', { style: C.warn }, t('scanPartial').replace('{n}', `${bundle.existing}/${bundle.total}`))
                                : null,
                          )
                        }),
                      ),
                      h('span', { style: C.hint }, t('scanHint')),
                    ),
              )
            : null,
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
                  `${check.sessions} ${t('sessions')} · ${check.totalRefs} ${t('refs')} · ${check.totalMissing} ${t('missingRefs')}${check.plugins > 0 ? ` · ${check.plugins} ${t('pluginsCount')}` : ''}`,
                )
              : null,
          ),
          check && check.advice ? h('div', { style: C.warn }, `${t('attachmentAdvice')}: ${check.advice}`) : null,
          check && (check.comparisons || []).length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6 } },
                h('div', { style: C.cardTitle }, t('sessionsDiff')),
                ...comparisonGroups(t, check.comparisons || [], sessionChoices, setSessionChoices),
                (check.comparisons || []).length > 8
                  ? h('div', { style: C.hint }, t('sessionsDiffMore').replace('{n}', String(check.comparisons.length - 8)))
                  : null,
              )
            : null,
          check && check.problems.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 150, overflowY: 'auto' } },
                ...check.problems.map((problem) =>
                  h('div', { key: problem.id, style: C.hint }, `• ${problem.title || problem.id} — ${problem.missing}/${problem.refs}`),
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
        preview
          ? h(
              'div',
              { style: C.card },
              h('div', { style: C.cardTitle }, t('crossOsTitle')),
              h(
                'div',
                { style: preview.crossOs ? C.warn : C.hint },
                preview.crossOs
                  ? t('crossOsLine')
                      .replace('{from}', preview.bundleStyle === 'win' ? 'Windows' : 'macOS/Linux')
                      .replace('{to}', preview.localStyle === 'win' ? 'Windows' : 'macOS/Linux')
                  : t('crossOsOk'),
              ),
              preview.crossOs && preview.illegalNames > 0
                ? h('div', { style: C.warn }, t('crossOsIllegal').replace('{n}', String(preview.illegalNames)))
                : null,
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
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('input', {
                    style: { ...C.input, flex: 1 },
                    title: rootDir,
                    value: rootDir,
                    placeholder: posixTarget ? '/home/<user>/dsh' : 'E:\\DSH',
                    onChange: (event) => applyRoot(event.target.value),
                    spellCheck: false,
                  }),
                  canPick
                    ? h('button', {
                        style: C.button,
                        onClick: async () => {
                          const dir = await pick()
                          if (dir) applyRoot(dir)
                        },
                      }, t('browse'))
                    : null,
                ),
                h('div', { style: C.hint }, t('importRootHint')),
              ),
              ...(preview.workspaces || []).map((workspace) => {
                const override = remap[workspace.path]
                const target = override && override.trim()
                  ? override
                  : rootDir.trim()
                    ? joinTarget(rootDir.trim(), workspace.title, posixTarget ? '/' : '\\')
                    : workspace.path
                return h(
                  'div',
                  { key: workspace.id, style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                    h('span', { style: C.rowTitle }, workspace.title),
                    h('span', { style: C.badge }, `${workspace.sessions} ${t('sessionCount')} · ${fmtBytes(workspace.bytes || 0)}`),
                  ),
                  h('div', { style: C.mono, title: workspace.path }, `${t('from')}: ${workspace.path}`),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    h('div', { style: { ...C.mono, flex: 1, wordBreak: 'break-all' }, title: target }, `${t('newPath')}: ${target}`),
                    canPick
                      ? h('button', {
                          style: C.button,
                          onClick: async () => {
                            const dir = await pick()
                            if (!dir) return
                            setRemap({ ...remap, [workspace.path]: dir })
                          },
                        }, t('changePath'))
                      : null,
                    override && override.trim()
                      ? h('button', {
                          style: C.linkButton,
                          onClick: () => {
                            const next = { ...remap }
                            delete next[workspace.path]
                            setRemap(next)
                          },
                        }, t('resetPath'))
                      : null,
                  ),
                )
              }),
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
                  onClick: () => {
                    const decisions = {}
                    for (const entry of check?.comparisons || []) {
                      if (entry.verdict === 'packAhead') decisions[entry.id] = sessionChoices[entry.id] || 'append'
                      else if (entry.verdict === 'diverged') decisions[entry.id] = sessionChoices[entry.id] || 'fork'
                    }
                    run('import', multi && multi.length > 1
                      ? {
                          bundlePaths: multi.map((entry) => entry.path),
                          remap,
                          rootDir: rootDir.trim() || null,
                          rewritePaths,
                          includeFiles,
                          includeAttachments,
                          overwriteFiles,
                          sessionDecisions: decisions,
                        }
                      : {
                          bundlePath,
                          remap,
                          rootDir: rootDir.trim() || null,
                          rewritePaths,
                          includeFiles,
                          includeAttachments,
                          overwriteFiles,
                          sessionDecisions: decisions,
                        })
                  },
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
        pluginCard,
        inventory && inventory.lastImport
          ? h(
              'div',
              { style: C.card },
              h('div', { style: C.cardTitle }, t('undoLastTitle')),
              h('div', { style: C.hint }, t('undoLastHint')),
              h(
                'div',
                { style: C.hint },
                `${fmtTime(inventory.lastImport.at)} · ${(inventory.lastImport.workspaces || []).length} ${t('projects')} · ${(inventory.lastImport.sessions || []).length} ${t('sessions')}`,
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h(
                  'button',
                  { style: undoBlocked ? { ...C.button, ...C.primaryOff } : C.button, disabled: undoBlocked, onClick: undoLast },
                  t('undoLastDo'),
                ),
                undoLastNote ? h('span', { style: C.ok }, undoLastNote) : null,
                undoBlocked && lastImportProbe ? h('span', { style: C.warn }, t('undoLastBlocked').replace('{n}', String((lastImportProbe.changed || []).length))) : null,
              ),
            )
          : null,
      )
    }

    function MigrateSection(props) {
      const t = props.t
      const { pick, canPick, startSession, canInstallSession } = props
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
        inventory && Number(inventory.codeVersion) < 13
          ? h('div', { style: C.warn }, t('hostTooOld'))
          : null,
        tab === 'export'
          ? h(ExportPane, { t, inventory, reload: load, pick, canPick })
          : h(ImportPane, { t, inventory, reload: load, pick, canPick, startSession, canInstallSession }),
        h(
          'div',
          { style: { ...C.hint, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
          h('div', {}, `${t('supportFeedback')}：${SUPPORT_EMAIL}`),
          DONATE_URL
            ? h(
                'div',
                { style: { paddingTop: 4 } },
                h(
                  'a',
                  { href: DONATE_URL, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-brand-primary)' } },
                  t('supportDonate'),
                ),
              )
            : null,
        ),
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

        // uiWorkspace is an optional client service. Read it only through the
        // optional API: touching ctx.uiWorkspace directly throws "cannot get
        // property ... without inject" on cordis contexts that do not declare
        // it, which used to fail the whole web boot (issue #2).
        let dirService = null
        try {
          dirService = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') ?? null : null
        } catch {
          dirService = null
        }
        const desktopPicker = globalThis.__DSH_DIRECTORY_PICKER__
        const canPick =
          Boolean(desktopPicker && typeof desktopPicker.pick === 'function') ||
          Boolean(dirService && typeof dirService.pickDirectory === 'function')

        // The Host composes its picker as "native" on desktop, so there is no
        // browse capability to drive and no way to pass a start directory; the
        // OS chooser decides where it opens.
        const pick = async () => {
          try {
            if (desktopPicker && typeof desktopPicker.pick === 'function') return (await desktopPicker.pick()) ?? null
            if (dirService && typeof dirService.pickDirectory === 'function') {
              return (await dirService.pickDirectory()) ?? null
            }
          } catch {
            /* the caller keeps its previous value when the chooser fails */
          }
          return null
        }

        const canInstallSession = Boolean(dirService && typeof dirService.startSession === 'function')
        const startSession = (workspaceId, options) => {
          try {
            dirService.startSession(workspaceId, options)
          } catch {
            /* the new-Session action lives in the shell; nothing to recover here */
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
          return h(MigrateSection, { t, pick, canPick, startSession, canInstallSession })
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


