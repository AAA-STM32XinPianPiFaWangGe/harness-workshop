# Harness 创意工坊（Harness Workshop）

> 为 DeepSeek Harness 打造的**核心插件**：完整复刻 Steam 创意工坊的视觉风格与交互逻辑，
> 用于管理和分发 Harness 的扩展功能（主题、效率工具、Agent 预设、模板、教程等）。

零运行时依赖（原生 HTML/CSS/JS 实现），双击即可离线运行；HTTP 模式下自动与数据文件保持同步。

> **定位说明**：条目数据为 `mock-data/workshop_items.json`：**真实 GitHub 仓库**
> （`topic:dsh-plugin`，经 web 初筛录入，见「从 GitHub 拉取真实数据」）。在 DSH 内运行
> （iframe 桥接 host）时，「订阅 → 自动安装」会**真实写入 DSH**：host 半边
> （`/api/harness-workshop/*`）下载/校验 → 注册到 profile 的 `package.json` 依赖与
> `cordis.patch.yml` 行 → `pnpm install`，刷新页面后新插件生效（见「安装流程」小节）。
> **GitHub 实时同步**：host 半边每 6 小时自动扫描 `topic:dsh-plugin` 新仓库并校验
> 是否为有效 DSH 插件，工坊打开时实时拉取（见「GitHub 实时同步」小节）。
> 独立运行（file:// 或本地 HTTP 预览）时无 DSH 宿主，自动回退为前端演示模拟
> （下载/校验/写入的进度与「已安装」状态存于 `localStorage`）。

---

## 一、快速开始

```bash
# 方式 A：本地预览（推荐，HTTP 模式自动加载 mock-data 数据文件）
npm run serve          # 或 node scripts/serve.mjs [端口]
# 浏览器打开 http://127.0.0.1:8357/

# 方式 B：完全离线
# 直接双击 index.html（内嵌 js/data.js 中的数据，file:// 协议可用）

# 方式 C：重新生成封面图、内嵌数据与 DSH 客户端 bundle（修改 mock-data 后执行）
npm run build

# 方式 E：从 GitHub 拉取真实插件数据（topic:dsh-plugin），合并入 mock-data 后一键重建
npm run refresh       # = npm run fetch && npm run build
node scripts/fetch-github.mjs --dry-run   # 只预览不写文件

# 方式 D：运行全部测试（需先启动 serve，且已 npm install）
npm test               # DOM 冒烟测试（jsdom，无头）
npm run test:bundle    # DSH 客户端 bundle 集成测试（真实 React）
npm run test:all       # 两者一起跑
```

## 二、目录结构

```
harness-workshop/
├── index.html                        # 单页应用入口（顶部导航 + 侧边栏 + 网格 + 详情视图）
├── plugin.manifest.json              # 本插件自身的 PluginManifest（符合下方 schema）
├── package.json                      # 脚本体系（serve/test/build 等），dsh.bundle 标记
├── schema/
│   └── plugin-manifest.schema.json   # ★ PluginManifest 标准数据结构定义（JSON Schema 2020-12）
├── mock-data/
│   └── workshop_items.json           # ★ 条目数据（真实 GitHub 仓库 + 可选演示备份 demo-items.backup.json）
├── css/
│   └── workshop.css                  # Steam 创意工坊风格样式（深蓝 #1b2838 / 强调蓝 #66c0f4 / 订阅绿）
├── js/
│   ├── workshop.js                   # ★ 核心逻辑：排序 / 分类树 / 标签过滤 / 订阅 / 详情 / 评论 / 路由
│   └── data.js                       # 内嵌数据（由脚本从 JSON 生成，保证与数据文件同步）
├── client/
│   └── plugin.js                     # DSH 客户端插件核心（槽位注册 + React 外壳，由构建脚本注入内容）
├── lib/
│   └── client.js                     # 构建产物：DSH 客户端 bundle（window.__ModuleLoader__.load 格式）
├── thumbs/                           # 程序生成的 SVG 封面图（每个插件一张，16:9）
└── scripts/
    ├── serve.mjs                     # 零依赖静态文件服务器
    ├── generate-thumbs.mjs           # 封面图生成器（读取 mock-data 按 id 派生配色）
    ├── generate-data-js.mjs          # 由 JSON 生成 js/data.js
    ├── build-dsh-bundle.mjs          # 组装 DSH 客户端 bundle（iframe srcdoc + 槽位外壳 → lib/client.js）
    ├── fetch-github.mjs              # ★ 从 GitHub 拉取真实插件数据（topic:dsh-plugin，合并进 mock-data）
    ├── smoke-test.mjs                # jsdom DOM 冒烟测试（数据驱动，覆盖 HTTP 与 file:// 两种模式）
    └── test-bundle.mjs               # DSH 客户端 bundle 集成测试（真实 React 渲染 + 槽位注册）
```

