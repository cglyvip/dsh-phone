# DeepSeek Harness 手机桥 · 协议契约 v3

> 本文件是**桌面桥插件**与**手机 App**之间的唯一协议事实来源。
> 类型定义见同目录 `types.ts`；鸿蒙端的镜像类型在
> `DSH-hm/entry/src/main/ets/contract/Contract.ets`（必须与本文件同步）。

- 桥版本：`3.7.0`
- 契约版本：`3`（`MIN_CONTRACT_VERSION = 3`）
- 协议名：`dsh-phone-bridge`

### 3.7.0 会话内媒体转出（详见 §3.3）

v3.6 及以前，只有生视频工具落在 `$DSH_HOME/dsh-imagegen/videos/files` 的文件能转成
`video` 块，其他任何路径（例如电脑端在会话工作区里交付的
`D:\work\deliver\demo.mp4`）都会被丢弃，手机端因此收不到视频。v3.7 打通三层：

1. **投影层**（`adapter/project.js`）：除了原有的 JSON 形状，还识别两种常见交付写法——
   markdown 链接 `[标题](<相对/绝对路径>)` 与工具输出里的 `Presented <路径>` 行。
   相对路径按会话 `cwd` 展开成绝对路径；非媒体扩展名不转块。
   正文里的本机路径会被降级（图片语法整段删除、链接降级为纯文字、`Presented` 行降级为文件名），
   避免手机端出现 `D:\...` 这类无意义文本。
2. **块提升**：工具结果里的媒体块会复制一份到同一 turn 的助手消息上，
   老客户端（鸿蒙 1.0.x）无需改动即可渲染。
3. **取字节**（`GET /api/media/:id`）：新增 ID 形态 `media:v1.<base64url(绝对路径)>`。
   服务端解码后要求路径绝对、扩展名属于图片/视频白名单、`realpath` 后仍落在白名单根内
   （`$DSH_HOME/dsh-imagegen` + 全部会话 cwd 含归档 + 全部工作区路径），否则一律
   `404 MEDIA_NOT_FOUND`（不区分「不存在」与「越权」）。非媒体扩展名 `400 INVALID_PARAM`。

`media:` 前缀沿用旧约定，客户端 `mediaSrcOf()` 剥掉前缀后桥端同样接受 `v1.` 形态，
因此老版本 App 不需要升级。契约版本仍为 `3`，属纯增量。

### 3.6.0 公网接入补充

`POST /api/transport/probe` 支持根地址形式的 HTTP、HTTPS 和 `tcp://主机:端口`；TCP 地址会转换为 HTTP。
探活须返回桥身份、`status: ok` 与兼容的 `contractVersion`，不接受登录页、广告页或重定向。
公网端点还须阻止外部读取 `/api/pairing-code`。成功结果可附带 `bridgeVersion` 与 `contractVersion`。
`named` 或 `custom` 切换前验证失败时，接口返回错误且保留当前通道与持久配置。
配对页使用每次桥启动生成、仅对本机通道接口有效的专用凭据；手机业务接口仍使用配对所得 Bearer 令牌。

---

## 1. 总览

```
手机 App  ──HTTP(S)──▶  /api/**   控制面：会话 CRUD、历史分页、模型设置、配对
          ──WS(S)────▶  /ws      数据面：实时事件推送 + 发消息 / 停止 / 补拉
```

- 控制面是**请求-响应**，无状态。
- 数据面是**长连接**，服务端主动推送，客户端按 `seq` 断线补拉。
- 手机端**永远**不直连模型 API；发消息一律经 `sessionController.prompt`
  进入 DSH 的 Agent 循环（这是硬性红线，见任务书第 8 节）。

---

## 2. 鉴权

### 2.1 令牌

- 桥启动后生成一个 6 位**配对码**（10 分钟有效、一次性）。
- 配对码可在：电脑上打开 `http://127.0.0.1:<port>/pair`（仅本机可访问）、
  DSH 对话里执行 `/pair` 命令、或桥的启动日志里看到。
- 手机用配对码换长期令牌（默认 7 天）：

```http
POST /api/pair
Content-Type: application/json

{ "code": "123456", "clientName": "我的手机" }
```

```json
{
  "token": "dsb_xxx",
  "clientId": "phone-1a2b3c4d",
  "expiresAt": 1793520000000,
  "bridgeVersion": "3.0.0",
  "contractVersion": 3
}
```

