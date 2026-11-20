/**
 * DeepSeek Harness 手机桥 · 共享契约类型（v3）
 *
 * 这是手机端与桌面桥之间的唯一事实来源。改这里必须同步改：
 *   - 桌面桥：dsh-phone-bridge/contract/ 与仓库根目录
 *   - 鸿蒙端：dsh-harmony/entry/src/main/ets/contract/Contract.ets
 *
 * 版本策略：CONTRACT_VERSION 变化 = 不兼容变更；MIN_CONTRACT_VERSION 是
 * 桥仍能接受的最低客户端契约版本，低于它的连接必须被拒绝并提示升级。
 */

export const CONTRACT_VERSION = 3 as const;
export const MIN_CONTRACT_VERSION = 3 as const;
export const BRIDGE_VERSION = '3.8.3';
export const PROTOCOL = 'dsh-phone-bridge';

// ── 通用 ────────────────────────────────────────────────────────────────

/** 统一错误码（与 bridge/errors.js 的 ErrorCode 一一对应）。 */
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'PAIRING_DISABLED'
  | 'PAIRING_CODE_INVALID'
  | 'ROUTE_LOCAL_ONLY'
  | 'SESSION_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'ATTACHMENT_NOT_FOUND'
  | 'MEDIA_NOT_FOUND'
  | 'NOT_SUPPORTED'
  | 'INVALID_PARAM'
  | 'RATE_LIMITED'
  | 'DSH_ERROR'
  | 'BRIDGE_OFFLINE'
  | 'BRIDGE_INCOMPATIBLE'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

/** 所有失败响应的固定形状。 */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryAfter?: number;
    detail?: unknown;
  };
}

// ── 消息内容块 ──────────────────────────────────────────────────────────

/**
 * image / video 块的 attachmentId 有四种形态，客户端按前缀分流即可：
 *   - `sha256:<64hex>`        → GET /api/attachments/:id（v3.1 上传附件）
 *   - `media:<文件名>`         → GET /api/media/:id（v3.0 生视频，仅 $DSH_HOME/dsh-imagegen/videos/files）
 *   - `media:v1.<base64url>`  → GET /api/media/:id（v3.7 会话工作区任意媒体文件的绝对路径）
 * 客户端取 URL 时不要把 `media:` 前缀带进路径，桥端两种形态都接受。
 * 白名单外的路径一律 404 MEDIA_NOT_FOUND，不区分「不存在」与「无权限」。
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachmentId: string; mediaType: string; width: number; height: number; name: string }
  | { type: 'video'; attachmentId: string; mediaType: string; width: number; height: number; name: string }
  | { type: 'file'; attachmentId: string; name: string; bytes: number }
  | { type: 'toolCall'; id: string; name: string; arguments: string }
  | { type: 'toolAddition'; toolName: string }
  | { type: 'toolRemoval'; toolName: string };

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'developer';

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** 历史消息（REST 拉取）。 */
export interface WireMessage {
  id: string;
  seq: number;
  role: MessageRole;
  time: number;
  turn: number;
  step: number;
  blocks: ContentBlock[];
  text: string;
  provider?: string;
  model?: string;
  usage?: TokenUsage;
  interrupted?: boolean;
  callId?: string;
  toolName?: string;
  isError?: boolean;
  errorCode?: string;
  hidden?: boolean;
}

export interface WireTurn {
  turn: number;
  startedAt: number;
  ended: string;
  endedAt: number;
  errorMessage?: string;
  errorCode?: string;
}

export interface SessionMeta {
  preset: string;
  sandbox: string;
  approval: string;
  model?: { provider: string; model: string; reasoningEffort: string };
}

// ── 会话 ────────────────────────────────────────────────────────────────

export interface SessionListItem {
  sessionId: string;
  title: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd: string;
  parentSessionId: string;
  origin: string;
  agentAvailable: boolean;
  formatStatus: string;
  /** v3.5：最后一条 user/assistant 消息的单行预览（≤60 字，含末尾省略号；无消息为空串） */
  preview: string;
  /** v3.5：预览消息的角色；无消息为空串 */
  lastRole: '' | 'user' | 'assistant';
  /** 是否已归档（由 workspaceController 的全局归档集合计算） */
  archived: boolean;
  /** 是否已置顶（置顶会话排在列表最前） */
  pinned: boolean;
}

export interface SessionHeaderWire {
  sessionId: string;
  createdAt: number;
  cwd: string;
  isSeeded: boolean;
  origin: string;
  agentPreset: string;
  parentSessionId: string;
}

export interface SessionStateWire {
  cursor: number;
  active: boolean;
  running: boolean;
  pendingInput: string[];
  queue: { id: string; text: string }[];
}