## 三、脚本一览

| 命令 | 说明 |
| --- | --- |
| `npm run serve` | 启动预览服务器（默认端口 8357） |
| `npm run fetch` | 从 GitHub 拉取 `topic:dsh-plugin` 仓库数据（合并进 mock-data；`--replace` 完全替换） |
| `npm run refresh` | `fetch` + `build` 一键刷新（拉新数据 → 重新生成封面/内嵌数据/bundle） |
| `npm run thumbs` | 重新生成 `thumbs/*.svg` 封面图 |
| `npm run data` | 由 `mock-data` 生成 `js/data.js` 内嵌数据 |
| `npm run build:web` | `thumbs` + `data`（仅 Web 端产物） |
| `npm run build:bundle` | 组装 DSH 客户端 bundle 到 `lib/client.js` |
| `npm run build` | 一键全量构建：`build:web` + `build:bundle`（改完数据后跑这个即可） |
| `npm test` | DOM 冒烟测试（需先 `npm run serve`） |
| `npm run test:bundle` | bundle 集成测试（需先 `npm run build:bundle`） |
| `npm run test:all` | 冒烟 + 集成测试一起跑 |
| `npm run verify:install` | 本地端到端验证「订阅 → 真实下载安装」链路（无需外网，需先 `npm run serve`） |

## 四、PluginManifest 数据结构定义

完整定义见 `schema/plugin-manifest.schema.json`（JSON Schema Draft 2020-12）。核心字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✔ | 唯一标识符（kebab-case），详情路由与订阅列表依据 |
| `title` | string | ✔ | 标题 |
| `author` | string | ✔ | 作者 |
| `stats.subscribers` | integer | ✔ | 订阅数（「最多订阅」排序） |
| `stats.rating` | number | ✔ | 评分 0–5（星级展示） |
| `stats.views` | integer | ✔ | 浏览量（「最多浏览」排序，参与热度权重） |
| `update_time` | integer | ✔ | 最后更新时间戳（Unix 毫秒，「最近更新」排序） |
| `tags` | string[] | ✔ | 标签数组（"UI美化"、"效率工具"…，驱动侧边栏分类树与标签过滤） |
| `thumbnail` | string | ✔ | 封面图路径（16:9 最佳） |
| `version` | string | ✘ | 版本号（详情页展示，安装流程依据） |
| `source` | object | ✘ | 分发源 `{ type: "github"\|"url", url, sha256? }`：GitHub 源码入口与订阅自动安装共用 |
| `description` / `changelog` / `comments` / `compat` | — | ✘ | 详情页扩展字段（简介/更新日志/评论/兼容性） |

一条最小示例：

```json
{
  "id": "dark-theme-pro",
  "title": "暗夜主题 Pro",
  "author": "Mono Studio",
  "stats": { "subscribers": 15234, "rating": 4.8, "rating_count": 892, "views": 120340 },
  "update_time": 1786492800000,
  "tags": ["UI美化", "主题"],
  "thumbnail": "thumbs/dark-theme-pro.svg"
}
```

## 五、UI 与交互（复刻清单）

- **顶部导航栏**：全局搜索框（120ms 防抖）· 排序下拉（最热门/最多订阅/最近更新/最高评分/最多浏览）· 「浏览 / 您的订阅」Tab（含订阅数徽章）· 物品统计条
- **左侧侧边栏**：多级分类树（全部 → UI 美化/效率工具/Agent 扩展/内容创作 → 叶子分类，可展开收起、带实时计数）+ 标签多选过滤器 + 一键重置
- **主内容区**：响应式卡片网格 —— 封面图（悬停缩放）、标题、作者头像、金色星级评分（按比例裁剪）、两行简介、订阅数/浏览数与订阅按钮
- **详情页**（`#/item/{id}`）：大图 + 标题/作者/版本/统计 chip + 大号订阅按钮 + 标签；下方简介（支持 **加粗** 与分段/列表）、**更新日志**时间线、**评论区**（发表后置顶并持久化）
- **GitHub 源码入口**：详情页操作区「GitHub 源码 ↗」按钮（新标签页打开 `source.url`，无 `source` 字段的条目不显示）
- **订阅并自动安装**：点击订阅 → 自动触发安装流程（下载 → 校验 → 写入 → 完成，进度条 + 逐步提示），完成后卡片/详情显示「✓ 已安装」；取消订阅 = 卸载
- **订阅管理**：订阅/取消订阅即时刷新（卡片角标、统计条、徽章、侧边栏计数全部联动），持久化于 `localStorage` 的 `harness_workshop_subscribed_list`
- **排序与分类记忆**：排序方式与分类选择持久化到 `harness_workshop_prefs`，刷新后保留