- 之后所有请求都带 `Authorization: Bearer <token>`；WebSocket 用
  `ws://host:port/ws?token=<token>`。
- 令牌只存在电脑端磁盘（`$DSH_HOME/phone-bridge/tokens.json`，权限 600）
  和手机端本地存储；桥**从不**回显已签发令牌。

### 2.2 免鉴权接口

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 存活探测 + 版本协商 |
| `POST /api/pair` | 用配对码换令牌 |
| `GET /api/pairing-code` | **仅本机**，供配对页读当前码 |

---

## 3. REST 控制面

所有成功响应 `200`（创建消息为 `202`）；失败统一为：

```json
{ "error": { "code": "SESSION_NOT_FOUND", "message": "会话不存在" } }
```

### 3.1 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions` | 列出全部可见会话（含标题） |
| POST | `/api/sessions` | 新建会话 `{cwd?, workspaceId?, agentPreset?, title?}` |
| GET | `/api/sessions/:id` | 会话详情（头部 + 运行状态 + 元信息 + 计数） |
| PATCH | `/api/sessions/:id` | `{title}` 改名 / `{pinned}` 置顶 / `{archived}` 归档 |
| DELETE | `/api/sessions/:id` | 归档会话（DSH 侧即停用，不物理删除日志） |
| GET | `/api/sessions/:id/messages?turns=10&beforeTurn=42` | 按 turn 分页拉历史 |
| POST | `/api/sessions/:id/messages` | 发消息 `{text, clientMessageId?, mode?}` → `202` |
| POST | `/api/sessions/:id/stop` | 停止当前生成 |
| GET | `/api/sessions/:id/state` | 运行状态快照（running / 队列 / 待输入） |
| GET | `/api/search?q=关键词` | 全文搜会话 |
| GET | `/api/workspaces` | 列出工作区（新建会话时选目录） |

`GET /api/sessions` 响应：

```json
{
  "items": [
    {
      "sessionId": "session-...",
      "title": "重构插件",
      "updatedAt": 1793520000000,
      "running": false,
      "blank": false,
      "cwd": "E:\\work",
      "parentSessionId": "",
      "origin": "",
      "agentAvailable": true,
      "formatStatus": "",
      "preview": "好的，我先把路由层拆出来……",
      "lastRole": "assistant"
    }
  ],
  "archived": false
}
```

> **preview / lastRole（v3.5）**：`preview` 是该会话最后一条 user/assistant
> 消息的单行摘要（连续空白折叠、按 Unicode 码点截 60 字、超长补 `…`）；
> `lastRole` 是该消息的角色 `'user' | 'assistant'`（无消息为 `''`）。
> 生成规则：text 块拼接单行化；image/video/file/toolCall 块 → 占位
> `[图片]` / `[视频]` / `[文件]` / `[工具调用]`；tool/system/developer 消息
> 不算（`lastRole` 契约只有两值）。来源：DSH 的 `sessionController.list()`
> **不原生携带** lastMessage/preview 列（app.asar 的
> dsh-api-session-controller `summaryFor()` 与 dsh-session-query 均核实过，
> dsh-session-query-sqlite 只有 FTS5 search 接口）——由桥维护内存缓存：
> `message.created` / `message.done` 事件实时更新，启动时对列表前 20 个
> 会话用最新 turn 批量补齐，列表请求时对缓存缺失的前 20 个后台补齐
> （不阻塞响应）。因此预览在桥进程刚启动的短暂窗口内可能为空串。

`GET /api/sessions/:id/messages` 响应：

```json
{
  "sessionId": "session-...",
  "title": "重构插件",
  "messages": [
    {
      "id": "u1", "seq": 10, "role": "user", "time": 1793520000000,
      "turn": 1, "step": 0,
      "blocks": [{ "type": "text", "text": "帮我看看这段代码" }],
      "text": "帮我看看这段代码"
    },
    {
      "id": "a1", "seq": 12, "role": "assistant", "time": 1793520000000,
      "turn": 1, "step": 1,
      "blocks": [{ "type": "text", "text": "好的……" }],
      "text": "好的……",
      "provider": "magpie", "model": "29-cc-cd/deepseek-v4.1-flash",
      "usage": { "inputTokens": 43898, "outputTokens": 1488, "totalTokens": 45578 }
    }
  ],
  "turns": [{ "turn": 1, "startedAt": 1793520000000, "ended": "stop", "endedAt": 1793520001000 }],
  "meta": { "preset": "workspace-write", "sandbox": "workspace-write", "approval": "ask" },
  "hasMore": true,
  "nextBeforeTurn": 1
}
```

