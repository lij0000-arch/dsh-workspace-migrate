# 发布到社区：现状、路线与清单

> 调研时间：2026-10-21。以下结论来自 npm registry、`awesome-dsh-plugin` 的 `contributing.md`，以及 DSH 自带的 `dsh-plugin-market-index` 校验器源码。

## 一、先看清赛场

DSH 已经有一个很成熟的第三方插件生态，不是荒地：

| 事实 | 数字/来源 |
|---|---|
| 社区精选目录 | `awesome-dsh-plugin.com`，`plugins.json` 里 **6254** 个条目 |
| 收录方式 | 向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR，加一个 YAML 文件 |
| 收录后如何被装 | `dshmarket`（可视化市场）+ Discover 索引源 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` |
| 分类 | `agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun` |

**同类插件已经不少**，而且都很能打：

- `dsh-session-migrate` — 会话跨版本迁移，扫描旧日志、改写 header cwd、落盘
- `dsh-config-manager` — 整套配置备份/导入/迁移（设置、插件、MCP、技能、工作区），密钥 AES 加密
- `dsh-backup-sync` — 技能/插件/配置/记忆/待办/会话打 tar.gz，三方合并导入
- `dsh-home-migrate`（即 npm 上的 `dsh-migrate`）— 跨机器 `.dshmig` 归档，同 OS、新建 profile
- `@xiaoyuyu6420/dsh-backup` — 备份/恢复 `~/.dsh`，带面板与 GitHub 私有仓库同步
- `dsh-plugin-porter` / `dsh-packer` — 插件与 Agent 资产的跨机搬运

按收录规则第 4 条：**同类并存时「谁更好谁上」，先来者只是平局排序依据。** 所以关键不是「能不能发」，而是**差异点够不够硬**。

### 我们真正不一样的三点

1. **按工作区迁移**，不是按整机/整个 home：勾选项目 → 连带它的会话、归属、置顶/归档、项目文件、附件。别的工具多是「全量」或「单会话」。
2. **显式的旧路径 → 新路径映射表**：换盘符（`D:` → `C:`）不用新建 profile，也不用保持同路径。
3. **走公开服务重建而非覆盖文件**：`sessionPersistence.create/append` + `workspaceRegistry.create/attachSession`，所以目标机已有数据时是安全合并（同名会话跳过、不覆盖），并且导出→导入→再导出**事件哈希一致**（本机实测 537 事件）。

这三点必须写进描述里，否则评审完全可以把我们判成第四个「备份迁移」插件。

## 二、两条发布路线

| | 路线 A：发 npm | 路线 B：只用 GitHub |
|---|---|---|
| 需要账号 | npm（可用 GitHub 一键注册） | 只用 GitHub |
| 社区目录收录 | ✅ | ✅（3022/6254 条就是这么发的） |
| 预构建安装（免构建授权） | ✅ | ✅ 用 Release tarball |
| 内置 Discover 里能搜到 | ✅（format 1 索引只收 npm 版本） | ❌（但 dshmarket 与目录站仍展示） |
| 一键安装命令 | `dsh plugin add dsh-workspace-migrate` | `dsh plugin add github:lij0000-arch/dsh-workspace-migrate` 或 tarball URL |
| 升级感知 | 有版本号可比 | 无版本号，靠提交/Release |

**只有「内置 Discover 搜索」这一项真正依赖 npm。** 其余曝光（awesome 目录站、dshmarket 插件市场）两条路线一样。

### 路线 A：发 npm 包（推荐）

#### 1. 发 npm 包

社区市场按 npm 包安装，预构建安装还能跳过 `allowBuilds` 构建授权。包名建议：

- `dsh-workspace-migrate` —— 目前 **npm 上未被占用**，名字直接对应差异点
- 或 `@<你的npm用户名>/dsh-migrate` —— scoped 名永远可用，也不怕以后撞名

注意 `dsh-migrate` 已被占用（配置迁移工具），`dsh-session-migrate`、`dsh-portable` 也已被占。

包规范（`package.json`）：

```jsonc
{
  "name": "dsh-workspace-migrate",
  "version": "0.1.0",
  "private": false,                 // 必须
  "type": "module",
  "license": "MIT",
  "keywords": ["dsh-plugin", "deepseek-harness", "migration", "workspace", "session"],
  "engines": { "dsh": "^0.2.1-rc.2" },   // 装的时候会校验，不满足直接拒装
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md", "LICENSE"],
  "exports": { ".": "./index.js", "./client": "./client.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 必须：没有它就不是可安装插件
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
  }
}
```

> ⚠️ 最常见的被拒原因：只声明了 `dsh.client`、没有 `dsh.bundle.patch`。我们两者都有。

发布前必做：`pnpm pack` 后**检查 tarball 里的文件清单**（`files` 对 link 安装不生效，但对发布生效）。本仓库已实测：9 个文件、18.1 KB，图标/语言包/补丁齐全。

### 2. 建 GitHub 仓库

- 仓库要**满 1 天**才能提交收录（CI 自动查）
- 给仓库加 **`dsh-plugin`** topic
- 仓库里就是这份源码（`package.json` + `cordis.patch.yml` + `index.js` + `client.js` + `locale/` + `icon.svg`）

### 3. 提 awesome PR

只加**一个文件**：`data/plugins/lij0000-arch__<repo>.yml`，内容见 [awesome-entry.yml](awesome-entry.yml)。修完 README 由 CI 生成，不要手改 README。

可选但推荐：把预构建 tarball 挂到 GitHub Release，在 YAML 里加 `tarball:` 字段，市场会优先展示它。

### 路线 B：只用 GitHub（没有 npm 账号）

1. **建仓库**：仓库根目录必须就是插件根目录（`package.json` 在根上），否则 `github:lij0000-arch/<repo>` 装不上。
2. **打 tarball 挂 Release**：
   ```powershell
   node <runtime>\pnpm\bin\pnpm.cjs pack --pack-destination dist
   # 把 dist\dsh-workspace-migrate-0.1.0.tgz 作为 v0.1.0 的 Release 资产上传
   ```
3. **PR 用 [awesome-entry.yml](awesome-entry.yml)**：已切成 GitHub 版本，带 `tarball:` 字段，把 `lij0000-arch` 换成你的 GitHub 用户名即可。
4. **用户安装**：
   ```powershell
   # 预构建（推荐，快且不触发构建授权）
   dsh plugin --profile web add https://github.com/lij0000-arch/dsh-workspace-migrate/releases/download/v0.1.0/dsh-workspace-migrate-0.1.0.tgz
   # 或直接从仓库装
   dsh plugin --profile web add github:lij0000-arch/dsh-workspace-migrate
   ```

仓库要满 1 天才能提 PR。本插件没有构建步骤，`github:` 安装拉到源码即可直接跑。

## 三、收录规则里最容易踩的几条

| 规则 | 对我们的影响 |
|---|---|
| 描述必须与代码一致，评审会核对 | 不要写「自动迁移所有数据」这类笼统话；写清工作区/会话/文件/附件、路径映射、合并语义 |
| 不许纯聚合包 | 我们有自己的行为，没问题 |
| 仓库满 1 天、加 topic、有真实代码 | 按流程做 |
| 已被覆盖则比谁更好 | 描述里必须点出「按工作区 + 路径重映射 + 合并式还原」 |
| 分类要贴实际 | 建议 `session`（会话与消息）；若维护者改到 `tools`/`dev` 也可接受 |

## 四、备选：自建索引，不进精选目录也能被发现

DSH 0.2.1+ 的 **插件 → 发现（Discover）→ 索引源** 可以添加任意 format 1 索引 URL。把 [index.json](index.json) 放到 GitHub Pages / jsDelivr / 任意 https 静态地址即可，用户添加后就能在 Discover 里搜到并一键安装。

索引必须是合法 format 1（`dsh-plugin-market-index` 校验）：

```jsonc
{
  "format": 1,
  "title": { "en": "...", "zh": "..." },      // 对象形式必须含 en
  "metadata": { "categories": { "session": { "title": { "en": "...", "zh": "..." } } } },
  "plugins": [{
    "name": "dsh-workspace-migrate",           // npm 包名
    "title": { "en": "...", "zh": "..." },
    "description": { "en": "...", "zh": "..." },
    "author": "...",
    "homepage": "https://github.com/lij0000-arch/<repo>",
    "repository": { "url": "https://github.com/lij0000-arch/<repo>" },
    "metadata": { "category": "session", "keywords": ["migration"] },
    "versions": [{
      "version": "0.1.0",
      "publishTimestamp": 1792540800,          // Unix 秒，整数
      "source": { "type": "npm" },             // 或 { "type": "git", "url": "...", "commit": "<40位sha>" }
      "engines": { "dsh": "^0.2.1-rc.2" }
    }]
  }]
}
```

## 五、发布前自查清单

- [ ] `pnpm pack` 后 tarball 含 7 类文件：`index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`、`LICENSE`
- [ ] 在一台**没装过**的机器上 `dsh plugin --profile web add <包名>` 能装能启用（这一步没有第二台机就只能靠 tarball + 新 profile 验证）
- [ ] README 写清：能力边界、会写哪些目录、`rollback` 只删本次导入创建的对象、凭据不迁移
- [ ] 隐私说明：迁移包含完整对话与项目文件，导出目录不要放公开位置
- [ ] 版本号从 `0.1.0` 起；npm 上发过的版本不能重发
- [ ] `engines.dsh` 与实际支持范围一致（当前实测 `0.2.1-rc.2`）

## 六、发布前的准备状态

- [x] 改包名 `@local/dsh-migrate` → `dsh-workspace-migrate`（含 `client.js` 模块 id、`cordis.patch.yml` 的 row `name`）
- [x] 补 `license` / `engines.dsh` / `keywords` / `files`，生成 LICENSE
- [x] `pnpm pack` 校验：9 个文件、18.1 KB，`docs/` 不进包
- [x] 在本机重装（link）验证通过：`dsh-workspace-migrate` 已挂载，接口 `codeVersion=6` 正常，设置页入口 `migration` 仍在
- [x] `pnpm publish --dry-run` 通过（`📦 dsh-workspace-migrate@0.1.0 → https://registry.npmjs.org/`）
- [ ] `npm login` 后 `npm publish --access public`
- [ ] 建 GitHub 仓库（加 `dsh-plugin` topic）并提 awesome PR
- [ ] 在第二台机器或干净 profile 上验证一次 `dsh plugin add dsh-workspace-migrate`
