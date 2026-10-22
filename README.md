# dsh-workspace-migrate

把一台电脑上的 DeepSeek Harness 状态整体搬到另一台：工作区（项目列表与会话归属）、项目成果（项目目录里的文件）、对话内容（完整会话事件流），以及可选的图片附件。

## 用之前先知道

迁移包是**文件夹**，不是压缩包；拷走整个文件夹即可（U 盘、网盘、局域网都行）。

两边机器需要装同一个插件。导出时插件会把自己复制进迁移包的 `plugin/dsh-migrate/`，新电脑上从这个目录安装即可。

## 安装

**先确认 profile**：插件按 profile 隔离，**你现在用的界面是哪个 profile，就必须装到哪个**。装错的表现是「装好了，但设置里看不到这个页签」。

- DSH 桌面端 App → 一般是 `desktop`
- 命令行 `dsh web` → `web`
- 不确定时，在会话里执行 `echo $env:DSH_PROFILE`（PowerShell）或 `echo $DSH_PROFILE`（bash）

安装方式：

- **从 GitHub Release（推荐）**
  ```powershell
  dsh plugin --profile <你的 profile> add https://github.com/lij0000-arch/dsh-workspace-migrate/releases/download/v0.3.0/dsh-workspace-migrate-0.3.0.tgz
  ```
- **从本地文件夹或 tgz**
  ```powershell
  dsh plugin --profile <你的 profile> add "D:\path\to\dsh-migrate"
  ```
  命令行装完要重启 DSH（新装的包在启动时加载）。
- **在界面里装**：设置 → 插件 的安装入口；或在一个对话里让 agent 用 `plugin_manager` 安装，返回 `application: applied` 后刷新页面即可，无需重启。
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

## 增量同步（0.2.0+）

第一次导出之后，可以让同一个迁移包保持最新，而不是每次整包重拷：

- 设置 → 迁移 → 导出 → **增量更新已有迁移包**，从列表选一个包，或直接填包的路径
- 只复制**新增或修改过**的文件；源里删掉的文件会同步从包里删除
- 会话按其源日志的字节数与事件数判断：没变化的会话直接复用，不重新编码
- 增量范围固定为这个包原本包含的工作区，不会把别的项目卷进来

实测：改 1 个 / 删 1 个 / 加 1 个 → `copied=2 removed=1 unchanged=0`；紧接着再跑一次 → `copied=0 unchanged=2`；空闲会话 → `reused=1`、`sessionBytes=0`。

判断变更用「文件大小 + 修改时间」：内容变了但大小和时间都没变的文件不会被识别（正常编辑不会出现）。

## 新电脑：导入

1. 装好 DSH，从迁移包的 `plugin/dsh-migrate/` 安装本插件
2. 设置 → 迁移 → **导入（新电脑）**
3. 选择迁移包，读取清单
4. 填**导入到（新根目录）**，比如 `E:\DSH`：每个项目会自动建在 `E:\DSH\<项目名>` 下，目录不存在就创建；下面每一行仍可单独改路径
5. 勾选**重写对话里提到的旧路径**（默认开）
6. 开始导入；结束后看报告里的导入数、重写数、未归属数和提醒

### 为什么要重写旧路径

会话历史里的工具调用、文件引用、报错信息都写着旧机器的绝对路径（`D:\...`）。只改工作目录不改这些，续聊时模型会去找不存在的文件——这就是「对话变乱」的根因。导入时会把被重映射的根路径在事件数据里整体替换成新路径，并报告替换了多少处。

实测：把 `D:\Deepseek Workspace migration` 迁到 `D:\...\_rt\root\Deepseek Workspace migration` → 报告 `rewritten=1054`，导出后检查会话内容确认工具调用、`cwd`、文件引用都指向新根。

导入通过 Harness 的公开服务（`sessionPersistence` / `workspaceRegistry`）重建，不是覆盖文件，所以：

- 已有同名会话会跳过，不会覆盖
- fork 出来的会话会把父会话前缀展开成独立会话
- 归档/置顶状态会尽量恢复
- 导入错了可以用「撤销这次导入」按本次报告里的 id 回滚
- 报告里的「未归属项目的会话」表示该会话的 cwd 不落在任何项目目录，检查一下路径映射即可

## 导入前体检

会话里引用过的图片/文件如果在新机器上不存在，续聊时请求会在准备阶段失败（表现为「DeepSeek Messages transport failed」）。导入页的 **导入前体检** 会先把包里每个会话的附件引用扫一遍，对照本机 `~/.dsh/attachments` 报告缺多少、涉及哪些会话。

```
1 个会话 · 37 个附件引用 · 6 个缺失
建议：包内带了 attachments 目录，勾选「包含图片附件」即可补齐
• session-xxxx — 6/37
```

导入时若没勾选附件、且会话确实有缺失，报告里也会写「缺失附件的会话: N」。修法：把旧机器的 `~/.dsh/attachments` 整个拷到新机器同名位置，**重启 DSH**，这些会话即可续聊（附件引用是内容寻址的，文件到位就解析得到）。

## 清理失效项目

导出页的「清理失效项目」会删掉**路径已不存在且没有任何会话**的项目登记。用于导入后目标目录被移动或删除的情况。

## 限制

- **日志格式有方向性**：旧版本导出的包可以被新版本导入（后端会自动迁移），反过来不行。两台机器的 DSH 版本差距越大，越建议先把旧机升级到同一版本再导出。
- **凭据不迁移**：`~/.dsh/.credentials.yaml` 不在包里，新电脑需要重新登录。
- **插件不自动装**：`~/.dsh/profiles/*` 里的插件组合不会自动还原，需要在新电脑上重新装（插件源码随包带走的只有它自己）。
- 导出目录不能落在被导出的项目里面；这种情况会跳过该项目的文件并给出提醒。

## 开发

- `index.js`：Host 半边。注册 `sessionPersistence` / `workspaceRegistry` / `webServer`，在 `/api/dsh-migrate` 下提供 `inventory` / `preview` / `export` / `import` / `task` / `rollback`。
- `client.js`：Client 半边。注册 `settings.section` 的 `migration` 页签，纯 React 无构建。
- 改完 `index.js` 需要在插件页把本插件关掉再打开，模块才会重新加载；`client.js` 一般刷新页面即可。