> 分页语义：`turns` 指定本次拉多少个 turn，`beforeTurn` 指截止到哪个 turn 之前。
> 上拉加载时把上一页返回的 `nextBeforeTurn` 作为新的 `beforeTurn`。
> 服务端已处理「用户提问排在 turn/start 之前」的情况，不会漏掉提问气泡。

### 3.2 模型

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/models` | 模型目录 `{default, routableProviders, groups, failures, current}` |
| GET | `/api/settings/model` | 当前默认模型 |
| PUT | `/api/settings/model` | 改默认模型 `{provider, model, reasoningEffort?}` |

模型目录**完全来自** `sessionController.modelCatalog()`，桥不做任何硬编码回退。

### 3.3 媒体与附件字节

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/attachments/:id` | 图片附件字节（`sha256:<64hex>`），支持 Range |
| GET | `/api/files/:id` | 通用文件附件字节（`sha256:<64hex>`） |
| GET | `/api/media/:id` | 媒体字节，支持 Range（v3.7，见下） |

`/api/media/:id` 接受四种 `id`（URL 编码后放进路径，带 `?token=`）：

| 形态 | 指向 |
|---|---|
| `<文件名>.mp4` | `$DSH_HOME/dsh-imagegen/videos/files/<文件名>`（v3.0 生视频，禁止目录层级） |
| `media:<文件名>` | 同上，兼容老客户端的原样透传 |
| `media:v1.<base64url>` | base64url 解码出的**绝对路径**，须落在白名单根内（v3.7） |
| `v1.<base64url>` | 同上，兼容剥掉 `media:` 前缀的客户端（鸿蒙 `mediaSrcOf()` 即如此） |

白名单根 = `$DSH_HOME/dsh-imagegen` + 全部会话 `cwd`（含归档）+ 全部工作区路径，
逐个 `realpath` 归一化后按前缀比对（大小写不敏感、补路径分隔符）。判定顺序：
空 id → `400`；非图片/视频扩展名 → `400 INVALID_PARAM`；相对路径 → `400`；
`realpath` 失败 / 非普通文件 / 不在白名单内 → `404 MEDIA_NOT_FOUND`。
成功响应带 `Cache-Control: private, max-age=86400` 与正确的 `Content-Type`。

---

## 4. WebSocket 数据面

连接：`ws://<host>:<port>/ws?token=<token>`

### 4.1 连接建立

服务端立即下发 `hello`：

```json
{
  "type": "hello", "seq": 42, "timestamp": 1793520000000,
  "payload": {
    "clientId": "phone-1a2b3c4d",
    "bridgeVersion": "3.0.0",
    "contractVersion": 3,
    "cursor": 42,
    "protocol": "dsh-phone-bridge"
  }
}
```

客户端拿到 `cursor` 后若本地缓存过事件，可发 `sync` 补拉断线期间的消息。

### 4.2 客户端 → 服务端

| type | 载荷 | 说明 |
|---|---|---|
| `ping` | — | 心跳（服务端回 `pong`） |
| `subscribe` | `{sessionId}` | 只接收该会话的事件 |
| `unsubscribe` | — | 取消过滤，接收全部 |
| `sync` | `{cursor}` | 补拉 `seq > cursor` 的事件 |
| `state` | `{sessionId}` | 拉一次状态快照 |
| `send` | `{sessionId, text, clientMessageId?, requestId?, mode?, clientTimeZone?}` | 发消息 |
| `stop` | `{sessionId}` | 停止生成 |

### 4.3 服务端 → 客户端

统一信封：`{ type, seq, sessionId?, timestamp, payload }`