### 安装流程（DSH 真实安装 与 演示模拟）

**DSH 真实安装（在 DSH web 内运行）**：点击订阅后，iframe 通过消息桥把条目元数据
发给外壳（`client/plugin.js`），由 host 半边 `lib/host-install.js` 执行：
分发源解析（`local` 目录 / GitHub 仓库 tarball `codeload.github.com` / https 安装包
`.tgz`）→ `sha256` 校验（发布方在 `source.sha256` 提供时）→ 校验 `package.json` 必须
声明 `dsh.client` 或 `dsh.bundle` 清单 → 包复制进 profile 的
`workshop-packages/<id>` → 写 profile `package.json` 依赖（`link:`）与
`cordis.patch.yml` 托管行（`# hw-installed:` 标记）→ `pnpm install`。DSH 的
`watchUserPatches` 热重组合 patch，新行挂载后 `dsh-client-modules` 增量扫描把它纳入
浏览器启动图——**刷新页面后新插件生效**。卸载（取消订阅）同步移除依赖、patch 行与
托管目录。

**演示安装（独立运行 / 无宿主 / 安装失败自动回退）**：走 `INSTALL_STEPS` 的模拟进度
（离线/测试/预览场景），状态持久化于 `localStorage`；条目带 `source.asset_url` 时仍会
真实下载安装包并存档于 IndexedDB。

**真实激活的最后一公里**：1.2.0 已把「安装」接到 DSH profile 层（依赖 + patch 行 +
pnpm install），新插件随浏览器刷新挂载进插件树；更进一步的免刷新热激活依赖 DSH 未来
的宿主安装 RPC。安全提示：自动安装任意来源代码风险极高，host 侧已做 https-only、
条目 id 白名单、50 MiB 上限与 tar 路径越界防护；生产部署应追加来源白名单与签名校验。

### 可访问性（a11y）

- 排序下拉为完整 Listbox 模式：**↑/↓** 移动高亮、**Home/End** 跳转、**Enter/Space** 选中、**Esc** 关闭，`aria-expanded` / `aria-controls` / `aria-activedescendant` / `aria-selected` 齐全
- **焦点管理**：点击卡片进入详情后焦点落在「返回」按钮；返回浏览时焦点恢复到原卡片；详情页点标签 → 聚焦对应筛选项；点作者 → 聚焦搜索框；**Esc** 从详情一键返回（URL 同步）
- 卡片可键盘操作（Tab 聚焦 + Enter/Space 打开），订阅按钮的回车不会误触详情导航；交互元素均有 `:focus-visible` 焦点环

### 排序算法（`js/workshop.js`）

- **最热门（综合权重）**：`score = 订阅数×1.0 + 浏览量×0.02 + 评分×180 + 评分人数×0.05 + 新鲜度加成（7天内+200 / 30天内+80 / 90天内+20）`
- **最多订阅**：`stats.subscribers` 降序；**最近更新**：`update_time` 降序；**最高评分**：`rating` 降序（次级按评分人数）；**最多浏览**：`stats.views` 降序

### 本地存储 Key

| Key | 内容 |
| --- | --- |
| `harness_workshop_subscribed_list` | 已订阅插件 id 数组 |
| `harness_workshop_installed_list` | 已安装插件 id 数组（订阅并完成安装后写入） |
| `harness_workshop_comments` | 本地新增评论 `{ itemId: [comment...] }` |
| `harness_workshop_likes` | 已点赞的评论 key 集合 |
| `harness_workshop_prefs` | 界面偏好 `{ sort, category }` |

## 五点五、GitHub 实时同步（DSH 内自动更新条目）

在 DSH web 内运行时，host 半边（`lib/sync-github.mjs` + `lib/workshop-data.js`）会自动维护条目数据：

- **定时全量同步**：每 6 小时扫描一次 GitHub `topic:dsh-plugin`（按最近更新排序，取前 60），
  GitHub 一上架新插件，最多延迟 6 小时自动入列；
- **过期自动刷新**：缓存超过 1 小时未更新时，打开工坊会触发后台同步；
- **手动刷新**：`POST /api/harness-workshop/refresh` 立即触发一次；
- **清单校验**：尽力而为识别有效 DSH 插件（根目录 `plugin.manifest.json` 或
  `package.json` 的 `dsh.client`/`dsh.bundle` 清单），命中者标记 `install: github`；
  校验走 `cdn.jsdelivr.net`（无限流），网络异常回退 GitHub API（设置 `GITHUB_TOKEN`
  可提升配额）。校验仅作展示标记，订阅任意条目后安装链路会自行深挖子目录与 Release；
- **封面**：新条目按 id 派生配色即时生成 SVG data URI 封面，无需图片素材；
- **数据持久化**：`$DSH_HOME/workshop-items.json`，重启不丢；浏览器端与内嵌数据按 id
  合并（内嵌精选数据优先），统计条显示「数据同步」时间；
