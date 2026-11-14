# CHANGELOG

## 3.0.0（2026-11-13）

这是一次**重写**，v2 的「聊天原型」被完全替换为商业级桥接层。

### 新增

- **三层架构**：`bridge/`（BridgeService）· `adapter/`（DSH Adapter）· `bridge/eventhub.js`（EventHub）
- **会话全量管理**：列表（含标题）、详情、新建、改名、归档、置顶、搜索
- **历史分页**：按 turn 分页（`turns` + `beforeTurn`），修正了「用户提问排在 turn/start 之前」导致的漏条
- **实时推送**：订阅 Host Event `session/event` 与 `agent/assistant-stream`，
  下推 `message.created` / `message.done` / `message.part` / `turn.*` / `assistant.stream`
- **流式增量**：`StreamChunk` 七种载荷（text-delta / reasoning-delta / tool-call-delta …）原样转发
- **模型**：`modelCatalog()` 动态目录 + 默认模型读写（`agentDefaultModel`）
- **REST 控制面**：`/api/health` `/api/pair` `/api/sessions*` `/api/models` `/api/settings/model` `/api/sync` `/api/search` `/api/workspaces`
- **WS 数据面**：`/ws?token=`，`hello` / `send` / `stop` / `subscribe` / `sync` 补拉
- **鉴权**：令牌（Bearer / `?token=`）+ 一次性 6 位配对码；令牌落盘 `$DSH_HOME/phone-bridge/tokens.json`
- **配对页**：`/pair`（仅本机），二维码 + 大字配对码，主色 `#4D6BFE`
- **错误模型**：统一 `{ error: { code, message, retryAfter?, detail? } }`，14 个错误码
- **契约文件**：`shared/contract/contract.md` + `types.ts`
- **自带冒烟测试**：`node smoke-test.mjs`，23 项断言，无需 DSH 运行时

### 变更

- `inject` 从 `['webServer','connection','llm']` 改为
  `['webServer','connection','sessionController','sessionQuery','sessionTitle','workspaceController','agentDefaultModel']`
- 包版本 `2.0.0` → `3.0.0`；`exports` / `files` 补全

### 移除

- **直连模型的聊天实现**（`ctx.llm.stream` + `askDefaultModel`）——违反「不绕过 harness」红线
- **硬编码的 5 条 magpie 回退路由**——改为完全读真实 `modelCatalog()`
- 内存态 `sessions: Map` 与 `HISTORY_LIMIT` ——改为 DSH 持久化会话

### 修复

- 旧 `pair.js` 中文注释乱码（GBK/UTF-8 混淆），整体重写为干净 UTF-8
- 旧版端口被占用时的重试逻辑未回写真实端口，现从 `server.address()` 取实际端口

## 3.0.1（2026-11-13）

### 修复

- **归档箱不生效**：GET /api/sessions?archived=1 与主列表返回完全相同的集合。
  根因：SessionSummary 上不带归档 / 置顶字段，旧实现只是把 rchived 原样回显。
  修法：DshAdapter.startWorkspaceWatch() 订阅 workspaceController.follow()，
  用 baseline 与 rchived / pinned / eplace 增量维护 rchivedIds / pinnedIds 集合；
  listSessions(archived) 据此过滤，并给每条记录补 rchived / pinned 两个字段；
  置顶会话排最前，其次运行中，再按 updatedAt 倒序。
- **DELETE 语义澄清**：DSH 没有「彻底删除会话」的接口，DELETE /api/sessions/:id
  等同归档（可从归档箱恢复），http.js 注释与文档已注明。

### 说明

- 归档 / 置顶集合是 workspaceController 的全局集合，因此**必须重启 DSH** 后本次改动才生效。