| type | 何时发 | payload 关键字段 |
|---|---|---|
| `hello` | 连接建立 | clientId / bridgeVersion / contractVersion / cursor |
| `pong` | 收到 ping | time |
| `error` | 请求失败 | code / message |
| `subscribed` | 订阅成功 | sessionId |
| `sync.cursor` | 补拉完成 | cursor |
| `sync.invalidated` | cursor 太旧已被裁掉 | cursor（客户端需全量重拉） |
| `state.snapshot` | 收到 state | cursor / active / running / queue / pendingInput |
| `send.accepted` | 收到 send | sessionId / requestId / clientMessageId |
| `stop.accepted` | 收到 stop | accepted |
| `session.created` / `session.updated` / `session.deleted` / `session.status` | 会话变化 | sessionId / running / updatedAt |
| `message.created` | 用户消息入库 | id / role / blocks / text |
| `message.done` | 助手消息完成 | id / blocks / text / provider / model / usage |
| `message.part` | 工具调用/结果 | kind('tool-call'\|'tool-result') / callId / toolName / isError |
| `turn.started` / `turn.finished` | turn 边界 | turn / reason |
| `assistant.stream` | 流式增量 | `frame: {type:'start'\|'chunk'\|'end', ...}` |
| `settings.updated` | 会话模型变更 | model |
| `models.updated` | 模型目录变更 | provider |

`assistant.stream` 的 `frame.chunk` 就是 DSH 的 `StreamChunk`：
`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`。
即：**思考过程（reasoning-delta）与工具参数流（tool-call-delta）都能实时拿到。**

---

## 5. 错误码

| code | HTTP | 含义 | 客户端建议 |
|---|---|---|---|
| `AUTH_REQUIRED` | 401 | 没带令牌 | 跳配对页 |
| `AUTH_INVALID` | 401 | 令牌无效 | 清本地令牌，重新配对 |
| `AUTH_EXPIRED` | 401 | 令牌过期 | 静默重新配对 |
| `PAIRING_DISABLED` | 403 | 已关闭配对 | 提示用户到电脑端开启 |
| `PAIRING_CODE_INVALID` | 403 | 配对码错/过期 | 重新输入，或刷新配对页 |
| `ROUTE_LOCAL_ONLY` | 403 | 仅限本机的接口被隧道/远程流量触碰（v3.1 安全修复：配对码绝不经隧道下发） | 走 App 配对流程（配对码在电脑上读） |
| `SESSION_NOT_FOUND` | 404 | 会话不存在 | 返回列表并刷新 |
| `ATTACHMENT_NOT_FOUND` | 404 | 附件对象不存在（v3.1：GET /api/attachments/:id、/api/files/:id） | 提示资源已失效 |
| `MEDIA_NOT_FOUND` | 404 | 媒体文件不存在或不在白名单内（v3.1：GET /api/media/:name；v3.7 增 `media:v1.<base64url>` 绝对路径形态，越权同样按 404 处理） | 提示资源已失效 |
| `NOT_SUPPORTED` | 501 | 当前 DSH 版本不支持该能力 | 隐藏对应按钮 |
| `INVALID_PARAM` | 400 | 参数不合法 | 提示并阻止提交 |
| `RATE_LIMITED` | 429 | 太频繁 | 按 `retryAfter` 退避 |
| `CONFLICT` | 409 | 会话正忙 / 写入被占用 | 提示稍后重试 |
| `DSH_ERROR` | 502 | DSH 内部报错 | 展示 message |
| `BRIDGE_OFFLINE` | 503 | 桥不可达 | 进入离线态，指数退避重连 |
| `BRIDGE_INCOMPATIBLE` | 409 | 契约版本不兼容 | 提示升级 App 或插件 |
| `INTERNAL_ERROR` | 500 | 未预期异常 | 上报日志 |

---

## 6. 版本协商

1. `GET /api/health` 返回 `contractVersion` 与 `minContractVersion`。
2. 客户端若 `CONTRACT_VERSION < minContractVersion` → 明确提示「请升级 App」，
   **不得**静默失败或降级运行。
3. WS 的 `hello` 同样带 `contractVersion`，用于二次确认。

---

## 7. DSH 能力映射（证明没有臆造 API）

