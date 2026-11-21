/**
 * dsh-phone-bridge · DSH 适配层
 *
 * 这是**唯一**直接与 DSH 服务交互的模块。上层（HTTP / WS / EventHub）只调用
 * 这里的方法，因此 DSH 内部 API 的任何变化都被收敛在本文件内。
 *
 * 所有 DSH 服务都通过 ctx.get(name) 取；取不到时抛 NOT_SUPPORTED，
 * 而不是让插件崩溃（任务书 2.2 节要求）。
 *
 * 证据等级：
 *  [官方源码] 方法名与参数结构取自 cordis Inspect 返回的 host Service 清单
 *  [实测]     参数/返回值已用本机 DSH 0.2.2-rc.1 真实会话日志与运行结果核对
 */

import { BridgeError, ErrorCode, asBridgeError } from '../bridge/errors.js';
import { lastChatMessage, mediaKindOf, mediaMimeOf, pageByTurns, previewOfBlocks, projectEvents } from './project.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_DIR_ENTRIES = 500;

/** v3.1：单文件上传上限（contract.md §9.1）。 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** v3.1：单条消息附件上限（contract.md §9.2）。 */
const MAX_ATTACHMENTS_PER_MESSAGE = 9;

/** v3.1：批量硬删一次最多处理的会话数（contract.md §9.3）。 */
const MAX_BATCH_DELETE = 200;

/** v3.5：会话列表预览补齐只覆盖列表前 N 个（contract.md §3.1 preview 注记）。 */
const PREVIEW_BACKFILL_LIMIT = 20;

/** v3.5：预览缓存上限（防长期运行无限增长；超出按插入序淘汰）。 */
const PREVIEW_CACHE_LIMIT = 1000;

/** `media:v1.<base64url(绝对路径)>` 剥掉 `media:` 后的版本前缀。 */
const MEDIA_ID_V1 = 'v1.';

/** v3.7：媒体白名单根的缓存时长（毫秒）。 */
const MEDIA_ROOTS_TTL = 60 * 1000;

/**
 * v3.1 §9.5 会话权限 3 档 ↔ DSH 旋钮值的映射。
 * [官方源码] SANDBOX_MODES = ['read-only','workspace-write','danger-full-access']
 * （dsh-sandbox-policy/src/session-mode.ts:44）；
 * approval 只有 'ask' | 'never'（dsh-user-approval/src/index.ts:119）。
 * 契约的 full-access ↔ DSH 的 danger-full-access（同一档位，叫法不同）。
 */
const PERMISSION_MODES = ['read-only', 'workspace-write', 'full-access'];
const MODE_TO_SANDBOX = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'full-access': 'danger-full-access',
};
const SANDBOX_TO_MODE = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'danger-full-access': 'full-access',
};
const APPROVAL_TO_WIRE = { ask: 'every-step', never: 'auto' };
/** v3.4 §9.6：手机端 approval 值 → DSH 审批策略（APPROVAL_POLICIES = ['ask','never']）。 */
const WIRE_TO_APPROVAL = { 'every-step': 'ask', auto: 'never' };

/** 上传时探测宽高用较大的文件头；下载只需识别 MIME，不读取图片像素。 */
const IMAGE_HEAD_BYTES = 256 * 1024;
const DOWNLOAD_HEAD_BYTES = 256;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 安全的 home 目录（取不到就返回空串，不抛）。 */
function safeHomedir() {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

/** 枚举 Windows 盘符（A: - Z:，只保留存在的）。 */
function listWindowsDrives() {
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) {
        drives.push({ name: root, path: root, isDir: true });
      }
    } catch {
      // 忽略无权限的盘符
    }
  }
  return drives;
}

/** 读取某目录下的子目录（过滤系统目录，按名称排序，最多 MAX_DIR_ENTRIES 条）。 */
async function readSubDirectories(abs) {
  let dirents;
  try {
    dirents = await fs.promises.readdir(abs, { withFileTypes: true });
  } catch {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `无法读取目录：${abs}`);
  }
  const out = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    if (name === 'System Volume Information' || name === '$Recycle.Bin' || name === 'node_modules') continue;
    out.push({ name, path: path.join(abs, name), isDir: true });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return out.length > MAX_DIR_ENTRIES ? out.slice(0, MAX_DIR_ENTRIES) : out;
}

/** 下载时只看少量文件头。内容寻址对象没有扩展名，不能猜成 PNG。 */
function imageMediaTypeOfHead(head) {
  if (head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  const tag = head.toString('latin1', 0, 16);
  if (tag.startsWith('GIF87a') || tag.startsWith('GIF89a')) return 'image/gif';
  if (tag.startsWith('RIFF') && tag.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 14 && tag.startsWith('BM') && head.readUInt16LE(6) === 0 && head.readUInt16LE(8) === 0) return 'image/bmp';
  if (tag.slice(4, 8) === 'ftyp') {
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(tag.slice(8, 12))) return 'image/heic';
    if (/^(avif|avis)$/.test(tag.slice(8, 12))) return 'image/avif';
  }
  return '';
}

function videoMediaTypeOfHead(head) {
  const tag = head.toString('latin1', 0, 16);
  if (tag.startsWith('RIFF') && tag.slice(8, 12) === 'AVI ') return 'video/x-msvideo';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) {
    return head.includes('webm') ? 'video/webm' : 'video/x-matroska';
  }
  if (tag.slice(4, 8) !== 'ftyp') return '';
  const brand = tag.slice(8, 12);
  if (brand === 'qt  ') return 'video/quicktime';
  if (brand.startsWith('3gp')) return 'video/3gpp';
  if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash|hvc1|hev1)$/.test(brand)) return 'video/mp4';
  return '';
}

