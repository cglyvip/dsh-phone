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
import { pageByTurns, projectEvents } from './project.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_DIR_ENTRIES = 500;

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

/**
 * 猜测图片 MIME 类型。
 * 附件对象是按 sha256 内容寻址存储的，文件名不带扩展名，
 * 所以按文件头 magic 判断（PNG / JPEG / GIF / WebP），都不匹配则回退 PNG。
 */
function guessImageMediaType(hex, data) {
  if (data !== undefined && data.length >= 12) {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
      && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp';
  }
  return 'image/png';
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
    // 手机端选择的默认模型。DSH 的 agentDefaultModel.saveSelection() 在插件内调用时
    // 会因 HMR 事务嵌套而失败（"HMR transactions cannot be nested"），
    // 所以这里单独持久化一份「桥偏好模型」，在新建会话时套用到会话上。
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.modelFile = path.join(home, 'phone-bridge', 'model.json');
    this.preferredModel = this.readPreferredModel();
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

  // ── 会话列表 ───────────────────────────────────────────────────────────

  /**
   * 列出全部可见会话，并补上标题。
   * [官方源码] sessionController.list() → { items: SessionSummary[] }
   * [官方源码] sessionQuery.readTitleSnapshots(ids) → [{sessionId,status,value:{session,title?}}]
   */
  async listSessions(archived = false) {
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
      return filtered.map((item) => ({
        ...item,
        archived: this.archivedIds.has(item.sessionId),
        pinned: this.pinnedIds.has(item.sessionId),
      }));
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
      const projected = projectEvents(snapshot.events);
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
      const page = pageByTurns(snapshot.events, {
        turns: options.turns,
        beforeTurn: options.beforeTurn,
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
   * 把一条用户消息送进 DSH 的 Agent 循环（红线：绝不直连模型）。
   * [官方源码] sessionController.prompt({requestId, sessionId, mode, content, clientTimeZone})
   * 返回 accepted 表示已入队，真正的回复通过 session/event + agent/assistant-stream 推送。
   */
  async prompt(options) {
    try {
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
      const text = typeof options.text === 'string' ? options.text : '';
      if (sessionId.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, '缺少 sessionId');
      if (text.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, '消息内容为空');
      const controller = this.require('sessionController');
      const requestId = typeof options.requestId === 'string' && options.requestId.length > 0
        ? options.requestId
        : `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const mode = options.mode === 'steer' ? 'steer' : 'queue';
      const request = {
        requestId,
        sessionId,
        mode,
        content: [{ type: 'text', text }],
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
   * 读取一个图片附件的原始字节，供手机端渲染。
   *
   * 真实附件引用形状（已用本机会话日志核对，见 tools/scan-images.mjs）：
   *   content block: { type:'image', attachment:{ attachmentId:'sha256:<hex>', mediaType, bytes, width, height, name } }
   * 存储布局（本机实测）：$DSH_HOME/attachments/v1/objects/<sha256 前 2 位>/<sha256 剩余 62 位>
   *
   * 优先走 DSH 的 attachments 服务（readImage 会校验 id / 格式 / 字节长度 / 尺寸），
   * 服务不可用或校验失败时退回直接读对象文件（同一份内容，只是少了校验）。
   *
   * @param {string} attachmentId 形如 sha256:<64 位 hex>
   * @returns {Promise<{ data: Buffer, mediaType: string }>}
   */
  async readImageAttachment(attachmentId) {
    const id = typeof attachmentId === 'string' ? attachmentId.trim() : '';
    const hex = id.startsWith('sha256:') ? id.slice('sha256:'.length) : id;
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `附件 ID 非法：${id}`);
    }

    const service = this.optional('attachments');
    if (service !== undefined && typeof service.readImage === 'function') {
      try {
        const stored = await service.readImage({
          attachmentId: id,
          mediaType: 'image/png',
          bytes: 0,
          width: 0,
          height: 0,
        });
        const data = stored !== null && typeof stored === 'object' ? stored.data : undefined;
        const ref = stored !== null && typeof stored === 'object' ? stored.ref : undefined;
        const mediaType = ref !== null && typeof ref === 'object' && typeof ref.mediaType === 'string'
          ? ref.mediaType
          : '';
        if (data instanceof Uint8Array && data.length > 0) {
          return { data: Buffer.from(data), mediaType: mediaType.length > 0 ? mediaType : guessImageMediaType(hex) };
        }
      } catch (error) {
        this.log(`attachments.readImage 失败，改读对象文件: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const file = path.join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex);
    let data;
    try {
      data = await fs.promises.readFile(file);
    } catch {
      throw new BridgeError(ErrorCode.NOT_SUPPORTED, '图片附件读取失败（对象文件不存在）', {
        detail: { attachmentId: id },
      });
    }
    return { data, mediaType: guessImageMediaType(hex, data) };
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