| 手机端功能 | 桥的 REST/WS | 底层 DSH 服务 |
|---|---|---|
| 会话列表 | `GET /api/sessions` | `sessionController.list()` + `sessionQuery.readTitleSnapshots()` |
| 会话详情 | `GET /api/sessions/:id` | `sessionQuery.readSession()` + `sessionController.state()` |
| 历史分页 | `GET /api/sessions/:id/messages` | `sessionQuery.readSession().events` → 按 turn 分页 |
| 新建会话 | `POST /api/sessions` | `sessionController.create()` |
| 改名 | `PATCH /api/sessions/:id {title}` | `sessionTitle.rename()`（退回 `sessionController.rename()`） |
| 置顶 / 归档 | `PATCH` / `DELETE` | `workspaceController.pinSession/unpinSession/archiveSession` |
| 搜索 | `GET /api/search` | `sessionController.search()` |
| 发消息 | `POST .../messages`、WS `send` | `sessionController.prompt()` |
| 停止 | `POST .../stop`、WS `stop` | `sessionController.cancel()` |
| 模型目录 | `GET /api/models` | `sessionController.modelCatalog()` |
| 默认模型 | `GET/PUT /api/settings/model` | `agentDefaultModel.currentSelection()/saveSelection()` |
| 会话级模型 | （预留） | `sessionController.selectModel()` |
| 实时消息 | WS `message.created` / `message.done` | Host Event `session/event` |
| 流式增量 | WS `assistant.stream` | Host Event `agent/assistant-stream` |

> 依据：以上服务名与方法签名全部来自 cordis Inspect 的 host Service 清单
> （本机 DSH 0.2.2-rc.1 实测），事件名来自 host Event 清单，事件数据结构
> 用 `$DSH_HOME/sessions/*/session.v4.jsonl.zstd` 真实日志逐条核对。

---

## 8. 版本历史

| 版本 | 变更 |
|---|---|
| 2.0.0 | 原型：只有 `ping/list_plugins/chat/state/clear_session`，聊天直连模型，无会话管理 |
| 3.0.0 | 重写为 bridge/adapter/eventhub 三层；接入 `sessionController` 全量会话能力；REST + WS；令牌鉴权 + 配对码；流式增量；模型目录；按 turn 分页 |
| 3.1.0 | 上传附件（POST /api/uploads）；带附件发消息（attachments ≤9）；归档会话删除（DELETE ?purge 降级 + batch-delete）；媒体/附件不存在 404 化（MEDIA_NOT_FOUND / ATTACHMENT_NOT_FOUND）；会话权限模式（GET/PUT :id/permission）；隧道安全（仅本机接口对隧道流量 403 ROUTE_LOCAL_ONLY，/api/pair 防爆破） |
| 3.2.0 | 公网接入多通道（§10）：tunnelMode = quick/named/frp/relay/off 统一状态机；frp 通道（frpc 自动下载双校验 + toml 生成 + 崩溃重启 + remotePort 回填 publicUrl）；GET /api/transport + POST /api/transport/mode（仅本机）；配对页通道选择卡片；仅本机路由判定加严为「socket 回环 + Host 回环」 |
| 3.3.0 | 通道扩展（§10.1）：custom 模式（粘贴任意工具地址+格式校验+探活）；ngrok 托管（官方下载 size/sha256 校验 + config add-authtoken + http --domain 解析）；POST /api/transport/probe 探活接口；transport/mode 载荷扩展（参数随切持久化，token/authtoken 只落盘不回显）；配对页服务商预设折叠与卡片视觉升级 |
| 3.4.0 | 审批策略可写（§9.6）：PUT :id/permission 增 approval（every-step↔ask / auto↔never），与 mode 任意组合；approval/policy 事件直写（dsh-user-approval setApprovalPolicy 同路径）；GET 回读一致 |
| 3.5.0 | 会话列表最后一条消息预览（§3.1）：items 增 `preview`（≤60 字单行摘要，占位符规则见 §3.1 注记）+ `lastRole`（'user'\|'assistant'）；桥内存缓存（message.created/done 实时 + 启动/列表前 20 批量补齐），DSH 原生不带该数据；纯增量，CONTRACT_VERSION 仍为 3 |
| 3.6.0 | 公网接入补充：14 项穿透服务目录、`tcp://` 根地址探活、本机通道专用凭据、新电脑安装脚本 |
| 3.7.0 | 会话内媒体转出（§3.3）：投影层识别 markdown 链接与 `Presented <路径>` 行并按会话 cwd 展开；媒体块提升到助手消息；`GET /api/media/:id` 支持 `media:v1.<base64url(绝对路径)>`（白名单 realpath 校验，越权 404）；正文本机路径降级；纯增量，CONTRACT_VERSION 仍为 3 |

---

## 附录 A：会话归档 / 置顶的权威来源（v3.0.1 补充）

GET /api/sessions 返回的每一条 SessionListItem 现在额外带 rchived 与 pinned：

- rchived: true 的会话**只在** GET /api/sessions?archived=1 中出现；主列表已排除。
- pinned: true 的会话排在列表最前。