- **独立运行**（无 DSH 宿主）自动回退内嵌/mock 数据，不受影响。

## 六、数据驱动

- **分类树**：`js/workshop.js` 顶部的 `CATEGORIES` 常量（数据驱动，替换即可换分类体系）
- **条目数据**：向 `mock-data/workshop_items.json` 的 `items` 数组追加符合 schema 的对象（含可选 `version` 与 `source`，`source.url` 同时驱动 GitHub 入口与安装流程），然后执行 `npm run build` 重新生成封面图、内嵌数据与 DSH 客户端 bundle；原演示用虚构条目已备份至 `mock-data/demo-items.backup.json`（不再作为正式数据）
- **从 GitHub 拉取真实数据**：`node scripts/fetch-github.mjs [话题] [--max N] [--replace] [--dry-run]`
  - 搜索 `topic:<话题>`（默认 `dsh-plugin`，当前该话题下 3000+ 仓库），逐仓库拉取 `plugin.manifest.json`（无则用仓库元数据兜底）与最新 Release；
  - Release 含 `.js/.cjs/.mjs/.tgz/.zip` 安装包时写入 `source.asset_url`，订阅后即可真实下载安装；
  - **hosts 绕过**：若检测到系统 hosts 把 GitHub 域名指向 `127.0.0.1`（被屏蔽/接管），脚本会自动改用真实 IP 直连（`dns.resolve4` + 自定义 lookup），无需修改系统文件；
  - 默认**合并**进现有数据（`--replace` 完全替换），空结果不覆盖原文件；`GITHUB_TOKEN` 环境变量可提高 API 限额；
  - `--fixture scripts/fixtures/github-dsh-plugin.sample.json` 可用内置样本**离线验证**整条管线（不访问网络）；
- **封面图**：`scripts/generate-thumbs.mjs` 按条目 id 派生稳定色相，生成 640×360 SVG（无需任何图片素材）
- **测试**：`smoke-test.mjs` 的期望值全部从 `mock-data` 实时计算（卡片数、分类/搜索命中、排序首位等），新增或修改条目**无需改动测试**；仅分类树结构等由代码定义的断言保持常量

## 七、接入 DeepSeek Harness（集成指南）

### 作为 Web 应用

本插件以**零依赖 Web 应用**形态交付，可直接作为 DSH 的静态前端插件挂载。

### 作为 DSH 客户端插件（槽位体系）

本项目已按 DSH 客户端插件标准打包（`package.json` 声明 `dsh.client` + `exports["./client"]`，
产物 `lib/client.js` 为 `window.__ModuleLoader__.load` 格式）。在 web profile 安装步骤：

1. `npm run build:bundle` 生成 `lib/client.js`；
2. 在 web profile 的 `package.json` 中把依赖链接指向本项目：
   ```json
   "dependencies": { "harness-workshop": "link:D:/path/to/harness-workshop" }
   ```
3. 在 web profile 的 `cordis.patch.yml`（用户补丁层）追加一行：
   ```yaml
   - insert:
       - id: harness-workshop
         name: harness-workshop
   ```
4. 在 profile 目录执行 `pnpm install`（建立 node_modules 链接）；
5. **重启 DSH web**（插件集变更需重启生效），刷新页面后侧边栏底部出现「创意工坊」入口；
6. 验证：浏览器访问 `/plugins/harness-workshop/client.js` 应返回 bundle 内容。

安装后 `client/plugin.js` 注册两个槽位：
- `sidebar.footer.action` —— 侧边栏底部「创意工坊」入口按钮（宽/窄两种形态）；
- `shell.overlay` —— 全屏工坊界面，以 **iframe srcdoc** 承载完整独立页面，样式/脚本与 DSH 外壳完全隔离（缩略图已内联为 data URI，srcdoc 自包含）；
跨组件共享的打开状态通过模块级 store + `useSyncExternalStore` 同步，Esc / 关闭按钮均可退出。

`plugin.manifest.json` 即遵循本插件 schema 的元数据，可被创意工坊自身索引与展示（「Harness 创意工坊」插件本体也是其中一条）。

## 八、技术栈与环境

- 环境自检：Node v24 / npm 11 ✔，npm registry 可达 ✔
- 运行依赖：**无**（纯 HTML/CSS/JS，图标与封面均为内联 SVG / 程序生成，可完全离线）
- 开发依赖：仅 `jsdom`（冒烟与 bundle 集成测试用）
- 未采用 Ant Design / Element Plus / Tailwind：Steam 风格需像素级自定义样式，手写 CSS（约 700 行设计令牌化变量）可获得最忠实的复刻效果，且避免引入构建链路
