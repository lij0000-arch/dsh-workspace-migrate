# dsh-workspace-migrate

[![npm](https://img.shields.io/npm/v/dsh-workspace-migrate)](https://www.npmjs.com/package/dsh-workspace-migrate)
[![DSH Plugin Store](https://img.shields.io/badge/DSH%20Plugin%20Store-listed-4C8DFF)](https://www.dshplugin.store/plugin/lij0000-arch/dsh-workspace-migrate)
[![dshopen](https://img.shields.io/badge/dshopen.org-listed-2EA44F)](https://dshopen.org/plugins/dsh-workspace-migrate)
[![release](https://img.shields.io/github/v/release/lij0000-arch/dsh-workspace-migrate?label=release)](https://github.com/lij0000-arch/dsh-workspace-migrate/releases)
[![license](https://img.shields.io/github/license/lij0000-arch/dsh-workspace-migrate)](LICENSE)

把一台电脑上的 **工作区、对话记录、项目文件** 打包带走，在另一台电脑上还原，接着聊。

不是复制 `~/.dsh` 目录——会话通过 Harness 的官方服务重建，所以新机器上的侧栏、标题、归档状态、附件引用都是正常的，而不是一堆打不开的文件。

> 官方仓库：**https://github.com/lij0000-arch/dsh-workspace-migrate**。npm 包名 `dsh-workspace-migrate` 仅由本仓库发布；其它同名仓库是该项目的派生版本。

## 安装

一条命令，包只来自 npm：

```bash
dsh plugin --profile desktop add dsh-workspace-migrate
```

`--profile` 指定装进哪个 profile（桌面端是 `desktop`，`dsh web` 通常是 `web`；profile 名就是 `~/.dsh/profiles` 下的目录名）。多个 profile 各装一次即可。

> 0.9.1 及更早版本存在已知缺陷：导入分叉会话后无法读取。建议直接使用 **0.10.1** 或更高版本。

装完在 **设置 → 迁移到另一台电脑** 里使用。要求 DSH `>=0.2.1-rc.2 <0.3.0 || >=0.2.2-rc.1 <0.3.0 || >=0.2.3-alpha.1 <0.3.0`。

## 三步迁移

![导出（旧电脑）：勾选工作区，选目标系统](https://raw.githubusercontent.com/lij0000-arch/dsh-workspace-migrate/main/docs/images/export-page.png)

**① 旧电脑导出**：勾选要带走的工作区 → 选**目标系统**（另一台是 Mac 就选 macOS，路径分隔符和非法文件名会自动处理）→ 开始导出。

导出结果是一个目录，每个项目一个 `.dshmig` 文件（其实是个 ZIP），连同项目文件一起打包。

**② 拷过去**：U 盘、网盘、局域网都行。

![导入（新电脑）：选目录、勾包、体检](https://raw.githubusercontent.com/lij0000-arch/dsh-workspace-migrate/main/docs/images/import-check.png)

**③ 新电脑导入**：点【浏览…】选目录 → 勾选要导入的包（可多选）→ 填【导入到】→ 点【导入前体检】看结论 → 开始导入。

![导入完成：追加、分叉、重启提示](https://raw.githubusercontent.com/lij0000-arch/dsh-workspace-migrate/main/docs/images/import-done.png)

导入完成后**完全退出 DSH 再打开**（含托盘），侧栏和缓存才会完全刷新。

## 几种常见情况

**旧电脑还在用，想同步最新进展。**
用【增量更新已有迁移包】刷新同一个包，再导入到新电脑。同名会话会自动走「更新（只追加）」，只把新事件接到尾部；项目文件也按文件增量复制，不会覆盖你新电脑上改过的文件（除非勾选「目标目录非空时仍覆盖」）。

**两边各聊了一段，内容分叉了。**
体检会标出「两边都有新增」，你可以选【作为分叉】：两边内容都保留，新分支以官方分叉会话的形式挂在原会话下。

**目标会话正在用。**
DSH 的会话日志同一时间只允许一个写入者。目标会话开着或正在跑时追加会被拒绝，插件会重试并提示「请关闭该会话后重新导入」。

**导错了。**
底部有【撤销这次导入】：把这次**新建**的项目和会话移到 `~/.dsh/trash/`，可以手工找回。追加过的会话内容不会回退，所以导入后只要在会话里继续聊过，撤销按钮就会变灰。

## 能力与边界

**会在本地做的事**

- 读 `~/.dsh` 里的工作区登记与会话日志，读出项目文件、附件
- 导入时通过 `sessionPersistence` / `workspaceRegistry` 重建，不直接改数据库文件
- 路径改写：把旧机器的绝对路径换成新路径，否则续聊时模型会去找不存在的文件

**不会做的事**

- **不联网**：没有上传、没有遥测、没有远程接口，所有操作都在本机完成
- **不迁移凭据**：`~/.dsh/.credentials.yaml` 不进包，新机器需要重新登录
- **不执行安装**：插件清单只是文字，安装命令由你在对话里确认后执行
- **不删除会话**：DSH 没有删除 API；撤销只是移到 `~/.dsh/trash/`

**已知限制**

- 日志格式有方向性：旧版导出的包可以被新版导入，反过来不行；两台机器版本差得越多，越建议先统一版本
- 子代理会话不带（它们在 DSH 里本来就不显示）
- 跨系统的自动化测试覆盖了路径改写、分隔符转换、Windows 非法文件名清洗，但真机只有 Windows 验证过；迁到 Mac/Linux 建议先小批量试
- 体检的准确性依赖【导入到】目录：留空时路径比对只能用启发式，带空格的旧路径可能被判成「两边都有新增」

## 会话路径（本机功能）

设置页的 **「会话路径」** 标签页，用来在**本机**修改会话的工作目录，和跨电脑迁移完全独立：

![会话路径：按工作区分组，可单条或整体更换工作目录（示意图，演示数据）](https://raw.githubusercontent.com/lij0000-arch/dsh-workspace-migrate/main/docs/images/session-paths.png)

- 按工作区分组列出会话，分组可折叠；支持按标题或路径筛选
- 列表口径与侧栏一致：不显示子代理会话、已归档会话、空会话、已删除会话
- 两种改法：
  - **单条会话**：选中一条，填新目录（可浏览）
  - **整体更换**：点工作区分组的「整体更换」，把该目录下所有会话一起换到新路径，并重建工作区登记
- 整体更换时可勾选 **同时把项目文件复制到新路径**（递归复制，原目录保留）
- 可选 **同时改写对话里提到的旧路径**：历史消息、工具调用里的旧路径字符串一起替换
- 自动处理四件事：会话日志首行的 `cwd`、日志目录、投影缓存里的路径、工作区归属
- 安全约束：不能改当前正在使用的会话；目标目录必须存在且是目录；目标已有同名会话时拒绝覆盖
- 改动前自动备份到 `~/.dsh/trash/session-path-<时间>/`，可逐字节回滚
- **改完需要完全退出 DSH 再打开**，侧栏与投影才会刷新

如果重启后侧栏仍看不到会话，说明工作区登记表还是旧的：页面会给出离线修复脚本路径
（`~/.dsh/storages/dsh-migrate-fix-workspace.bat`），完全退出 DSH 后双击运行一次，再打开即可。
- `tools/fix-workspace-sessions.mjs`：离线修复脚本（DSH 关闭后运行），把「日志头已指向工作区路径、但登记表里没挂上」的会话补登记；顺带修复首帧多行等旧日志格式问题

## 兼容模式

某些会话导入后打不开，或打开后没法续聊。插件会在导入时**自动识别并处理**这类会话，不需要手动开关：

| 情况 | 原因 |
|---|---|
| 导入后提示「会话无法读取」 | 会话由旧版 DSH 写入，新版因压缩/请求记账校验不通过而拒绝加载 |
| 续聊报上下文超限 | 会话太长（几十万到几百万 token），整段历史装不进模型窗口 |

处理方式是：丢弃压缩与请求记账、把覆盖操作改成追加、按上下文预算只保留最近若干回合，并把回合序号重新从 1 编号。**会话头部（系统提示词等）始终保留**；万一头部缺失，会补一条受保护的 system/message，避免会话读回来之后聊一阵才报格式错误。消息与工具调用都保留，只是更早的历史不在应用里，原始迁移包仍完整保留。

结果卡片会写明本次做了哪些调整（例如「会话过长，已只保留最近 N 个回合」）。如果某条会话确实需要完整历史，可以在旧机器上把它拆成多个会话后再分别打包。

## 致谢

这个插件的不少改进来自使用者的反馈，感谢他们：

| 贡献 | 内容 |
|---|---|
| [@xinink](https://github.com/xinink) | 报告 Web 引导阶段插件加载失败（[#2](https://github.com/lij0000-arch/dsh-workspace-migrate/issues/2)），定位到 `inject` 未声明的 `uiWorkspace` 读取，已在 0.8.3 修复 |
| [@ChexLant](https://github.com/ChexLant) | 报告展开 fork 会话后导入不可读（[#3](https://github.com/lij0000-arch/dsh-workspace-migrate/issues/3)），定位到 unseeded 会话残留 `inherited` end-seed 标记，已在 0.10.0 修复 |

> 报告缺陷或提出建议被采纳后，会记在这里，同时写进对应版本的 Release 说明。

## 支持这个项目

这个插件是按用户反馈持续优化的：遇到问题、想要什么功能，直接发邮件到 **lij0000@sina.com**，不用客气。

如果迁移帮你省下了半天时间，也可以请我喝杯咖啡 ☕ —— [爱发电](https://afdian.com/a/J-Lee)。

赞助是纯自愿的：它不改变 MIT 许可，也不解锁任何私有功能。这个插件的全部能力都在这份代码里。

## 开发

- `index.js`：Host 半边。注册 `sessionPersistence` / `workspaceRegistry` / `webServer`，在 `/api/dsh-migrate` 下提供 `inventory` / `bundle-info` / `scan` / `preview` / `check` / `export` / `import` / `task` / `rollback` / `cleanup` / `setup-workspace` / `last-import`；「会话路径」是独立功能，走单独的 `/api/dsh-session-path`（`list` / `apply` / `workspace-apply` / `reconcile` / `make-fixer`）
- `client.js`：Client 半边。注册 `settings.section` 的 `migration` 页签，纯 React 无构建
- `tools/fix-workspace-sessions.mjs`：离线修复脚本（DSH 关闭后运行），把「日志头已指向工作区路径、但登记表里没挂上」的会话补登记；顺带修复首帧多行等旧日志格式问题

仓库只包含运行需要的文件。开发用的自检脚本（路由、客户端渲染、跨系统端到端、兼容模式等）不随包发布，也不在仓库里，因此这里不列具体命令。
## License

MIT