这两个字段**不是** DSH SessionSummary 自带的。权威来源是 workspaceController 的全局集合：

- workspaceController.follow(signal) 的第一帧 {type:'baseline', value:{items, archivedSessionIds, pinnedSessionIds}}
- 后续增量 {type:'archived', archivedSessionIds} / {type:'pinned', pinnedSessionIds} / {type:'replace', value}

桥在启动时订阅该流并常驻维护集合（DshAdapter.startWorkspaceWatch()），
因此归档 / 置顶改动**必须重启 DSH**才能被桥感知。

## 附录 B：DELETE 与会话删除的语义

DSH 没有「彻底删除会话日志」的对外接口。因此：

- DELETE /api/sessions/:id == 归档（workspaceController.archiveSession），
  可通过 PATCH /api/sessions/:id {"archived": false} 恢复，或归档箱里的「取消归档」。
- 客户端文案不要写「永久删除」，应写「归档（可恢复）」。

---

## 9. v3.1 增量（2026-11-14：上传附件 + 归档删除）

> 本节为 v3.1 新增能力，向下兼容：旧客户端不使用这些接口不受影响。
> `CONTRACT_VERSION` 仍为 3（纯增量），`BRIDGE_VERSION` 升到 `3.1.0`。

### 9.1 上传附件（手机 → 电脑）

```http
POST /api/uploads
Authorization: Bearer <token>
Content-Type: application/octet-stream
Content-Length: <bytes>
X-File-Name: <URL编码的原始文件名>
X-Media-Type: image/jpeg | video/mp4 | application/pdf | ...（可省，缺省 application/octet-stream）

<原始字节>
```

- 单文件上限 **200 MB**，超限返回 `413 INVALID_PARAM`（message 说明大小上限）。
- 桥计算 sha256 → 写入 DSH 附件存储：
  - `image/*` → `$DSH_HOME/attachments/v1/objects/<hex前2位>/<其余hex>`
  - 其余 → `$DSH_HOME/attachments/v1/file-objects/<hex前2位>/<hex>`
- 幂等：同字节同 sha256 直接复用已有对象，不重复落盘。

```json
{
  "attachmentId": "sha256:<64位hex>",
  "mediaType": "image/jpeg",
  "name": "照片.jpg",
  "bytes": 123456,
  "width": 0,
  "height": 0,
  "kind": "image"        // image | video | file（按 mediaType 判定）
}
```

- 桥侧对图片做尺寸探测（PNG/JPEG 魔数解析，读不到宽高就填 0，不报错）。
- 图片预览接口复用现有 `GET /api/attachments/:attachmentId`。

### 9.2 带附件发消息

`POST /api/sessions/:id/messages` 与 WS `send` 的载荷新增可选字段：

```json
{
  "sessionId": "...",
  "text": "看看这张图和这个视频",
  "attachments": [
    { "attachmentId": "sha256:...", "name": "照片.jpg", "mediaType": "image/jpeg", "bytes": 123456 },
    { "attachmentId": "sha256:...", "name": "演示.mp4", "mediaType": "video/mp4", "bytes": 9876543 }
  ]
}
```

- 桥把 attachments 映射进 `content` 块再调 `sessionController.prompt`：
  - `image/*` → `{ type:'image', attachment:{ attachmentId, mediaType, bytes, width, height, name } }`
  - `video/*`、其他 → `{ type:'file', attachment:{ attachmentId, name, bytes, mediaType } }`
  - 所有块拼接在用户 text 之前；attachments 为空数组/缺省时行为与 v3.0 完全一致。
- 上限：单条消息最多 **9 个附件**；未上传过的 attachmentId 直接 `404 INVALID_PARAM`（提示先上传）。

### 9.3 归档会话的删除（单个 / 批量）

语义分层（归档 = 停用会话；删除 = 彻底从列表清除）：

| 方法 | 路径 | 说明 |
|---|---|---|
| DELETE | `/api/sessions/:id` | v3.0 行为不变：归档（软删） |
| DELETE | `/api/sessions/:id?purge=true` | **硬删**：尽力移除会话记录（依赖 DSH 能力，见下），移除不了时降级为归档并在响应里标注 |
| POST | `/api/sessions/batch-delete` | 批量硬删，body `{ "ids": ["..."] }`，上限 200 个 |

硬删响应：