export interface SessionDetail {
  session: SessionHeaderWire | null;
  title: string;
  state: SessionStateWire | null;
  meta: SessionMeta;
  messageCount: number;
  turnCount: number;
  updatedAt: number;
}

export interface HistoryPage {
  sessionId: string;
  title: string;
  messages: WireMessage[];
  turns: WireTurn[];
  meta: SessionMeta;
  hasMore: boolean;
  nextBeforeTurn: number;
}

// ── 模型 ────────────────────────────────────────────────────────────────

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort: string;
}

export interface ModelCatalogModel {
  id: string;
  name: string;
  description: string;
  badge: string;
  reasoning?: { efforts: string[]; defaultEffort: string };
}

export interface ModelCatalogGroup {
  id: string;
  name: string;
  models: ModelCatalogModel[];
}

export interface ModelCatalogResponse {
  default: ModelSelection;
  routableProviders: string[];
  groups: ModelCatalogGroup[];
  failures: number;
  current: ModelSelection;
}

// ── 配对与健康检查 ──────────────────────────────────────────────────────

export interface PairingCodeResponse {
  code: string;
  expiresAt: number;
  expiresInMs: number;
}

export interface PairRequest {
  code: string;
  clientName?: string;
}

export interface PairResponse {
  token: string;
  clientId: string;
  expiresAt: number;
  bridgeVersion: string;
  contractVersion: number;
}

export interface HealthResponse {
  status: 'ok';
  plugin: 'dsh-phone-bridge';
  version: string;
  bridgeVersion: string;
  contractVersion: number;
  protocol: string;
  minContractVersion: number;
  port: number;
  lanUrl: string;
  publicUrl: string;
  tunnelUrl: string;
  clients: number;
  cursor: number;
  pairingMode: string;
  time: number;
}

// ── WebSocket 事件信封 ──────────────────────────────────────────────────

/** 服务端 → 客户端统一信封。 */
export interface EventEnvelope {
  type: string;
  seq: number;
  sessionId?: string;
  timestamp: number;
  payload: Record<string, unknown>;
  /** DSH 侧的 per-session seq（若有），用于去重/对齐 */
  dshSeq?: number;
}

export type ServerEventType =
  | 'hello'
  | 'pong'
  | 'error'
  | 'subscribed'
  | 'sync.cursor'
  | 'sync.invalidated'
  | 'state.snapshot'
  | 'send.accepted'
  | 'stop.accepted'
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'session.status'
  | 'message.created'
  | 'message.done'
  | 'message.part'
  | 'turn.started'
  | 'turn.finished'
  | 'assistant.stream'
  | 'models.updated'
  | 'settings.updated';

/** 客户端 → 服务端指令。 */
export type ClientCommand =
  | { type: 'ping' }
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe' }
  | { type: 'sync'; cursor: number }
  | { type: 'state'; sessionId: string }
  | { type: 'send'; sessionId: string; text: string; attachments?: OutgoingAttachment[]; clientMessageId?: string; requestId?: string; mode?: 'queue' | 'steer'; clientTimeZone?: string }
  | { type: 'stop'; sessionId: string };

/** 流式增量帧（payload.frame）。 */
export type AssistantStreamFrame =
  | { type: 'start'; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: StreamChunk }
  | { type: 'end'; attemptId: string; revision: number; index: number; outcome: unknown };

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: unknown };

// ── REST 路由表（文档用） ───────────────────────────────────────────────