/** 解析 PNG 头部里的宽高（IHDR 块固定紧跟签名）。拿不到返回 null，不抛。 */
function parsePngDimensions(head) {
  if (head === undefined || head.length < 24) return null;
  if (!head.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const isIhdr = head[12] === 0x49 && head[13] === 0x48 && head[14] === 0x44 && head[15] === 0x52;
  if (!isIhdr) return null;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 解析 JPEG SOFn 段里的宽高（逐段走 marker，最多扫文件头 IMAGE_HEAD_BYTES）。
 * 拿不到（SOF 超出扫描窗口 / 数据异常）返回 null，不抛。
 */
function parseJpegDimensions(head) {
  if (head === undefined || head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= head.length) {
    if (head[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let cursor = offset + 1;
    while (cursor < head.length && head[cursor] === 0xff) cursor += 1;
    if (cursor >= head.length) return null;
    const marker = head[cursor];
    // 填充 / 独立 marker：继续走
    if (marker === 0x00 || marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = cursor + 1;
      continue;
    }
    // EOI 或 SOS：尺寸信息必须在扫描数据之前，到这就别再找了
    if (marker === 0xd9 || marker === 0xda) return null;
    // SOFn（C0-CF，排除 DHT/JPG/DAC）：[len2][precision1][height2][width2]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (cursor + 8 > head.length) return null;
      const height = head.readUInt16BE(cursor + 4);
      const width = head.readUInt16BE(cursor + 6);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    const segmentLength = cursor + 3 <= head.length ? head.readUInt16BE(cursor + 1) : 0;
    if (segmentLength < 2) return null;
    offset = cursor + 1 + segmentLength;
  }
  return null;
}

/** 读取文件头部若干字节（不足则读到的为准）。 */
async function readFileHead(file, bytes = IMAGE_HEAD_BYTES) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(bytes, 8 * 1024 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 从字节头识别图片并尽量取宽高，识别不出时返回 null。
 * 宽高只解析 PNG/JPEG（contract.md §9.1），其余图片宽高填 0。
 */
function sniffImageHead(head) {
  if (head === undefined) return null;
  const mediaType = imageMediaTypeOfHead(head);
  if (!mediaType) return null;
  const dimensions = mediaType === 'image/png' ? parsePngDimensions(head)
    : mediaType === 'image/jpeg' ? parseJpegDimensions(head) : null;
  return { mediaType, width: dimensions?.width ?? 0, height: dimensions?.height ?? 0 };
}

/** 解码 X-File-Name（URL 编码），失败时原样返回；顺手剥掉目录成分。 */
function decodeUploadName(raw) {
  let name = typeof raw === 'string' ? raw : '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // 保留原始值
  }
  name = name.replace(/\\/g, '/').split('/').pop() ?? '';
  if (name.length > 255) name = name.slice(0, 255);
  return name;
}

/**
 * DSH 的 @Remote 方法内部会调用 signal.throwIfAborted()，
 * 传 undefined 会抛 "Cannot read properties of undefined (reading 'throwIfAborted')"。
 * 所以每次 RPC 都必须给一个真实的 AbortSignal（可带超时）。
 */
function newSignal(timeoutMs) {
  const controller = new AbortController();
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  return controller.signal;
}

/** 把 DSH 的 SessionSummary 规范化成手机线会话对象（不含标题，标题由上层补）。 */
function summaryToWire(summary) {
  return {
    sessionId: typeof summary.sessionId === 'string' ? summary.sessionId : '',
    updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
    running: summary.running === true,
    blank: summary.blank === true,
    cwd: typeof summary.cwd === 'string' ? summary.cwd : '',
    parentSessionId: typeof summary.parentSessionId === 'string' ? summary.parentSessionId : '',
    origin: typeof summary.origin === 'string' ? summary.origin : '',
    agentAvailable: summary.agentAvailable !== false,
    formatStatus: typeof summary.formatStatus === 'string' ? summary.formatStatus : '',
  };
}

function headerToWire(header) {
  if (header === null || typeof header !== 'object') return null;
  return {
    sessionId: typeof header.id === 'string' ? header.id : '',
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    isSeeded: header.isSeeded === true,
    origin: typeof header.origin === 'string' ? header.origin : '',
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
    parentSessionId:
      header.parentSession !== null && typeof header.parentSession === 'object'
        && typeof header.parentSession.sessionId === 'string'
        ? header.parentSession.sessionId
        : '',
  };
}

export class DshAdapter {
  /**
   * @param {object} ctx cordis 上下文
   * @param {{ log?: (msg: string) => void }} options
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    // 归档 / 置顶是 workspace 注册表的「全局集合」，SessionSummary 上并不带这两个字段，
    // 只能从 workspaceController.follow() 的 baseline 与增量里维护（见 startWorkspaceWatch）。
    this.archivedIds = new Set();
    this.pinnedIds = new Set();
    this.workspaceOrder = [];
    this._watchAbort = null;
    // v3.5：会话列表「最后一条消息预览」。DSH 的 sessionController.list() /
    // sessionQuery.listSessions() 都不带 lastMessage/preview 列（app.asar 源码核实：
    // dsh-api-session-controller/lib/index.js summaryFor() 只有 sessionId/updatedAt/
    // agentAvailable/formatStatus/running/blank/listFields/projections；sessionQuery
    // 只回 header），dsh-session-query-sqlite 是 FTS5 搜索引擎（只有 searchSessions/
    // searchEvents），所以预览由桥自维护：事件实时更新 + 启动/列表时批量补齐。
    this.previewCache = new Map();
    this._previewQueue = [];
    this._previewQueued = new Set();
    this._previewInFlight = new Set();
    this._previewDrainPromise = null;
    this._previewWarmed = false;
    // 手机端选择的默认模型。DSH 的 agentDefaultModel.saveSelection() 在插件内调用时
    // 会因 HMR 事务嵌套而失败（"HMR transactions cannot be nested"），
    // 所以这里单独持久化一份「桥偏好模型」，在新建会话时套用到会话上。
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.modelFile = path.join(home, 'phone-bridge', 'model.json');
    this.preferredModel = this.readPreferredModel();
    // v3.7：/api/media 白名单根缓存（见 mediaRoots()）
    this._mediaRoots = null;
  }

  /** 读取桥偏好模型（容错，读不到返回空）。 */
  readPreferredModel() {
    try {
      if (!fs.existsSync(this.modelFile)) return { provider: '', model: '', reasoningEffort: '' };
      const parsed = JSON.parse(fs.readFileSync(this.modelFile, 'utf8'));
      return {
        provider: typeof parsed.provider === 'string' ? parsed.provider : '',
        model: typeof parsed.model === 'string' ? parsed.model : '',
        reasoningEffort: typeof parsed.reasoningEffort === 'string' ? parsed.reasoningEffort : '',
      };
    } catch (error) {
      this.log(`读取偏好模型失败: ${error instanceof Error ? error.message : String(error)}`);
      return { provider: '', model: '', reasoningEffort: '' };
    }
  }

  /** 写入桥偏好模型。 */
  writePreferredModel(selection) {
    try {
      fs.mkdirSync(path.dirname(this.modelFile), { recursive: true });
      fs.writeFileSync(this.modelFile, JSON.stringify(selection, null, 2), 'utf8');
    } catch (error) {
      this.log(`保存偏好模型失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 订阅 workspace 变更流，维护归档 / 置顶集合。
   * [官方源码] workspaceController.follow(signal) → baseline{items,archivedSessionIds,pinnedSessionIds}
   *           增量：replace / upsert / remove / order / archived / pinned
   */
  startWorkspaceWatch() {
    const controller = this.optional('workspaceController');
    if (controller === undefined || typeof controller.follow !== 'function') return;
    if (this._watchAbort !== null) return;
    const abort = new AbortController();
    this._watchAbort = abort;
    const apply = (value) => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value.archivedSessionIds)) {
        this.archivedIds = new Set(value.archivedSessionIds.filter((id) => typeof id === 'string'));
      }
      if (Array.isArray(value.pinnedSessionIds)) {
        this.pinnedIds = new Set(value.pinnedSessionIds.filter((id) => typeof id === 'string'));
      }
    };
    const run = async () => {
      try {
        for await (const frame of controller.follow(abort.signal)) {
          if (frame === null || typeof frame !== 'object') continue;
          if (frame.type === 'baseline' || frame.type === 'replace') {
            apply(frame.value);
          } else if (frame.type === 'archived') {
            this.archivedIds = new Set(
              (Array.isArray(frame.archivedSessionIds) ? frame.archivedSessionIds : []).filter((id) => typeof id === 'string'),
            );
          } else if (frame.type === 'pinned') {
            this.pinnedIds = new Set(
              (Array.isArray(frame.pinnedSessionIds) ? frame.pinnedSessionIds : []).filter((id) => typeof id === 'string'),
            );
          }
        }
      } catch (error) {
        if (abort.signal.aborted !== true) {
          this.log(`workspace follow 中断: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    void run();
  }

  /** 停止 workspace 订阅（插件卸载时调用）。 */
  stopWorkspaceWatch() {
    if (this._watchAbort !== null) {
      this._watchAbort.abort();
      this._watchAbort = null;
    }
  }

  /** 取服务，取不到就抛 NOT_SUPPORTED。 */
  require(name) {
    const service = this.ctx.get(name);
    if (service === undefined || service === null) {
      throw new BridgeError(ErrorCode.NOT_SUPPORTED, `DSH 服务 ${name} 不可用`, {
        detail: { service: name },
      });
    }
    return service;
  }

  /** 取服务，取不到返回 undefined（可选依赖用）。 */
  optional(name) {
    const service = this.ctx.get(name);
    return service === undefined ? undefined : service;
  }

  /** DSH home 目录（每次调用时取，方便测试隔离 $DSH_HOME）。 */
  dshHome() {
    return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh');
  }

  /** 附件对象根目录：$DSH_HOME/attachments/v1。 */
  attachmentsRoot() {
    return path.join(this.dshHome(), 'attachments', 'v1');
  }

  // ── 会话列表 ───────────────────────────────────────────────────────────

  /**
   * 列出全部可见会话，并补上标题。
   * [官方源码] sessionController.list() → { items: SessionSummary[] }
   * [官方源码] sessionQuery.readTitleSnapshots(ids) → [{sessionId,status,value:{session,title?}}]
   */
  async listSessions(archived = false, options = {}) {
    try {
      let items = [];
      const controller = this.optional('sessionController');
      if (controller !== undefined && typeof controller.list === 'function') {
        const value = await controller.list({}, newSignal(15000));
        if (value !== null && typeof value === 'object' && Array.isArray(value.items)) {
          items = value.items;
        }
      } else {
        // 退回 sessionQuery（无 running / updatedAt，用 createdAt 兜底）
        const query = this.require('sessionQuery');
        const records = await query.listSessions(newSignal(15000));
        items = (Array.isArray(records) ? records : []).map((record) => {
          const header = record !== null && typeof record === 'object' && record.header !== undefined
            ? record.header
            : {};
          return {
            sessionId: typeof header.id === 'string' ? header.id : '',
            updatedAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
            running: false,
            blank: false,
            cwd: typeof header.cwd === 'string' ? header.cwd : '',
            agentAvailable: true,
          };
        });
      }

      const sessions = items.map(summaryToWire).filter((item) => item.sessionId.length > 0);
      const titles = await this.readTitles(sessions.map((item) => item.sessionId));
      const withTitle = sessions.map((item) => {
        const title = titles.get(item.sessionId) ?? '';
        return { ...item, title };
      });
      // 归档 / 置顶由 workspace 集合决定；归档箱只返回归档过的，主列表排除它们。
      const wantArchived = archived === true;
      const filtered = withTitle.filter((item) => this.archivedIds.has(item.sessionId) === wantArchived);
      const pinnedRank = (item) => (this.pinnedIds.has(item.sessionId) ? 0 : 1);
      filtered.sort((a, b) => {
        const rankDiff = pinnedRank(a) - pinnedRank(b);
        if (rankDiff !== 0) return rankDiff;
        if (!!a.running !== !!b.running) return a.running ? -1 : 1;
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      });
      // v3.5：缓存缺失的会话排在最前的（≤20 个）进后台补齐队列，不阻塞本次响应。
      // 媒体白名单只借用 cwd，不需要预览，用 skipPreview 避免在媒体请求路径上产生额外日志读取。
      if (options.skipPreview !== true) this.schedulePreviewBackfill(filtered);
      return filtered.map((item) => {
        const entry = this.previewCache.get(item.sessionId);
        return {
          ...item,
          preview: entry !== undefined ? entry.text : '',
          lastRole: entry !== undefined ? entry.role : '',
          archived: this.archivedIds.has(item.sessionId),
          pinned: this.pinnedIds.has(item.sessionId),
        };
      });
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  /** 批量取标题：Map<sessionId, title> */
  async readTitles(sessionIds) {
    const map = new Map();
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return map;
    const query = this.optional('sessionQuery');
    if (query === undefined || typeof query.readTitleSnapshots !== 'function') return map;
    try {
      const results = await query.readTitleSnapshots(sessionIds, newSignal(15000));
      for (const result of Array.isArray(results) ? results : []) {
        if (result === null || typeof result !== 'object') continue;
        if (result.status !== 'fulfilled') continue;
        const sessionId = typeof result.sessionId === 'string' ? result.sessionId : '';
        const value = result.value !== null && typeof result.value === 'object' ? result.value : {};
        const title = value.title !== null && typeof value.title === 'object' && typeof value.title.title === 'string'
          ? value.title.title
          : '';
        if (sessionId.length > 0) map.set(sessionId, title);
      }
    } catch (error) {
      this.log(`readTitleSnapshots 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return map;
  }

  // ── v3.5：会话列表「最后一条消息预览」缓存 ─────────────────────────────

  /**
   * 实时更新入口（index.js 把 EventHub 的事件订阅喂进来）。
   * 只认 message.created（user 气泡入库）与 message.done（assistant 完成）；
   * tool 走 message.part，不进预览（lastRole 契约只有 user|assistant）。
   * @param {{ type: string, sessionId?: string, dshSeq?: number, payload?: object }} envelope
   */
  observePreviewEvent(envelope) {
    if (envelope === null || typeof envelope !== 'object') return;
    if (envelope.type !== 'message.created' && envelope.type !== 'message.done') return;
    const sessionId = typeof envelope.sessionId === 'string' ? envelope.sessionId : '';
    if (sessionId.length === 0) return;
    const payload = envelope.payload !== null && typeof envelope.payload === 'object' ? envelope.payload : {};
    const role = payload.role === 'assistant' ? 'assistant' : 'user';
    const text = previewOfBlocks(payload.blocks);
    // dshSeq 是 DSH 侧 per-session 事件 seq，与 getHistoryPage 回的 message.seq
    // 同一序号空间，用它挡住乱序/回放事件覆盖较新的缓存。
    const seq = typeof envelope.dshSeq === 'number' && envelope.dshSeq > 0 ? envelope.dshSeq : undefined;
    this.setPreview(sessionId, text, role, seq);
  }

  /** 写缓存（seq 单调保护 + 容量上限）。 */
  setPreview(sessionId, text, role, seq) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const current = this.previewCache.get(sessionId);
    if (current !== undefined && typeof current.seq === 'number'
      && typeof seq === 'number' && seq <= current.seq) {
      return;
    }
    if (current === undefined && this.previewCache.size >= PREVIEW_CACHE_LIMIT) {
      const oldest = this.previewCache.keys().next();
      if (oldest.done !== true) this.previewCache.delete(oldest.value);
    }
    this.previewCache.set(sessionId, { text, role, seq });
  }

  /**
   * 把排好序的会话列表里缓存缺失的前 PREVIEW_BACKFILL_LIMIT 个排进补齐队列
   * （fire-and-forget，不阻塞调用方）。空会话（blank）没有用户气泡，跳过省一次日志读取。
   */
  schedulePreviewBackfill(items, limit = PREVIEW_BACKFILL_LIMIT) {
    const candidates = Array.isArray(items) ? items.slice(0, limit) : [];
    let queued = false;
    for (const item of candidates) {
      const sessionId = item !== null && typeof item === 'object' ? item.sessionId : undefined;
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
      if (item.blank === true) continue;
      if (this.previewCache.has(sessionId)) continue;
      if (this._previewQueued.has(sessionId) || this._previewInFlight.has(sessionId)) continue;
      this._previewQueued.add(sessionId);
      this._previewQueue.push(sessionId);
      queued = true;
    }
    if (queued) this.drainPreviewQueue();
  }

  /**
   * 顺序消费补齐队列（单飞：并发调用共用同一个在跑的 promise）。
   * 每项复用 getHistoryPage({turns:1}) 取最新 turn，取最后一条 user/assistant 消息
   * 生成预览；读不到（已删/无 turn）就落一个空串占位，避免同一会话反复重读。
   */
  drainPreviewQueue() {
    if (this._previewDrainPromise !== null) return this._previewDrainPromise;
    this._previewDrainPromise = (async () => {
      try {
        for (;;) {
          const sessionId = this._previewQueue.shift();
          if (sessionId === undefined) break;
          this._previewQueued.delete(sessionId);
          this._previewInFlight.add(sessionId);
          try {
            const page = await this.getHistoryPage(sessionId, { turns: 1 });
            const last = lastChatMessage(page.messages);
            if (last !== undefined) {
              this.setPreview(
                sessionId,
                previewOfBlocks(last.blocks),
                last.role === 'assistant' ? 'assistant' : 'user',
                typeof last.seq === 'number' && last.seq > 0 ? last.seq : undefined,
              );
            } else {
              this.setPreview(sessionId, '', '', 0);
            }
          } catch (error) {
            // 读不到（已删/瞬时错误）也落空串占位，避免每次列表都重读同一个坏会话；
            // 后续真实消息事件（seq > 0）仍会正常覆盖。
            this.setPreview(sessionId, '', '', 0);
            this.log(`预览补齐失败(${sessionId}): ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            this._previewInFlight.delete(sessionId);
          }
        }
      } finally {
        this._previewDrainPromise = null;
      }
    })();
    return this._previewDrainPromise;
  }

  /**
   * 启动预热：拉一次列表，对前 PREVIEW_BACKFILL_LIMIT 个缺失会话补齐预览
   * （index.js boot 里 fire-and-forget）。只跑一次。
   */
  async warmPreviewCache() {
    if (this._previewWarmed) return;
    this._previewWarmed = true;
    try {
      const sessions = await this.listSessions(false);
      this.schedulePreviewBackfill(sessions);
      await this.drainPreviewQueue();
    } catch (error) {
      this.log(`预览预热失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 单个会话 ───────────────────────────────────────────────────────────

  /** 读单个会话的头部信息与最新运行状态。 */
  async getSession(sessionId) {
    try {
      const query = this.require('sessionQuery');
      const snapshot = await query.readSession(sessionId);
      if (snapshot === null || typeof snapshot !== 'object') {
        throw new BridgeError(ErrorCode.SESSION_NOT_FOUND, '会话不存在', { detail: { sessionId } });
      }
      const header = headerToWire(snapshot.session);
      const titles = await this.readTitles([sessionId]);
      let state = null;
      const controller = this.optional('sessionController');
      if (controller !== undefined && typeof controller.state === 'function') {
        try {
          const value = await controller.state({ sessionId }, newSignal(15000));
          if (value !== null && typeof value === 'object') {
            state = {
              cursor: typeof value.cursor === 'number' ? value.cursor : 0,
              active: value.active === true,
              running: value.running === true,
              pendingInput: Array.isArray(value.pendingInput) ? value.pendingInput.slice() : [],
              queueSize: Array.isArray(value.queue) ? value.queue.length : 0,
            };
          }
        } catch (error) {
          this.log(`读取会话状态失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // 传 cwd：会话正文里的相对媒体路径要靠它展开（见 project.js resolveLocalPath）。
      const projected = projectEvents(snapshot.events, { cwd: header !== null ? header.cwd : '' });
      return {
        session: header,
        title: titles.get(sessionId) ?? projected.title,
        state,
        meta: projected.meta,
        messageCount: projected.messages.length,
        turnCount: projected.turns.length,
        updatedAt: projected.turns.length > 0
          ? projected.turns[projected.turns.length - 1].startedAt
          : (header !== null ? header.createdAt : 0),
      };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  /** 按 turn 分页读历史消息。 */
  async getHistoryPage(sessionId, options = {}) {
    try {
      const query = this.require('sessionQuery');
      const snapshot = await query.readSession(sessionId);
      if (snapshot === null || typeof snapshot !== 'object') {
        throw new BridgeError(ErrorCode.SESSION_NOT_FOUND, '会话不存在', { detail: { sessionId } });
      }
      const header = headerToWire(snapshot.session);
      const page = pageByTurns(snapshot.events, {
        turns: options.turns,
        beforeTurn: options.beforeTurn,
        // 相对媒体路径按会话工作区展开（见 project.js resolveLocalPath）。
        cwd: header !== null ? header.cwd : '',
      });
      const titles = await this.readTitles([sessionId]);
      return {
        sessionId,
        title: titles.get(sessionId) ?? page.title,
        messages: page.messages,
        turns: page.turns,
        meta: page.meta,
        hasMore: page.hasMore,
        nextBeforeTurn: page.nextBeforeTurn,
      };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  // ── 会话变更 ───────────────────────────────────────────────────────────

  /**
   * 新建会话。
   * [官方源码] sessionController.create({workspaceId?, cwd?, sessionId?, agentPreset?})
   */
  async createSession(options = {}) {
    try {
      const controller = this.require('sessionController');
      const request = {};
      if (typeof options.cwd === 'string' && options.cwd.length > 0) request.cwd = options.cwd;
      if (typeof options.workspaceId === 'string' && options.workspaceId.length > 0) {
        request.workspaceId = options.workspaceId;
      }
      if (typeof options.agentPreset === 'string' && options.agentPreset.length > 0) {
        request.agentPreset = options.agentPreset;
      }

      if (request.workspaceId === undefined && typeof controller.initializeDefaultModel === 'function') {
        // 没有指定工作区时，先用默认工作区，否则 create 可能失败
        try {
          await controller.initializeDefaultModel();
        } catch (error) {
          this.log(`initializeDefaultModel 失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const value = await controller.create(request);
      const sessionId = value !== null && typeof value === 'object' && typeof value.sessionId === 'string'
        ? value.sessionId
        : '';
      if (sessionId.length === 0) {
        throw new BridgeError(ErrorCode.DSH_ERROR, 'DSH 未返回新会话 id');
      }
      if (typeof options.title === 'string' && options.title.length > 0) {
        try {
          await this.renameSession(sessionId, options.title);
        } catch (error) {
          this.log(`新建会话后设置标题失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // 套用桥偏好模型（手机端在模型页选过的默认模型）
      if (this.preferredModel.model.length > 0) {
        try {
          await controller.selectModel({
            sessionId,
            provider: this.preferredModel.provider,
            model: this.preferredModel.model,
            ...(this.preferredModel.reasoningEffort.length > 0
              ? { reasoningEffort: this.preferredModel.reasoningEffort }
              : {}),
          });
        } catch (error) {
          this.log(`新会话套用偏好模型失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { sessionId };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  /** 重命名。优先走 sessionTitle.rename(session,title)，退回 sessionController.rename。 */
  async renameSession(sessionId, title) {
    try {
      const cleanTitle = typeof title === 'string' ? title.trim() : '';
      if (cleanTitle.length === 0) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, '标题不能为空');
      }
      const titleService = this.optional('sessionTitle');
      const liveStore = this.optional('sessions');
      // sessionTitle.rename 需要「活着的 Session 实例」，不是 sessionQuery 返回的
      // SessionHeader（那是纯数据）。传错会报 `session "..." is not live in this store`。
      if (titleService !== undefined && typeof titleService.rename === 'function'
        && liveStore !== undefined && typeof liveStore.get === 'function') {
        const live = liveStore.get(sessionId);
        if (live !== undefined && live !== null) {
          try {
            await titleService.rename(live, cleanTitle);
            return { sessionId, title: cleanTitle };
          } catch (error) {
            this.log(`sessionTitle.rename 失败，回退 sessionController.rename: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      const controller = this.require('sessionController');
      await controller.rename({ sessionId, title: cleanTitle });
      return { sessionId, title: cleanTitle };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  async archiveSession(sessionId, stopActivity) {
    try {
      const workspace = this.require('workspaceController');
      const value = await workspace.archiveSession({
        sessionId,
        stopActivity: stopActivity === true,
      });
      return {
        sessionId,
        archivedSessionIds: value !== null && typeof value === 'object' && Array.isArray(value.archivedSessionIds)
          ? value.archivedSessionIds.slice()
          : [],
      };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  async unarchiveSession(sessionId) {
    try {
      const workspace = this.require('workspaceController');
      await workspace.unarchiveSession({ sessionId });
      return { sessionId };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  async pinSession(sessionId) {
    try {
      const workspace = this.require('workspaceController');
      const value = await workspace.pinSession({ sessionId });
      return {
        sessionId,
        pinnedSessionIds: value !== null && typeof value === 'object' && Array.isArray(value.pinnedSessionIds)
          ? value.pinnedSessionIds.slice()
          : [],
      };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  async unpinSession(sessionId) {
    try {
      const workspace = this.require('workspaceController');
      await workspace.unpinSession({ sessionId });
      return { sessionId };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  /**
   * 硬删一个会话（contract.md §9.3 DELETE ?purge=true）。
   *
   * DSH 删除能力核实结论（app.asar 源码，2026-11-14，DSH 0.2.x）：
   *   - SessionPersistence 抽象服务只有 create/open/flush/stat/list
   *     （dsh-session-persistence/src/index.ts:144），「append-only、从不重写」是写死的语义；
   *     具体实现 JsonlSessionPersistence 也没有任何删除方法
   *     （dsh-session-persistence-jsonl/src/index.ts:291）。
   *   - SessionStore（sessions 服务）只有 create/prepare/enter/announce/flush/get/list/fork
   *     （dsh-session/src/index.ts:1144）；session/disposed 仅由创建方 fiber 内部的
   *     detach 能力触发，外部拿不到。
   *   - workspaceController 只有 archiveSession/unarchiveSession/pinSession/unpinSession
   *     等（dsh-api-workspace-controller/src/index.ts:91-191），其 delete 是删工作区，不是会话。
   *   - session-query-sqlite 的 _deleteSession 是私有方法，只在检索索引对账时清理
   *     （dsh-session-query-sqlite/src/index.ts:571）。
   *   - api-session/removed（桥的 session.deleted 推送来源）只在 session/disposed 时发出
   *     （dsh-api-session-controller/src/index.ts:227-229）；DSH 自带 UI 也没有删除会话入口。
   *
   * 结论：DSH 0.2.x 没有对外可用的会话硬删能力。按契约降级：
   *   归档（stopActivity）+ 尽力清空标题 + 在响应 archivedFallback 里如实上报。
   *   DSH 明确拒绝空标题（dsh-session-title/src/index.ts:411-421 SessionTitleInvalidError），
   *   清标题步骤预期失败并被吞掉，仅为前向兼容保留。
   *
   * @returns {Promise<{sessionId: string, purged: boolean, archivedFallback: boolean}>}
   */
  async purgeSession(sessionId) {
    try {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (id.length === 0) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, '缺少 sessionId');
      }
      const query = this.require('sessionQuery');
      const snapshot = await query.readSession(id);
      if (snapshot === null || typeof snapshot !== 'object') {
        throw new BridgeError(ErrorCode.SESSION_NOT_FOUND, '会话不存在', { detail: { sessionId: id } });
      }
      await this.archiveSession(id, true);
      try {
        const controller = this.optional('sessionController');
        if (controller !== undefined && typeof controller.rename === 'function') {
          await controller.rename({ sessionId: id, title: '' });
        }
      } catch (error) {
        this.log(`清空会话标题失败（DSH 拒绝空标题，属预期）: ${error instanceof Error ? error.message : String(error)}`);
      }
      // DSH 无硬删入口：purged 恒为 false，绝不假装删成功。
      return { sessionId: id, purged: false, archivedFallback: true };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  /**
   * 批量硬删（contract.md §9.3 POST /api/sessions/batch-delete）。
   * 部分成功返回 200：purged / archivedFallback / failed 三个数组齐全。
   */
  async batchDeleteSessions(ids) {
    if (!Array.isArray(ids)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, 'ids 必须是字符串数组');
    }
    if (ids.length > MAX_BATCH_DELETE) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `批量删除一次最多 ${MAX_BATCH_DELETE} 个会话`);
    }
    const result = { purged: [], archivedFallback: [], failed: [] };
    const seen = new Set();
    for (const raw of ids) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      try {
        const outcome = await this.purgeSession(id);
        if (outcome.purged === true) result.purged.push(id);
        else result.archivedFallback.push(id);
      } catch (error) {
        const bridgeError = asBridgeError(error);
        result.failed.push({ id, code: bridgeError.code, message: bridgeError.message });
      }
    }
    return result;
  }

  /** 搜索会话。 */
  async search(query) {
    try {
      const text = typeof query === 'string' ? query.trim() : '';
      if (text.length === 0) return { items: [], hasMore: false };
      const controller = this.require('sessionController');
      const value = await controller.search({ query: text }, newSignal(20000));
      const items = value !== null && typeof value === 'object' && Array.isArray(value.items) ? value.items : [];
      const titles = await this.readTitles(
        items
          .map((item) => (item !== null && typeof item === 'object' && typeof item.sessionId === 'string' ? item.sessionId : ''))
          .filter((id) => id.length > 0),
      );
      return {
        items: items.map((item) => {
          const sessionId = item !== null && typeof item === 'object' && typeof item.sessionId === 'string'
            ? item.sessionId
            : '';
          return {
            sessionId,
            title: titles.get(sessionId) ?? '',
            snippet: item !== null && typeof item === 'object' && typeof item.snippet === 'string' ? item.snippet : '',
          };
        }),
        hasMore: value !== null && typeof value === 'object' && value.hasMore === true,
      };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  // ── 发消息 / 停止 ──────────────────────────────────────────────────────

  /**
   * 校验并解析手机端发来的附件引用列表（contract.md §9.2）。
   *
   * 规则：
   *   - 最多 9 个，超出报 INVALID_PARAM；
   *   - attachmentId 必须是 sha256:<64 位 hex>，且对象文件必须已由
     POST /api/uploads 落盘，找不到报 404 INVALID_PARAM（提示先上传）；
   *   - image/*（按字节魔数优先判定）→ 图片块，宽高从存储对象重新探测，
   *     保证与 DSH readImageFile 的严格校验一致（mediaType/bytes/width/height
   *     必须逐一匹配，见 dsh-attachment-local/src/store.ts readImageFile）；
   *   - 其余 → 走 DSH 官方的 fileUploads.uploadStream 暂存收据
   *     （[官方源码] dsh-api-session-controller/src/commands.ts
   *     resolvePromptFileReceipts：prompt 的 file 块只认 receiptId，
   *     直接给 attachment 引用会报 session/attachment-invalid FILE_NOT_STAGED）。
   */
  async resolveOutgoingAttachments(sessionId, attachments) {
    if (attachments === undefined || attachments === null) return [];
    if (!Array.isArray(attachments)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, 'attachments 必须是数组');
    }
    if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new BridgeError(
        ErrorCode.INVALID_PARAM,
        `单条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`,
      );
    }
    const resolved = [];
    for (const item of attachments) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, 'attachments 元素必须是对象');
      }
      const attachmentId = typeof item.attachmentId === 'string' ? item.attachmentId.trim() : '';
      const hex = attachmentId.startsWith('sha256:') ? attachmentId.slice(7) : attachmentId;
      if (!/^[0-9a-f]{64}$/i.test(hex)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `附件 ID 非法：${attachmentId}`);
      }
      const declared = typeof item.mediaType === 'string' ? item.mediaType.trim().toLowerCase() : '';
      const name = decodeUploadName(typeof item.name === 'string' ? item.name : '');

      // 定位已上传对象：图片在 objects/，其余在 file-objects/；两处都试，防止
      // 手机端 mediaType 与上传时不一致导致查错目录。
      const root = this.attachmentsRoot();
      const candidates = declared.startsWith('image/')
        ? ['objects', 'file-objects']
        : ['file-objects', 'objects'];
      let objectFile = null;
      for (const dir of candidates) {
        const file = path.join(root, dir, hex.slice(0, 2), hex);
        try {
          const stat = await fs.promises.stat(file);
          if (stat.isFile()) {
            objectFile = file;
            break;
          }
        } catch {
          // 试下一个目录
        }
      }
      if (objectFile === null) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, '附件尚未上传，请先调用 POST /api/uploads 上传后再发送', {
          status: 404,
          detail: { attachmentId: `sha256:${hex}` },
        });
      }

      const stat = await fs.promises.stat(objectFile);
      const head = await readFileHead(objectFile);
      const sniff = sniffImageHead(head);
      const isImage = sniff !== null || declared.startsWith('image/');
      // 图片块引用必须与存储字节完全一致（DSH 读取时会逐字段校验），所以
      // mediaType / bytes / width / height 一律以落盘对象实测值为准。
      resolved.push({
        attachmentId: `sha256:${hex}`,
        hex,
        name,
        isImage,
        kind: isImage ? 'image' : (declared.startsWith('video/') ? 'video' : 'file'),
        objectFile,
        bytes: stat.size,
        mediaType: sniff !== null ? sniff.mediaType : (declared.length > 0 ? declared : 'application/octet-stream'),
        width: sniff !== null ? sniff.width : 0,
        height: sniff !== null ? sniff.height : 0,
      });
    }
    return resolved;
  }

  /**
   * 通过 DSH 官方 fileUploads 服务把一个文件附件暂存为「会话内收据」。
   * [官方源码] dsh-client-file-upload/src/index.ts uploadStream({sessionId, data, signal?, name?})
   *   → attachments.saveFileStream（逐字段落盘，file-objects/<hex前2>/<hex> 内容寻址去重）
   *   → 返回 { receiptId, file }；收据与该会话的 Agent 绑定，prompt 引用后由 Host 退役。
   */
  async stageFileReceipt(sessionId, attachment) {
    const service = this.optional('fileUploads');
    if (service === undefined || typeof service.uploadStream !== 'function') {
      throw new BridgeError(ErrorCode.NOT_SUPPORTED, '当前 DSH 版本不支持文件附件（缺少 fileUploads 服务）', {
        detail: { attachmentId: attachment.attachmentId },
      });
    }
    const stream = fs.createReadStream(attachment.objectFile);
    const value = await service.uploadStream({
      sessionId,
      data: stream,
      signal: newSignal(60000),
      ...(attachment.name.length > 0 ? { name: attachment.name } : {}),
    });
    const receiptId = value !== null && typeof value === 'object' && typeof value.receiptId === 'string'
      ? value.receiptId
      : '';
    if (receiptId.length === 0) {
      throw new BridgeError(ErrorCode.DSH_ERROR, 'DSH 未返回文件上传收据', {
        detail: { attachmentId: attachment.attachmentId },
      });
    }
    return receiptId;
  }

  /**
   * 把一条用户消息送进 DSH 的 Agent 循环（红线：绝不直连模型）。
   * [官方源码] sessionController.prompt({requestId, sessionId, mode, content, clientTimeZone})
   * 返回 accepted 表示已入队，真正的回复通过 session/event + agent/assistant-stream 推送。
   *
   * v3.1：options.attachments（contract.md §9.2）映射为 prompt content 块，
   * 附件块全部拼在 text 块之前；text 为空但带附件时允许纯附件消息。
   */
  async prompt(options) {
    try {
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
      const text = typeof options.text === 'string' ? options.text : '';
      if (sessionId.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, '缺少 sessionId');
      const resolvedAttachments = await this.resolveOutgoingAttachments(sessionId, options.attachments);
      if (text.trim().length === 0 && resolvedAttachments.length === 0) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, '消息内容为空');
      }
      const controller = this.require('sessionController');
      const requestId = typeof options.requestId === 'string' && options.requestId.length > 0
        ? options.requestId
        : `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const mode = options.mode === 'steer' ? 'steer' : 'queue';
      const content = [];
      for (const attachment of resolvedAttachments) {
        if (attachment.isImage) {
          content.push({
            type: 'image',
            attachment: {
              attachmentId: attachment.attachmentId,
              mediaType: attachment.mediaType,
              bytes: attachment.bytes,
              width: attachment.width,
              height: attachment.height,
              ...(attachment.name.length > 0 ? { name: attachment.name } : {}),
            },
          });
        } else {
          // video/* 与其他文件：DSH 的 prompt 只接受暂存收据形式的 file 块
          //（resolvePromptFileReceipts 校验 receiptId），所以这里先暂存再引用。
          const receiptId = await this.stageFileReceipt(sessionId, attachment);
          content.push({ type: 'file', receiptId });
        }
      }
      if (text.trim().length > 0) {
        content.push({ type: 'text', text });
      }
      const request = {
        requestId,
        sessionId,
        mode,
        content,
        clientTimeZone: typeof options.clientTimeZone === 'string' && options.clientTimeZone.length > 0
          ? options.clientTimeZone
          : 'Asia/Shanghai',
      };
      const value = await controller.prompt(request, newSignal(30000));
      return {
        accepted: value === null || value === undefined || value.accepted !== false,
        requestId,
        sessionId,
        mode,
        clientMessageId: typeof options.clientMessageId === 'string' ? options.clientMessageId : '',
      };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  async cancel(sessionId) {
    try {
      const controller = this.require('sessionController');
      const value = controller.cancel({ sessionId });
      return { accepted: value === null || value === undefined || value.accepted !== false, sessionId };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  async getState(sessionId) {
    try {
      const controller = this.require('sessionController');
      const value = await controller.state({ sessionId }, newSignal(15000));
      if (value === null || typeof value !== 'object') {
        return { cursor: 0, active: false, running: false, pendingInput: [], queue: [] };
      }
      return {
        cursor: typeof value.cursor === 'number' ? value.cursor : 0,
        active: value.active === true,
        running: value.running === true,
        pendingInput: Array.isArray(value.pendingInput) ? value.pendingInput.slice() : [],
        queue: Array.isArray(value.queue)
          ? value.queue.map((item) => ({
            id: item !== null && typeof item === 'object' && typeof item.id === 'string' ? item.id : '',
            text: item !== null && typeof item === 'object' ? String(item.text ?? '') : '',
          }))
          : [],
      };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  // ── 模型 ───────────────────────────────────────────────────────────────

  /** [官方源码] sessionController.modelCatalog() → { default, routableProviders, groups, failures } */
  async getModelCatalog() {
    try {
      const controller = this.require('sessionController');
      const catalog = await controller.modelCatalog();
      const groups = [];
      if (catalog !== null && typeof catalog === 'object' && Array.isArray(catalog.groups)) {
        for (const group of catalog.groups) {
          if (group === null || typeof group !== 'object') continue;
          const models = [];
          for (const model of Array.isArray(group.models) ? group.models : []) {
            if (model === null || typeof model !== 'object') continue;
            const reasoning = model.reasoning !== null && typeof model.reasoning === 'object'
              ? {
                efforts: Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts.slice() : [],
                defaultEffort: typeof model.reasoning.defaultEffort === 'string' ? model.reasoning.defaultEffort : '',
              }
              : undefined;
            models.push({
              id: typeof model.id === 'string' ? model.id : '',
              name: typeof model.name === 'string' ? model.name : '',
              description: typeof model.description === 'string' ? model.description : '',
              badge: typeof model.badge === 'string' ? model.badge : '',
              reasoning,
            });
          }
          groups.push({
            id: typeof group.id === 'string' ? group.id : '',
            name: typeof group.name === 'string' ? group.name : '',
            models,
          });
        }
      }
      const fallbackDefault = { provider: '', model: '', reasoningEffort: '' };
      const def = catalog !== null && typeof catalog === 'object' && catalog.default !== null
        && typeof catalog.default === 'object' ? catalog.default : fallbackDefault;
      return {
        default: {
          provider: typeof def.provider === 'string' ? def.provider : '',
          model: typeof def.model === 'string' ? def.model : '',
          reasoningEffort: typeof def.reasoningEffort === 'string' ? def.reasoningEffort : '',
        },
        routableProviders: catalog !== null && typeof catalog === 'object' && Array.isArray(catalog.routableProviders)
          ? catalog.routableProviders.slice()
          : [],
        groups,
        failures: catalog !== null && typeof catalog === 'object' && Array.isArray(catalog.failures)
          ? catalog.failures.length
          : 0,
      };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  /** 当前默认模型：手机端选过的偏好优先，否则读 agentDefaultModel。 */
  async getDefaultModel() {
    try {
      if (this.preferredModel.model.length > 0) {
        return {
          provider: this.preferredModel.provider,
          model: this.preferredModel.model,
          reasoningEffort: this.preferredModel.reasoningEffort,
        };
      }
      const service = this.optional('agentDefaultModel');
      if (service !== undefined && typeof service.currentSelection === 'function') {
        const selection = service.currentSelection();
        if (selection !== null && typeof selection === 'object') {
          return {
            provider: typeof selection.provider === 'string' ? selection.provider : '',
            model: typeof selection.model === 'string' ? selection.model : '',
            reasoningEffort: typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : '',
          };
        }
      }
      return { provider: '', model: '', reasoningEffort: '' };
    } catch (error) {
      this.log(`读取默认模型失败: ${error instanceof Error ? error.message : String(error)}`);
      return { provider: '', model: '', reasoningEffort: '' };
    }
  }

  /**
   * 设置默认模型。
   * 先尝试写 DSH 全局默认（agentDefaultModel.saveSelection），失败则落桥偏好文件；
   * 无论哪条路都持久化桥偏好，新建会话时会套用。
   */
  async saveDefaultModel(selection) {
    const next = { provider: selection.provider, model: selection.model };
    if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0) {
      next.reasoningEffort = selection.reasoningEffort;
    }
    let globalSaved = false;
    try {
      const service = this.optional('agentDefaultModel');
      if (service !== undefined && typeof service.saveSelection === 'function') {
        await service.saveSelection(next);
        globalSaved = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`保存 DSH 全局默认模型失败（将只落桥偏好）: ${message}`);
    }
    this.preferredModel = {
      provider: next.provider,
      model: next.model,
      reasoningEffort: typeof next.reasoningEffort === 'string' ? next.reasoningEffort : '',
    };
    this.writePreferredModel(this.preferredModel);
    return { provider: next.provider, model: next.model, reasoningEffort: this.preferredModel.reasoningEffort, globalSaved };
  }

  /** 给某个会话切换模型。 */
  async selectModel(sessionId, selection) {
    try {
      const controller = this.require('sessionController');
      const request = { sessionId, provider: selection.provider, model: selection.model };
      if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0) {
        request.reasoningEffort = selection.reasoningEffort;
      }
      const value = await controller.selectModel(request);
      const selected = value !== null && typeof value === 'object' && value.selected !== null
        && typeof value.selected === 'object' ? value.selected : request;
      return {
        sessionId,
        selected: {
          provider: typeof selected.provider === 'string' ? selected.provider : '',
          model: typeof selected.model === 'string' ? selected.model : '',
          reasoningEffort: typeof selected.reasoningEffort === 'string' ? selected.reasoningEffort : '',
        },
      };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  // ── 会话权限模式（v3.1，contract.md §9.5）──────────────────────────────

  /**
   * 读一个会话的权限模式。
   *
   * 核实结论（app.asar 源码，2026-11-14）：
   *   - 会话权限由三个 log 旋钮事件承载：`permission/preset` / `sandbox/mode` /
   *     `approval/policy`（dsh-permission-presets/src/index.ts:133-137 折叠），
   *     最后一条生效 —— 桥的投影层（adapter/project.js）已经能读到它们。
   *   - 没有旋钮事件时 = 部署组合默认（ctx.shell.sandboxMode / approval 默认），
   *     桥读不到 ctx.shell，用 permissionPresets.catalog().defaultPreset 的 spec 折算。
   *   - approval：DSH 只有 'ask' | 'never'（dsh-user-approval/src/index.ts:119），
   *     映射 'ask'→'every-step'、'never'→'auto'。
   *
   * @returns {Promise<{sessionId: string, mode: string, approval: string}>}
   */
  async getPermission(sessionId) {
    try {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (id.length === 0) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, '缺少 sessionId');
      }
      const query = this.require('sessionQuery');
      const snapshot = await query.readSession(id);
      if (snapshot === null || typeof snapshot !== 'object') {
        throw new BridgeError(ErrorCode.SESSION_NOT_FOUND, '会话不存在', { detail: { sessionId: id } });
      }
      const projected = projectEvents(snapshot.events);
      const catalog = this.readPermissionCatalog();
      let mode = SANDBOX_TO_MODE[projected.meta.sandbox] ?? '';
      if (mode.length === 0) {
        // 无旋钮事件 → 组合默认：活会话走 permissionPresets.current（内部折叠 ctx.shell 默认），
        // 冷会话退 catalog.defaultPreset。
        mode = this.currentPermissionModeFromLive(id) ?? this.defaultPermissionMode(catalog);
      }
      let approval = APPROVAL_TO_WIRE[projected.meta.approval] ?? '';
      if (approval.length === 0) {
        approval = this.defaultApproval(catalog);
      }
      return { sessionId: id, mode, approval };
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  /**
   * 运行时修改一个会话的权限模式（contract.md §9.5 PUT）。
   *
   * 核实到的运行时写入口（全部来自 app.asar 源码）：
   *   1. permissionPresets.set(session, presetName)（dsh-permission-presets/src/index.ts:395-411）
   *      —— 官方「THE 写路径」：追加 permission/preset 事件 + setSandboxMode +
   *      setApprovalPolicy；ds-bot 正是这样改每个 Bot 会话的权限
   *      （ds-bot/src/host/permissions.js:28 `presets().set(agent.session, wanted)`）。
   *      默认预设表只有 workspace-write 与 danger-full-access（index.ts:183-190），
   *      没有默认 read-only 预设（SANDBOX_MODES 里有 read-only，但预设表可由部署配置）。
   *   2. setSandboxMode(session, mode)（dsh-sandbox-policy/src/session-mode.ts:53-54）
   *      —— `session.append('sandbox/mode', { mode })`，注释明言
   *      "THE write path ... the switch IS its event"。SANDBOX_MODES =
   *      ['read-only','workspace-write','danger-full-access']（session-mode.ts:44）。
   *      桥作为进程内 cordis 插件，通过 ctx.sessions 拿到活 Session 实例后追加同一事件，
   *      即是与官方 setter 完全相同的写路径（ds-bot 也跨 fiber 这样用）。
   *
   * 策略：catalog 里有 sandbox 匹配的预设 → 走 permissionPresets.set（顺带写 approval）；
   * 没有（默认部署的 read-only）→ 直写 sandbox/mode 事件。绝不臆造服务方法。
   *
   * @returns {Promise<{sessionId: string, mode: string}>}
   */
  /**
   * 运行时修改会话权限（contract §9.5 + §9.6）：{mode?, approval?} 任意组合。
   *
   * approval 写路径核实（app.asar 源码，v3.4 复核）：
   *   - setApprovalPolicy(session, policy)（dsh-user-approval/src/index.ts:117-122）
   *     —— 校验 policy ∈ ['ask','never']（:71）后 `session.append('approval/policy',
   *     { policy })`，注释明言 "Append the sole durable representation of a session
   *     policy override"。它是包内导出函数而非 ctx 服务，桥作为进程内 cordis 插件
   *     通过活 Session 实例追加同一事件（与 v3.1 sandbox/mode 直写同一手法，
   *     ds-bot 亦跨 fiber 写会话）。
   *   - 事件载荷 schema：dsh-user-approval/src/index.ts:41-44
   *     `'approval/policy': { policy, source? }`（缺 source = 运行时切换）；
   *     属于 dsh-session/src/known-event-types.ts:27 已知事件词表。
   *   - 折叠语义：dsh-user-approval/src/index.ts:99 —— 最后一条 approval/policy
   *     生效（last-write-wins），因此 mode（预设会附带写一次 approval）先写、
   *     approval 后写即可让用户显式选择的审批覆盖预设默认。
   *   - ds-bot 的每 Bot 权限同样最终经 permissionPresets.set → apply 里的
   *     setApprovalPolicy 落盘（ds-bot/src/host/permissions.js:28 +
   *     dsh-permission-presets/src/index.ts:398-411）。
   *
   * 只传 approval 不动 mode；只传 mode 不动 approval；两者都传先 mode 后 approval。
   *
   * @param {string} sessionId
   * @param {{ mode?: string, approval?: string }} payload
   * @returns {Promise<{sessionId: string, mode?: string, approval?: string}>}
   */
  async setPermission(sessionId, payload) {
    try {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (id.length === 0) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, '缺少 sessionId');
      }
      const options = payload !== null && typeof payload === 'object' ? payload : {};
      const mode = typeof options.mode === 'string' ? options.mode.trim() : '';
      const approval = typeof options.approval === 'string' ? options.approval.trim() : '';
      if (mode.length === 0 && approval.length === 0) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, 'PUT 需要 mode / approval 至少一项');
      }
      if (mode.length > 0 && !PERMISSION_MODES.includes(mode)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, 'mode 必须是 read-only / workspace-write / full-access 之一');
      }
      if (approval.length > 0 && !(approval in WIRE_TO_APPROVAL)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, 'approval 必须是 every-step / auto 之一');
      }
      const query = this.require('sessionQuery');
      const snapshot = await query.readSession(id);
      if (snapshot === null || typeof snapshot !== 'object') {
        throw new BridgeError(ErrorCode.SESSION_NOT_FOUND, '会话不存在', { detail: { sessionId: id } });
      }
      const live = await this.resolveLiveSession(id);
      if (live === null) {
        throw new BridgeError(ErrorCode.DSH_ERROR, '会话未在运行且无法唤起，无法修改权限', { detail: { sessionId: id } });
      }
      const result = { sessionId: id };
      // 1) mode（沙盒/预设）先写：有匹配预设走 permissionPresets.set（顺带写预设自带的
      //    approval），没有（默认部署的 read-only）直写 sandbox/mode 事件。
      if (mode.length > 0) {
        const service = this.optional('permissionPresets');
        if (service === undefined || typeof service.set !== 'function') {
          throw new BridgeError(ErrorCode.NOT_SUPPORTED, '当前 DSH 版本不支持运行时修改会话权限模式（缺少 permissionPresets 服务）');
        }
        const targetSandbox = MODE_TO_SANDBOX[mode];
        let presetName = null;
        const catalog = typeof service.catalog === 'function' ? this.readPermissionCatalog() : null;
        if (catalog !== null && Array.isArray(catalog.options)) {
          for (const option of catalog.options) {
            const value = option !== null && typeof option === 'object' ? option.value : undefined;
            if (typeof value !== 'string' || value === 'custom' || value === 'auto') continue;
            try {
              if (typeof service.resolve === 'function' && service.resolve(value).sandbox === targetSandbox) {
                presetName = value;
                break;
              }
            } catch {
              // 目录里不可解析的项跳过
            }
          }
        }
        if (presetName !== null) {
          service.set(live, presetName);
        } else if (typeof live.append === 'function') {
          live.append('sandbox/mode', { mode: targetSandbox });
        } else {
          throw new BridgeError(ErrorCode.NOT_SUPPORTED, '当前 DSH 版本不支持运行时修改会话权限模式');
        }
        result.mode = mode;
      }
      // 2) approval 后写：fold 取最后一条 approval/policy，显式选择覆盖预设默认。
      //    [官方源码] dsh-user-approval/src/index.ts:117-122 setApprovalPolicy =
      //    session.append('approval/policy', { policy })（'ask' | 'never'）。
      if (approval.length > 0) {
        if (typeof live.append !== 'function') {
          throw new BridgeError(ErrorCode.NOT_SUPPORTED, '当前 DSH 版本不支持运行时修改审批策略');
        }
        live.append('approval/policy', { policy: WIRE_TO_APPROVAL[approval] });
        result.approval = approval;
      }
      return result;
    } catch (error) {
      throw asBridgeError(error);
    }
  }

  /**
   * 读 permissionPresets.catalog()；服务不可用返回 null。
   * [官方源码] dsh-permission-presets/src/index.ts:291-299 @Remote('catalog')
   */
  readPermissionCatalog() {
    const service = this.optional('permissionPresets');
    if (service === undefined || typeof service.catalog !== 'function') return null;
    try {
      const value = service.catalog();
      if (value === null || typeof value !== 'object') return null;
      return {
        options: Array.isArray(value.options) ? value.options : [],
        defaultPreset: typeof value.defaultPreset === 'string' ? value.defaultPreset : '',
      };
    } catch (error) {
      this.log(`permissionPresets.catalog 失败: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 从活会话读当前权限模式（permissionPresets.current 折叠组合默认）。拿不到返回 null。 */
  currentPermissionModeFromLive(sessionId) {
    const liveStore = this.optional('sessions');
    const service = this.optional('permissionPresets');
    if (liveStore === undefined || typeof liveStore.get !== 'function') return null;
    if (service === undefined || typeof service.current !== 'function') return null;
    const live = liveStore.get(sessionId);
    if (live === undefined || live === null) return null;
    try {
      const name = service.current(live);
      if (typeof name !== 'string' || name.length === 0 || name === 'custom' || name === 'auto') return null;
      const spec = typeof service.resolve === 'function' ? service.resolve(name) : null;
      if (spec === null || typeof spec !== 'object') return null;
      return SANDBOX_TO_MODE[spec.sandbox] ?? null;
    } catch {
      return null;
    }
  }

  /** catalog.defaultPreset 折算成 3 档 mode；不可用退 DSH 出厂默认 workspace-write。 */
  defaultPermissionMode(catalog) {
    const service = this.optional('permissionPresets');
    if (catalog !== null && typeof catalog.defaultPreset === 'string' && catalog.defaultPreset.length > 0
      && service !== undefined && typeof service.resolve === 'function') {
      try {
        const spec = service.resolve(catalog.defaultPreset);
        return SANDBOX_TO_MODE[spec.sandbox] ?? 'workspace-write';
      } catch {
        // 退出厂默认
      }
    }
    return 'workspace-write';
  }

  /** catalog.defaultPreset 折算 approval（ask→every-step / never→auto）；不可用退 every-step。 */
  defaultApproval(catalog) {
    const service = this.optional('permissionPresets');
    if (catalog !== null && typeof catalog.defaultPreset === 'string' && catalog.defaultPreset.length > 0
      && service !== undefined && typeof service.resolve === 'function') {
      try {
        const spec = service.resolve(catalog.defaultPreset);
        return APPROVAL_TO_WIRE[spec.approval] ?? 'every-step';
      } catch {
        // 退出厂默认
      }
    }
    return 'every-step';
  }

  /**
   * 解析一个「活着的 Session 实例」：先查 sessions 存储里的活会话，
   * 没有再用 sessionController.resolveAgent 唤起（官方公开方法，
   * dsh-api-session-controller/src/index.ts —— "Resolve or resume one ordinary
   * Session for another Host API domain"）。
   * @returns {Promise<object|null>} 活 Session 实例；唤起失败返回 null。
   */
  async resolveLiveSession(sessionId) {
    const liveStore = this.optional('sessions');
    if (liveStore !== undefined && typeof liveStore.get === 'function') {
      const live = liveStore.get(sessionId);
      if (live !== undefined && live !== null) return live;
    }
    const controller = this.optional('sessionController');
    if (controller !== undefined && typeof controller.resolveAgent === 'function') {
      const result = await controller.resolveAgent(sessionId);
      if (result !== null && typeof result === 'object' && !('error' in result)
        && result.agent !== null && typeof result.agent === 'object'
        && result.agent.session !== null && typeof result.agent.session === 'object') {
        return result.agent.session;
      }
    }
    return null;
  }

  // ── 目录浏览（新建会话选目录用） ───────────────────────────────────────

  /**
   * 浏览本机目录，供手机端"新建会话"选择工作文件夹，避免让用户手输路径。
   * path 为空 → 返回根列表（Windows 盘符 / Unix "/"）；否则返回该目录的子目录。
   * 只列目录，不列文件（新建会话只接受目录）。
   */
  async browseDirectories(targetPath) {
    const trimmed = typeof targetPath === 'string' ? targetPath.trim() : '';
    if (trimmed === '') {
      const drives = process.platform === 'win32' ? listWindowsDrives() : [];
      const home = safeHomedir();
      return { path: '', parent: null, entries: drives, drives, home };
    }
    const abs = path.resolve(trimmed);
    let stat = null;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `目录不存在或无权访问：${abs}`);
    }
    if (!stat.isDirectory()) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `不是一个目录：${abs}`);
    }
    const entries = await readSubDirectories(abs);
    const parentPath = path.dirname(abs);
    return {
      path: abs,
      parent: parentPath === abs ? null : parentPath,
      entries,
      drives: process.platform === 'win32' ? listWindowsDrives() : [],
      home: safeHomedir(),
    };
  }

  // ── 附件（图片 / 文件）─────────────────────────────────────────────────

  /**
   * 定位 DSH 内容寻址对象，仅探测文件头，不调用要求完整引用的 readImage，也不整包读入。
   * 存储布局：$DSH_HOME/attachments/v1/{objects,file-objects}/<前两位>/<完整摘要>。
   */
  async objectAttachmentPath(attachmentId, mediaOnly) {
    const id = typeof attachmentId === 'string' ? attachmentId.trim() : '';
    const hex = id.replace(/^sha256:/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, '附件 ID 必须是 sha256 摘要');
    }

    const candidates = mediaOnly ? ['objects', 'file-objects'] : ['file-objects'];
    for (const kind of candidates) {
      const root = path.join(this.attachmentsRoot(), kind, hex.slice(0, 2));
      const file = path.join(root, hex);
      try {
        if (!(await fs.promises.stat(file)).isFile()) continue;
        const head = await readFileHead(file, DOWNLOAD_HEAD_BYTES);
        const mediaType = imageMediaTypeOfHead(head) || videoMediaTypeOfHead(head);
        // 老客户端对不带 media: 的 video 也走 /api/attachments；仅在确认媒体后回退到文件库。
        if (mediaOnly && kind === 'file-objects' && !mediaType) continue;
        return { root, fileName: hex, mediaType: mediaType || 'application/octet-stream' };
      } catch {
        // 找不到或无法读取时继续查下一个对象库。
      }
    }
    throw new BridgeError(ErrorCode.ATTACHMENT_NOT_FOUND, '附件不存在', { detail: { attachmentId: id } });
  }

  imageAttachmentPath(attachmentId) {
    return this.objectAttachmentPath(attachmentId, true);
  }

  genericAttachmentPath(attachmentId) {
    return this.objectAttachmentPath(attachmentId, false);
  }

  /**
   * 媒体白名单根：只有落在这些目录之内的文件才允许经 /api/media 转出字节。
   *
   * 为什么需要白名单：v3.7 起媒体 ID 可以是会话工作区里的任意路径
   * （`media:v1.<base64url(绝对路径)>`，编码端见 project.js），
   * 而手机端拿到的 ID 来自会话内容，不能当作可信输入 —— 否则等于把整台电脑的
   * 文件系统暴露给任何持有访问令牌的客户端。
   *
   * 白名单来源：
   *   - 所有会话的工作区（cwd）—— 交付类工具把视频写到会话目录下
   *   - 所有已注册工作区路径
   *   - $DSH_HOME/dsh-imagegen —— 生图/生视频插件的落盘目录
   *
   * 结果缓存 60 秒（会话与工作区变化不频繁，避免每次请求都拉一遍列表）。
   *
   * @returns {Promise<string[]>} 已 realpath 归一化的绝对目录
   */
  async mediaRoots() {
    const now = Date.now();
    if (this._mediaRoots !== null && now - this._mediaRoots.at < MEDIA_ROOTS_TTL) {
      return this._mediaRoots.roots;
    }
    const raw = [path.join(this.dshHome(), 'dsh-imagegen')];
    // 持久化会话头有 cwd，包括归档会话；控制面 summary 的部分版本不提供 cwd。
    try {
      const query = this.optional('sessionQuery');
      const records = await query?.listSessions?.(newSignal(15000));
      for (const record of Array.isArray(records) ? records : []) raw.push(record?.header?.cwd);
    } catch {
      // 仍可从控制面和工作区注册表取得目录。
    }
    try {
      const controller = this.optional('sessionController');
      const summary = await controller?.list?.({}, newSignal(15000));
      for (const item of Array.isArray(summary?.items) ? summary.items : []) raw.push(item?.cwd);
    } catch {
      // 会话列表失败不影响已注册工作区。
    }
    try {
      const workspaces = await this.listWorkspaces();
      for (const item of workspaces.items) {
        if (typeof item.path === 'string' && item.path.length > 0) raw.push(item.path);
      }
    } catch (error) {
      // 工作区列表失败不影响主流程
    }
    const roots = [];
    for (const candidate of new Set(raw)) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
      try {
        // 根和目标都归一化，不能通过目录内的符号链接读取白名单外的文件。
        const real = await fs.promises.realpath(candidate);
        if (!roots.includes(real)) roots.push(real);
      } catch {
        // 目录不存在就跳过（会话可能指向已删除的工作区）
      }
    }
    this._mediaRoots = { at: now, roots };
    return roots;
  }

  /** 按宿主文件系统的路径规则比对；不能在区分大小写的平台一律转小写。 */
  static isInsideRoot(target, root) {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  /**
   * 读取一个已落盘的媒体文件（AI 生成视频 / 会话交付的视频图片）。
   *
   * 两种 ID 形态：
   *   ① 纯文件名（v0，兼容老客户端）：`abc.mp4`
   *      → $DSH_HOME/dsh-imagegen/videos/files/<file>，只接受纯文件名。
   *   ② `media:v1.<base64url(绝对路径)>`（v3.7）：任意本地媒体，
   *      解码后必须 realpath 落在白名单根之内（见 mediaRoots）。
   *
   * 事实来源（dsh-imagegen-video 3.x 源码 + 本机实测）：
   *   生成视频持久化在 $DSH_HOME/dsh-imagegen/videos/files/<file>，
   *   工具结果只返回 `/api/dsh-imagegen/video/file/<file>` 这样的同源相对 URL，
   *   字节从不进入会话。手机端加载不了电脑上的路径，所以由桥转出字节。
   *
   * @param {string} name 媒体 ID，例如 `abc.mp4` 或 `media:v1.ZDpc...`
   * @returns {Promise<{ root: string, fileName: string, name: string, mediaType: string }>}
   */
  async mediaFilePath(name) {
    const id = typeof name === 'string' ? name : '';
    // 保留新旧客户端的有/无 media: 前缀四种形态。
    const value = id.startsWith('media:') ? id.slice('media:'.length) : id;
    if (value.startsWith(MEDIA_ID_V1)) {
      return this.resolveLocalMediaPath(value.slice(MEDIA_ID_V1.length));
    }

    if (!mediaKindOf(value) || value.startsWith('.') || /[\\/:\u0000-\u001f\u007f]/.test(value)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, '媒体 ID 不是受支持的文件名');
    }
    let root;
    try {
      root = await fs.promises.realpath(path.join(this.dshHome(), 'dsh-imagegen', 'videos', 'files'));
    } catch {
      throw new BridgeError(ErrorCode.MEDIA_NOT_FOUND, '媒体文件不存在');
    }
    return this.localMediaDescriptor(path.join(root, value), [root]);
  }

  /** 解码已有的 v1 路径标识，实际文件仍须通过白名单。 */
  async resolveLocalMediaPath(encoded) {
    let absolute;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('无效编码');
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded) throw new Error('无效编码');
      absolute = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new BridgeError(ErrorCode.INVALID_PARAM, '媒体 ID 解码失败');
    }
    if (!path.isAbsolute(absolute) || /[\u0000-\u001f\u007f]/.test(absolute)
      || (process.platform === 'win32' && absolute.slice(2).includes(':'))) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, '媒体 ID 不是有效绝对路径');
    }
    if (!mediaKindOf(absolute)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, '媒体 ID 指向的不是支持的媒体类型');
    }
    return this.localMediaDescriptor(absolute, await this.mediaRoots());
  }

  async localMediaDescriptor(absolute, roots) {
    const name = path.basename(absolute);
    const missing = () => new BridgeError(ErrorCode.MEDIA_NOT_FOUND, '媒体文件不存在', { detail: { name } });
    try {
      const real = await fs.promises.realpath(absolute);
      const mediaType = mediaMimeOf(real);
      if (!mediaKindOf(real) || !roots.some((root) => DshAdapter.isInsideRoot(real, root))
        || !(await fs.promises.stat(real)).isFile()) throw missing();
      return { root: path.dirname(real), fileName: path.basename(real), name, mediaType };
    } catch {
      // 不区分文件不存在与不在白名单内。
      throw missing();
    }
  }

  // ── 附件上传（v3.1，contract.md §9.1）───────────────────────────────────

  /**
   * 接收手机端上传的原始字节流并写入 DSH 附件存储（内容寻址、幂等）。
   *
   * 存储布局与 DSH 自带实现完全一致（本机实测 + dsh-attachment-local 源码核实）：
   *   - image/*（按字节魔数判定）→ $DSH_HOME/attachments/v1/objects/<hex前2位>/<hex>
   *   - 其余 → $DSH_HOME/attachments/v1/file-objects/<hex前2位>/<hex>
   * DSH 官方发布器（publishImmutableObject）同样是「同摘要已存在即复用」，
   * 因此这里同字节重传直接复用已有对象，不重复落盘。
   *
   * 字节流不整段驻留内存：边收边写临时文件并计算 sha256，超限立即中断，
   * 完成后原子 rename 到目标位置（rename 失败且目标已存在 = 并发同对象，复用）。
   *
   * @param {NodeJS.ReadableStream} source 原始字节流（HTTP request）
   * @param {{ name?: string, mediaType?: string, contentLength?: unknown }} meta 请求头元信息
   * @returns {Promise<{attachmentId: string, mediaType: string, name: string, bytes: number, width: number, height: number, kind: string}>}
   */
  async saveUpload(source, meta = {}) {
    const contentLength = Number(meta.contentLength);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, '附件超过单文件上限 200 MB', { status: 413 });
    }
    const declared = typeof meta.mediaType === 'string' ? meta.mediaType.trim().toLowerCase() : '';
    const name = decodeUploadName(meta.name);

    const tmpDir = path.join(this.attachmentsRoot(), 'tmp');
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `upload-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD_BYTES) {
          callback(new BridgeError(ErrorCode.INVALID_PARAM, '附件超过单文件上限 200 MB', { status: 413 }));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    let hex;
    try {
      await pipeline(source, counter, fs.createWriteStream(tmpFile));
      hex = hash.digest('hex');
    } catch (error) {
      await fs.promises.rm(tmpFile, { force: true }).catch(() => {});
      throw asBridgeError(error);
    }
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      await fs.promises.rm(tmpFile, { force: true }).catch(() => {});
      throw new BridgeError(ErrorCode.INTERNAL_ERROR, '上传摘要计算异常');
    }

    const root = this.attachmentsRoot();
    const head = await readFileHead(tmpFile).catch(() => undefined);
    const sniff = head !== undefined ? sniffImageHead(head) : null;
    const isImage = sniff !== null || declared.startsWith('image/');
    const shardDir = path.join(root, isImage ? 'objects' : 'file-objects', hex.slice(0, 2));
    const target = path.join(shardDir, hex);
    try {
      await fs.promises.mkdir(shardDir, { recursive: true });
      let reused = false;
      try {
        await fs.promises.access(target);
        reused = true;
      } catch {
        try {
          await fs.promises.rename(tmpFile, target);
        } catch (renameError) {
          if (renameError !== null && typeof renameError === 'object' && renameError.code === 'EEXIST') {
            reused = true;
          } else {
            throw renameError;
          }
        }
      }
      if (reused) await fs.promises.rm(tmpFile, { force: true }).catch(() => {});
      const mediaType = sniff !== null
        ? sniff.mediaType
        : (declared.length > 0 ? declared : 'application/octet-stream');
      const kind = isImage ? 'image' : (declared.startsWith('video/') ? 'video' : 'file');
      return {
        attachmentId: `sha256:${hex}`,
        mediaType,
        name,
        bytes,
        width: sniff !== null ? sniff.width : 0,
        height: sniff !== null ? sniff.height : 0,
        kind,
      };
    } catch (error) {
      await fs.promises.rm(tmpFile, { force: true }).catch(() => {});
      throw asBridgeError(error);
    }
  }

  // ── 工作区 ─────────────────────────────────────────────────────────────

  /** 列出工作区（供"新建会话"选择目录）。 */
  async listWorkspaces() {
    try {
      const service = this.optional('workspaceRegistry');
      if (service === undefined) return { items: [] };
      let list = [];
      if (typeof service.list === 'function') {
        const value = await service.list();
        list = Array.isArray(value) ? value : (value !== null && typeof value === 'object' && Array.isArray(value.items) ? value.items : []);
      }
      return {
        items: list.map((workspace) => {
          if (workspace === null || typeof workspace !== 'object') return null;
          return {
            workspaceId: typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '',
            path: typeof workspace.path === 'string' ? workspace.path : '',
            title: typeof workspace.title === 'string' ? workspace.title : '',
          };
        }).filter((item) => item !== null),
      };
    } catch (error) {
      this.log(`列工作区失败: ${error instanceof Error ? error.message : String(error)}`);
      return { items: [] };
    }
  }
}

export default DshAdapter;