```json
{
  "purged": ["session-1"],
  "archivedFallback": [],
  "failed": [{ "id": "session-3", "code": "SESSION_NOT_FOUND", "message": "会话不存在" }]
}
```

批量响应同构，`purged`/`archivedFallback`/`failed` 三个数组齐全；部分成功返回 `200`（不是全有全无）。

> 实现注记：DSH 会话的硬删能力以 `sessionQuery` / `sessionPersistence` /
> `session.deleted` 事件的真实 API 为准。实现时必须先在 DSH 源码
> （app.asar 解包或 `E:\AI-code\DeepSeek Harness\resources\` 下 node_modules）里
> 核实删除入口，**不许臆造 API**；核实不到就降级为"归档 + 置空标题 + 标记"
> 并在响应 `archivedFallback` 里如实上报，前端把降级项显示为"已清理（归档保留）"。

### 9.4 归档箱专用列表

`GET /api/sessions?archived=1` 与 v3.0 的 `listSessions(archived=true)` 等价，
v3.1 明确归档箱 UI 用它 + 上面的删除接口组合实现。

### 9.5 会话权限模式（v3.1 新增：3 档可选）

聊天页顶部的「可写工作区 / 每步确认」标签升级为**可点击的权限选择器**，用户在 3 档里切换：

| mode | 含义 |
|---|---|
| `read-only` | 只读：AI 只能看，不能改任何文件 |
| `workspace-write` | 工作区：AI 可写工作区目录（默认） |
| `full-access` | 完全访问：全盘放开（APP 内需二次确认弹窗） |

```http
GET /api/sessions/:id/permission
→ { "mode": "workspace-write", "approval": "every-step" }
```

```http
PUT /api/sessions/:id/permission
{ "mode": "full-access" }
→ { "mode": "full-access" }
```

- `approval` 字段（每步确认/自动）若 DSH 无运行时修改入口，可只读返回、不可写。
- **实现红线**：必须先核实 DSH 真实 API（sandboxPolicy / approvalPolicy 如何随会话读写，
  参考 ds-bot 的 permissions.js、dsh-thinking-effort 的 refdir writePolicy、
  app.asar 里 sessionController 的会话头写入口）。核实不到运行时修改能力就返回
  `501 NOT_SUPPORTED` + 可读文案，APP 收到后隐藏选择器、标签保持只读展示。
- WS 推送：权限变化后广播 `session.updated`（v3 已有），APP 收到后刷新标签。

---

## 10. 公网接入方式多选（v3.2 设计：用户自选通道）

> 桌面桥支持 4 种公网通道，用户在桥配置/配对页自选；手机 APP 无感知（只认地址）。

| tunnelMode | 通道 | 依赖 | 地址形态 | 适用 |
|---|---|---|---|---|
| `quick` | Cloudflare 快速隧道 | cloudflared | `https://xxx.trycloudflare.com`（重启变） | 免费试用 |
| `named` | Cloudflare 命名隧道 | cloudflared + CF 域名+凭证 | `https://dsh.你的域名.com`（固定） | 个人长期自用（免费最省心） |
| `frp` | frp 自有 VPS | frpc（插件自动下载校验）+ VPS 上的 frps | `http(s)://vps地址:远程端口`（固定） | **最稳最流畅**（直连长连接，国内 VPS 延迟最低） |
| `relay` | 商业中转服务（订阅） | 授权服务下发凭证 | `wss://relay.xxx.com/<token>` | 商业化：订阅用户专属 |

配置形态（桥 config 增量）：
```yaml
tunnelMode: quick          # quick | named | frp | relay | off
publicUrl: ''              # named/frp/relay 模式的固定对外地址
frp:
  serverAddr: ''           # VPS IP/域名
  serverPort: 7000         # frps bind_port
  token: ''                # frps token
  remotePort: 0            # 0=由 frps 分配；桥读 frpc 输出回填 publicUrl
  useTls: false
relay:                     # v3.2 预留：订阅中转
  endpoint: ''
```

- frp 通道实现参照 dsh-console 的 frpc-bootstrap（自动下载 + size/sha256 双校验，落 `~/.dsh/phone-bridge/frpc/`，用户手放优先）
- 隧道/通道失败一律降级：桥继续监听局域网，APP 直连 LAN 地址不受影响；通道状态进 `/api/health`（`tunnelMode`/`tunnelUrl`/`tunnelError`）
- 选型建议写进配对页：国内 VPS frp 延迟最低（直连）；Named Tunnel 免维护；Quick 免费试用

