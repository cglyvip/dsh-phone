/**
 * dsh-phone-bridge · EventHub
 *
 * 职责：订阅 DSH 的变更事件 → 规范化成统一信封 → 分发给所有手机客户端，
 * 并保留最近一段事件供断线重连按 seq 补拉（cursor replay）。
 *
 * 信封格式（任务书 3.3 节）：
 *   { type: string, seq: number, sessionId?: string, timestamp: number, payload: object }
 *
 * 证据等级：
 *  [官方源码] 'session/event' 与 'agent/assistant-stream' 是 host Event 目录里
 *            声明的 emit 事件（cordis Inspect 的 Event 清单逐字核对）
 *  [实测]     event.data 结构与 SessionEventMap 一致，已用真实会话日志核对
 */

import { eventToWire } from '../adapter/project.js';
import { BRIDGE_VERSION, CONTRACT_VERSION } from '../shared/version.js';

/** 环形缓冲上限：够一台手机断线 5 分钟内补拉即可 */
const DEFAULT_BUFFER_SIZE = 512;

export class EventHub {
  /**
   * @param {{ log?: (msg: string) => void, bufferSize?: number }} options
   */
  constructor(options = {}) {
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.bufferSize = Number.isInteger(options.bufferSize) && options.bufferSize > 0
      ? options.bufferSize
      : DEFAULT_BUFFER_SIZE;
    /** 全局单调递增序号（与 DSH 的 per-session seq 无关，是桥自己的投递序号） */
    this.seq = 0;
    /** @type {object[]} */
    this.buffer = [];
    /** @type {Set<(envelope: object) => void>} */
    this.listeners = new Set();
    this.disposed = false;
    /** @type {Array<() => void>} */
    this.teardown = [];
  }

  /**
   * 挂到 cordis 上下文上，开始订阅 DSH 事件。
   * @param {object} ctx
   */
  attach(ctx) {
    const on = (name, handler) => {
      if (typeof ctx.on !== 'function') return;
      try {
        const off = ctx.on(name, handler);
        if (typeof off === 'function') this.teardown.push(off);
      } catch (error) {
        this.log(`订阅事件 ${name} 失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    // 会话事件（消息、turn、标题、模型选择等）——权威来源
    on('session/event', (session, event) => {
      if (this.disposed) return;
      const sessionId = session !== null && typeof session === 'object' && typeof session.id === 'string'
        ? session.id
        : '';
      const envelope = eventToWire(sessionId, event);
      if (envelope === null) return;
      this.publish(envelope.name, sessionId, envelope.timestamp, envelope.payload, envelope.seq);
    });

    // 助手流式增量（text-delta / reasoning-delta / tool-call-delta）——只推给正在看的客户端
    on('agent/assistant-stream', (payload) => {
      if (this.disposed) return;
      const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined;
      const frame = payload !== null && typeof payload === 'object' ? payload.frame : undefined;
      const sessionId = agent !== null && typeof agent === 'object' && typeof agent.id === 'string'
        ? agent.id
        : '';
      if (frame === null || typeof frame !== 'object') return;
      this.publish('assistant.stream', sessionId, Date.now(), { frame }, 0);
    });

    // 会话增删与运行状态（若该版本提供）
    on('api-session/added', (summary) => {
      if (this.disposed) return;
      const sessionId = summary !== null && typeof summary === 'object' && typeof summary.sessionId === 'string'
        ? summary.sessionId
        : '';
      this.publish('session.created', sessionId, Date.now(), {
        sessionId,
        running: summary !== null && typeof summary === 'object' && summary.running === true,
        blank: summary !== null && typeof summary === 'object' && summary.blank === true,
      }, 0);
    });

    on('api-session/removed', (sessionId) => {
      if (this.disposed) return;
      const id = typeof sessionId === 'string' ? sessionId : '';
      this.publish('session.deleted', id, Date.now(), { sessionId: id }, 0);
    });

    on('api-session/status', (sessionId, running) => {
      if (this.disposed) return;
      const id = typeof sessionId === 'string' ? sessionId : '';
      this.publish('session.status', id, Date.now(), { sessionId: id, running: running === true }, 0);
    });

    on('api-session/activity', (sessionId, updatedAt) => {
      if (this.disposed) return;
      const id = typeof sessionId === 'string' ? sessionId : '';
      this.publish('session.updated', id, Date.now(), {
        sessionId: id,
        updatedAt: typeof updatedAt === 'number' ? updatedAt : Date.now(),
      }, 0);
    });

    // 模型目录变更
    on('llm/models-updated', (provider) => {
      if (this.disposed) return;
      this.publish('models.updated', '', Date.now(), {
        provider: typeof provider === 'string' ? provider : '',
      }, 0);
    });
  }

  /**
   * 投递一条信封。
   * @param {string} type
   * @param {string} sessionId
   * @param {number} timestamp
   * @param {object} payload
   * @param {number} dshSeq DSH 侧的 per-session seq（0 表示无）
   */
  publish(type, sessionId, timestamp, payload, dshSeq) {
    if (this.disposed) return null;
    this.seq += 1;
    const envelope = {
      type,
      seq: this.seq,
      sessionId,
      timestamp: typeof timestamp === 'number' && timestamp > 0 ? timestamp : Date.now(),
      payload: payload !== null && typeof payload === 'object' ? payload : {},
    };
    if (typeof dshSeq === 'number' && dshSeq > 0) envelope.dshSeq = dshSeq;
    this.buffer.push(envelope);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    }
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch (error) {
        this.log(`事件分发失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return envelope;
  }

  /** 订阅所有新事件，返回取消函数。 */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 当前投递序号（握手时告诉客户端，便于客户端判断是否需要补拉）。 */
  currentCursor() {
    return this.seq;
  }

  /**
   * 取 seq > cursor 的所有缓存事件；cursor 过旧（已被裁掉）时返回 {invalidated:true}。
   * @param {number} cursor
   */
  replaySince(cursor) {
    const since = typeof cursor === 'number' && cursor >= 0 ? cursor : 0;
    const oldest = this.buffer.length > 0 ? this.buffer[0].seq : this.seq + 1;
    if (since < oldest - 1) {
      return { invalidated: true, cursor: this.seq };
    }
    return {
      invalidated: false,
      cursor: this.seq,
      events: this.buffer.filter((envelope) => envelope.seq > since),
    };
  }

  /** hello 帧（连接建立时发给客户端）。 */
  helloPayload() {
    return {
      bridgeVersion: BRIDGE_VERSION,
      contractVersion: CONTRACT_VERSION,
      cursor: this.seq,
    };
  }

  dispose() {
    this.disposed = true;
    for (const off of this.teardown) {
      try {
        off();
      } catch (error) {
        this.log(`取消订阅失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.teardown = [];
    this.listeners.clear();
    this.buffer = [];
  }
}

export default EventHub;
