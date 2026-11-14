# CHANGELOG

## 3.1.0（2026-11-14）

### 新增

- **上传附件**：`POST /api/uploads`（contract §9.1）——原始字节流（Content-Length 已知），
  `X-File-Name`（URL 编码）+ `X-Media-Type` 头；边收边落临时文件并计算 sha256，
  单文件上限 **200 MB**（超限 `413 INVALID_PARAM`，Content-Length 预检 + 流式计数双保险）。
  对象按内容寻址写入 DSH 附件存储：`image/*` → `attachments/v1/objects/<hex前2>/<hex>`、
  其余 → `attachments/v1/file-objects/<hex前2>/<hex>`（与 DSH 自带发布器一致，同字节重传幂等复用）；
  PNG/JPEG 魔数解析宽高（GIF/WebP 识别类型、宽高 0），`kind` = image | video | file
- **带附件发消息**：REST `POST /api/sessions/:id/messages` 与 WS `send` 载荷新增 `attachments`
  （≤9 个，contract §9.2）——`image/*` → `{type:'image', attachment:{attachmentId, mediaType,
  bytes, width, height, name}}`（mediaType/bytes/宽高以落盘对象实测为准，保证 DSH
  readImageFile 逐字段校验通过）；`video/*` 与其他文件 → 先经 DSH 官方
  `fileUploads.uploadStream` 暂存收据再以 `{type:'file', receiptId}` 进 prompt
  （DSH 的 resolvePromptFileReceipts 只认收据，直接给 attachment 引用会被拒），
  会话日志里的 file 块仍是 `{type:'file', attachment:{...}}`；附件块全部拼在 text 之前，
  空文本 + 附件的纯附件消息允许；未上传过的 attachmentId → `404 INVALID_PARAM`
- **归档会话删除**：`DELETE /api/sessions/:id?purge=true` 与
  `POST /api/sessions/batch-delete`（≤200 个，部分成功返回 200，purged / archivedFallback /
  failed 三数组齐全，contract §9.3）。
  **DSH 删除能力核实结论**（app.asar 源码）：`SessionPersistence` 只有
  create/open/flush/stat/list（append-only 语义写死）、`SessionStore` 的 disposal 仅由
  创建方 fiber 内部 detach 触发、`workspaceController` 只有归档/置顶（其 delete 是删工作区）、
  全源码无 purge 入口 —— **DSH 0.2.x 无对外会话硬删能力**，因此 purge 一律降级为
  「归档 + 尽力清标题」，结果放 `archivedFallback` 如实上报，绝不假装删成功；
  v3.0 的 DELETE（不带 purge）语义不变（仍 = 归档）

### 新增（v3.1 追加）

- **会话权限模式**（contract §9.5）：`GET /api/sessions/:id/permission` 与
  `PUT /api/sessions/:id/permission`，3 档 `read-only` / `workspace-write` / `full-access`
  + `approval`（'ask'→every-step / 'never'→auto，只读返回）。
  **DSH 运行时写入口已核实**：`permissionPresets.set(session, preset)`
  （dsh-permission-presets/src/index.ts:395-411，ds-bot 即如此使用，见
  ds-bot/src/host/permissions.js:28）；默认预设表只有 workspace-write 与
  danger-full-access（index.ts:183-190），因此 full-access → 预设
  danger-full-access，read-only（默认表没有）→ 直写官方
  `sandbox/mode` 事件（`session.append('sandbox/mode', {mode})`，
  dsh-sandbox-policy/src/session-mode.ts:53-54 "THE write path ... the switch
  IS its event"，SANDBOX_MODES 含 read-only）。PUT 成功后广播 `session.updated`
- **隧道安全修复**：Quick Tunnel 启动加 `--http-host-header dsh-phone-bridge-tunnel`
  （cloudflare.js），桥据此识别隧道来源 —— `/api/pairing-code` 与 `/pair` 页对
  隧道流量一律 `403 ROUTE_LOCAL_ONLY`（新错误码）。此前隧道流量从 127.0.0.1 连入，
  socket 层面与本机无法区分，**外网可凭隧道地址自助拿配对码**（实测复现的漏洞）。
  `/api/pair` 保留隧道可达（外地合法配对路径），但加防爆破：同源连续错
  **20 次**锁 **15 分钟**（`429 RATE_LIMITED` + retryAfter）

### 修复

- **资源不存在误报 501**：`GET /api/media/:name`、`GET /api/attachments/:id`、
  `GET /api/files/:id` 在对象缺失时返回 `NOT_SUPPORTED(501)`，语义应为 404。
  新增错误码 `MEDIA_NOT_FOUND(404)` 与 `ATTACHMENT_NOT_FOUND(404)`
  （contract §5 错误表同步）；发消息时引用未上传附件保持契约规定的 `404 INVALID_PARAM`
- `GET /api/attachments/:id` / `/api/media/:name` / `/api/files/:id` 的
  `?token=` 查询参数鉴权经实测确认可用（手机 Image/Video 组件带不了 Authorization 头）

### 说明

- 冒烟测试 27 → **48 项**（上传幂等、PNG/JPEG 尺寸魔数、413、image/file 块结构、
  fileUploads 收据、未上传 404、>9 附件、纯附件消息、WS 附件、purge 降级、
  batch 部分成功、超 200 批量上限、隧道 403、pair 防爆破、权限模式读写等）
- 包版本与 `BRIDGE_VERSION` 升至 `3.1.0`；`CONTRACT_VERSION` 仍为 3（纯增量）

## 3.0.1（2026-11-14）

### 新增

- **媒体投影**：`generate_image` / `generate_video` 工具结果里的
  `images[].attachment_id` → `image` 块、`videos[].url` → `video` 块（`media:<文件名>` 引用），
  手机端无需电脑路径即可加载素材
- **视频字节路由**：`GET /api/media/:name`（`send` 流式，支持 Range/206，可直接拖动播放），
  服务 `$DSH_HOME/dsh-imagegen/videos/files`
- **通用文件下载**：`GET /api/files/:attachmentId`，服务 `attachments/v1/file-objects` 内容寻址对象
- **冒烟测试** 23 → 27 项（媒体二进制、Range 206、路径穿越拒绝、投影断言）

### 变更

- 助手 / 工具正文里的**本机绝对路径图片链接**被剥离（`![...](C:\...)`），不再把电脑路径透传到手机
- 生成类工具结果的正文从整段 JSON 换成其 `message` 字段（友好文案），错误时附 `error` 行
- 冒烟测试隔离 `$DSH_HOME`，不再污染真实 `~/.dsh/phone-bridge/model.json`
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
