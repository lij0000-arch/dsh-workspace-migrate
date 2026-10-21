# dsh-workspace-migrate

把一台电脑上的 DeepSeek Harness 状态整体搬到另一台：工作区（项目列表与会话归属）、项目成果（项目目录里的文件）、对话内容（完整会话事件流），以及可选的图片附件。

## 用之前先知道

迁移包是**文件夹**，不是压缩包；拷走整个文件夹即可（U 盘、网盘、局域网都行）。

两边机器需要装同一个插件。导出时插件会把自己复制进迁移包的 `plugin/dsh-migrate/`，新电脑上从这个目录安装即可。

## 安装

- **从 npm**（发布后）：`dsh plugin --profile web add <包名>`，或 设置 → 插件 里搜索安装
- **从迁移包**：用包里 `plugin/dsh-migrate/` 这个目录安装
- **本地开发**：profile 以 `link:` 依赖本目录；改完 `index.js` 要在插件页把本插件关掉再打开才会重新加载，`client.js` 刷新页面即可

## 能力与边界

- **读**：`~/.dsh/sessions`（会话事件流）、`~/.dsh/storages/workspace.json`（项目登记、置顶/归档集合）、`~/.dsh/attachments`、以及所选项目目录
- **写**：经公开服务新建会话与项目登记（`sessionPersistence` / `workspaceRegistry`）、按路径映射复制项目文件与附件
- **删**：只有「撤销这次导入」会删，而且只删**本次进程内由本插件创建**的项目登记与会话目录，其它 id 一律拒绝
- **网络**：不向外发起请求；仅在本机 `127.0.0.1` 注册 `/api/dsh-migrate` 供当前页面调用，并校验请求来源
- **凭据**：不读取、不导出 `~/.dsh/.credentials.yaml`
- **隐私**：迁移包含完整对话与项目文件，导出目录不要放在公开位置

## 旧电脑：导出

1. 设置 → 迁移 → **导出（旧电脑）**
2. 勾选要带走的工作区（默认全选），按需勾选「同时打包项目文件」「同时打包图片附件」
3. 导出位置留空则写到 `~/.dsh/migrations/dsh-migration-<时间>/`
4. 完成后把整个文件夹拷到新电脑

不带项目文件时只打包对话；带项目文件时按目录排除 `node_modules`、`.git`、`.venv`、`__pycache__` 等可重建目录。

## 新电脑：导入

1. 装好 DSH，从迁移包的 `plugin/dsh-migrate/` 安装本插件
2. 设置 → 迁移 → **导入（新电脑）**
3. 选择迁移包，读取清单
4. 逐个项目填新路径（新机器没有 `D:` 盘就换成 `C:\...`；目录不存在会自动创建）
5. 开始导入；结束后看报告里的导入数、跳过项和提醒

导入通过 Harness 的公开服务（`sessionPersistence` / `workspaceRegistry`）重建，不是覆盖文件，所以：

- 已有同名会话会跳过，不会覆盖
- fork 出来的会话会把父会话前缀展开成独立会话
- 归档/置顶状态会尽量恢复
- 导入错了可以用「撤销这次导入」按本次报告里的 id 回滚

## 限制

- **日志格式有方向性**：旧版本导出的包可以被新版本导入（后端会自动迁移），反过来不行。两台机器的 DSH 版本差距越大，越建议先把旧机升级到同一版本再导出。
- **凭据不迁移**：`~/.dsh/.credentials.yaml` 不在包里，新电脑需要重新登录。
- **插件不自动装**：`~/.dsh/profiles/*` 里的插件组合不会自动还原，需要在新电脑上重新装（插件源码随包带走的只有它自己）。
- 导出目录不能落在被导出的项目里面；这种情况会跳过该项目的文件并给出提醒。

## 开发

- `index.js`：Host 半边。注册 `sessionPersistence` / `workspaceRegistry` / `webServer`，在 `/api/dsh-migrate` 下提供 `inventory` / `preview` / `export` / `import` / `task` / `rollback`。
- `client.js`：Client 半边。注册 `settings.section` 的 `migration` 页签，纯 React 无构建。
- 改完 `index.js` 需要在插件页把本插件关掉再打开，模块才会重新加载；`client.js` 一般刷新页面即可。