export const REST_ROUTES = [
  { method: 'GET', path: '/api/health', auth: false },
  { method: 'GET', path: '/api/version', auth: true },
  { method: 'POST', path: '/api/pair', auth: false, note: '隧道可达但防爆破：同源连续错 20 次锁 15 分钟（RATE_LIMITED）' },
  { method: 'GET', path: '/api/pairing-code', auth: false, loopbackOnly: true, note: '隧道流量（Host: dsh-phone-bridge-tunnel）一律 403 ROUTE_LOCAL_ONLY' },
  { method: 'GET', path: '/api/sessions', auth: true },
  { method: 'POST', path: '/api/sessions', auth: true },
  { method: 'GET', path: '/api/sessions/:id', auth: true },
  { method: 'PATCH', path: '/api/sessions/:id', auth: true },
  { method: 'DELETE', path: '/api/sessions/:id', auth: true, note: 'v3.1 起 ?purge=true 请求硬删（DSH 无硬删能力时降级归档并放 archivedFallback）' },
  { method: 'POST', path: '/api/sessions/batch-delete', auth: true, note: 'v3.1 批量硬删 {ids}，≤200 个，部分成功返回 200' },
  { method: 'GET', path: '/api/sessions/:id/messages', auth: true },
  { method: 'POST', path: '/api/sessions/:id/messages', auth: true, note: 'v3.1 载荷新增可选 attachments（≤9 个）' },
  { method: 'POST', path: '/api/sessions/:id/stop', auth: true },
  { method: 'GET', path: '/api/sessions/:id/state', auth: true },
  { method: 'GET', path: '/api/sessions/:id/permission', auth: true, note: 'v3.1 §9.5 当前权限模式 {mode, approval}' },
  { method: 'PUT', path: '/api/sessions/:id/permission', auth: true, note: 'v3.4 §9.6 运行时改权限 {mode?, approval?} 任意组合（approval: every-step↔ask / auto↔never）；成功后广播 session.updated' },
  { method: 'POST', path: '/api/uploads', auth: true, note: 'v3.1 原始字节流上传，X-File-Name（URL编码）+ X-Media-Type 头，上限 200MB' },
  { method: 'GET', path: '/api/attachments/:id', auth: true, note: 'v3.1 图片附件字节（sha256:<64hex>），支持 Range' },
  { method: 'GET', path: '/api/media/:id', auth: true, note: 'v3.7 媒体字节：media:v1.<base64url(绝对路径)> 指向会话工作区/工作区/生图目录内的文件；老形态 media:<文件名> 仍兼容。白名单外或非媒体扩展名一律 404/400，支持 Range' },
  { method: 'GET', path: '/api/files/:id', auth: true, note: 'v3.1 通用文件附件字节（sha256:<64hex>）' },
  { method: 'GET', path: '/api/models', auth: true },
  { method: 'GET', path: '/api/settings/model', auth: true },
  { method: 'PUT', path: '/api/settings/model', auth: true },
  { method: 'GET', path: '/api/workspaces', auth: true },
  { method: 'GET', path: '/api/transport', auth: true, note: 'v3.2 §10 公网通道状态' },
  { method: 'POST', path: '/api/transport/mode', auth: true, loopbackOnly: true, note: 'v3.3 §10.1 切换通道 {tunnelMode, publicUrl?, frp?, ngrok?, relay?}，参数随切持久化（token/authtoken 只落盘不回显）' },
  { method: 'POST', path: '/api/transport/probe', auth: true, loopbackOnly: true, note: '探活 {url} → 依次校验桥身份、contractVersion 与 /api/pairing-code 403 隔离 → TransportProbeResult' },
  { method: 'GET', path: '/api/sync', auth: true },
  { method: 'GET', path: '/api/search', auth: true },
  { method: 'GET', path: '/ws', auth: true, note: 'WebSocket，令牌走 ?token=' },
] as const;

// ── v3.1 增量：上传附件 + 归档删除 ─────────────────────────────────────

/** POST /api/uploads 响应 */
export interface UploadResult {
  attachmentId: string;
  mediaType: string;
  name: string;
  bytes: number;
  width: number;
  height: number;
  kind: 'image' | 'video' | 'file';
}

/** send / messages 载荷里的附件引用（attachments 数组元素） */
export interface OutgoingAttachment {
  attachmentId: string;
  name: string;
  mediaType: string;
  bytes: number;
}

/** 批量硬删响应 */
export interface BatchDeleteResult {
  purged: string[];
  archivedFallback: string[];
  failed: Array<{ id: string; code: string; message: string }>;
}

/** v3.1 §9.5 会话权限模式（3 档） */
export type SessionPermissionMode = 'read-only' | 'workspace-write' | 'full-access';

export interface SessionPermission {
  mode: SessionPermissionMode;
  approval?: 'every-step' | 'auto';
}

/** v3.4 §9.6：PUT 可写审批策略 */
export interface SessionPermissionPatch {
  mode?: SessionPermissionMode;
  approval?: 'every-step' | 'auto';
}

// ── v3.3 §10.1 通道扩展 ────────────────────────────────────────────────

export type TunnelMode = 'quick' | 'named' | 'frp' | 'custom' | 'ngrok' | 'relay' | 'off';

export interface NgrokTransportConfig {
  authtoken: string;
  staticDomain: string;
}

/** v3.8 §10.2 官方中转：密钥与配对码只落盘不回显。 */
export interface RelayTransportConfig {
  /** 中转服务地址，`wss://` 或 `https://`；留空用桥内置默认值。 */
  endpoint: string;
  token: string;
  /** 8 位 `[a-z0-9]`；留空由桥自动生成。 */
  pairCode: string;
}

export interface TransportProbeResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
  bridgeVersion?: string;
  contractVersion?: number;
}