> 实现注记（v3.2 落地）：frp 用 TCP 透传（Host 不可改写），因此仅本机路由
> （/api/pairing-code、/pair、/api/transport/mode）的判定加严为
> 「socket 回环 **且** Host 指向回环地址」——frp/quick/named 各公网通道的业务接口照常
> 放行，配对码对一切非本机直连 403（ROUTE_LOCAL_ONLY）。frpc 由桥托管：二进制从
> 官方 GitHub releases 下载并做 size/sha256 双校验（校验不过绝不落盘），
> 用户手放 ~/.dsh/phone-bridge/frpc/frpc.exe 永远优先；frpc.toml 含 token（600），
> token 不进日志/状态/健康检查。

### 10.1 通道扩展（v3.3：适配市面全部内网穿透，用户自选）

| tunnelMode | 覆盖的市场工具 | 用户操作 |
|---|---|---|
| `quick` | Cloudflare 快速隧道 | 无 |
| `named` | Cloudflare 固定域名 | 填 publicUrl |
| `frp` | **自建 frps / OpenFrp / 樱花Frp(natfrp) / Sunny-Ngrok / 宝塔frp**（全是 frp 协议，同一套 serverAddr/serverPort/token/remotePort） | 填服务商给的连接信息；配对页提供预设模板 |
| `custom` | **花生壳 / natapp / cpolar / zrok / locx / 任意工具**——用户自己跑客户端拿到地址 | 粘贴公网地址（http/https），桥校验格式+探活 |
| `ngrok` | ngrok 官方（免费静态域名） | 填 authtoken + 静态域名，桥自动下载托管 ngrok.exe |
| `relay` | 官方订阅中转（商业化） | 订阅后一键 |

新增接口（均仅本机）：
- `POST /api/transport/mode` 载荷扩展：`{ tunnelMode, publicUrl?, frp?, ngrok? }`，切换时可一并写入通道参数并持久化到 transport.json（frp/ngrok 的敏感字段 token/authtoken 只落盘不回显）
- `POST /api/transport/probe` `{ url }`：探活公网地址（对 `<url>/api/health` 发一次 GET，3s 超时），供 custom 模式粘贴后即时验证
- ngrok 托管：`~/.dsh/phone-bridge/ngrok/ngrok.exe` 自动下载（官方 releases，size/sha256 校验，用户手放优先）+ `ngrok config add-authtoken` + `ngrok http <桥端口> --domain=<静态域名> --response-header-add`；状态进 /api/health
- frp 预设模板（配对页展示，不落敏感数据）：openfrp/natfrp/sunny-ngrok/self 的字段说明与获取入口 URL
- 安全不变：custom/frp/ngrok 来源一律非本机 → 配对码/配对页 403；业务接口 Bearer 放行

### 9.6 审批策略可写（v3.4：每步确认/全自动 可切换）

PUT /api/sessions/:id/permission 的载荷新增 `approval` 字段：

```json
{ "approval": "every-step" }   // 或 "auto"
```

- `every-step` → DSH approval `ask`；`auto` → `never`
- 实现红线：先核实 dsh-user-approval / sessionController 的审批策略写入口
  （permissionPresets.set 会同时写 setSandboxMode + setApprovalPolicy；若存在
  独立的 setApprovalPolicy(session, policy) 公开路径则优先用它），核实不到就 501。
- GET 响应里 approval 字段同步反映当前值。

### 10.2 扫码配对（v3.5：手机扫电脑屏幕上的二维码，全自动配对）

二维码载荷（/pair 页二维码内容，桥侧已实现）：

```
dsh-phone://pair?url=<encodeURIComponent(局域网地址)>&code=<encodeURIComponent(6位码)>
```

APP 侧流程：
1. 连接页「扫码连接」→ 调 @kit.ScanKit `scanBarcode.startScan`（系统级扫码页，无需相机权限，支持相册导入）
2. 解析 `dsh-phone://pair?url=...&code=...` → 取地址与码
3. 自动建档案（名称=主机:端口 或用户补填）→ `POST <地址>/api/pair {code}` 换令牌 → 存档案 → 自动连接
4. 失败处理：取消扫码=静默返回；码过期→提示重取；限流→提示分钟数；非本应用载荷→提示无效码
