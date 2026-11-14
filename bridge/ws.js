/**
 * dsh-phone-bridge · WebSocket 数据面
 *
 * 目的：把 EventHub 的规范化事件实时推给手机，并接收手机发来的
 *       发消息 / 停止 / 订阅 / 补拉 请求。
 *
 * 认证：升级请求必须带 ?token=<token>（浏览器 WS 无法自定义 Header）。
 * 协议：双向都是 JSON 文本帧；服务端帧与 bridge/eventhub.js 的信封一致，
 *       另加 hello / welcome / pong / error 四类控制帧。
 *
 * 证据等级：[实测] 底层 DSH 调用全部走 adapter/dsh.js 的已核实方法。
 */

import { WebSocketServer } from 'ws';
import { asBridgeError, ErrorCode, BridgeError } from './errors.js';

/** 心跳间隔：30 秒无响应即断开（手机端也会发应用层 ping） */
const HEARTBEAT_MS = 30_000;

export class WsDataPlane {
  /**
   * @param {{
   *   server: import('node:http').Server,
   *   adapter: import('../adapter/dsh.js').DshAdapter,
   *   eventHub: import('./eventhub.js').EventHub,
   *   tokens: import('./auth.js').TokenStore,
   *   log: (msg: string) => void,
   *   path?: string,
   * }} deps
   */
  constructor(deps) {
    this.server = deps.server;
    this.adapter = deps.adapter;
    this.eventHub = deps.eventHub;
    this.tokens = deps.tokens;
    this.log = typeof deps.log === 'function' ? deps.log : () => {};
    this.path = typeof deps.path === 'string' ? deps.path : '/ws';
    /** @type {Set<{ socket: import('ws').WebSocket, clientId: string, sessionId: string, alive: boolean }>} */
    this.clients = new Set();
    this.wss = null;
    this.heartbeatTimer = null;
    this.unsubscribeHub = null;
    this.disposed = false;
  }

  start() {
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', this.handleUpgrade);

    this.wss.on('connection', (socket, request, clientId) => {
      const state = { socket, clientId, sessionId: '', alive: true };
      this.clients.add(state);
      this.log(`WS 客户端接入: ${clientId}（当前 ${this.clients.size} 个）`);

      // 握手：hello（含版本与当前 cursor，便于客户端判断是否要补拉）
      const hello = this.eventHub.helloPayload();
      this.sendTo(state, {
        type: 'hello',
        seq: this.eventHub.currentCursor(),
        timestamp: Date.now(),
        payload: {
          clientId,
          bridgeVersion: hello.bridgeVersion,
          contractVersion: hello.contractVersion,
          cursor: hello.cursor,
          protocol: 'dsh-phone-bridge',
        },
      });

      socket.on('message', (raw) => {
        this.handleClientMessage(state, raw);
      });
      socket.on('pong', () => {
        state.alive = true;
      });
      socket.on('close', () => {
        this.clients.delete(state);
        this.log(`WS 客户端断开: ${clientId}（当前 ${this.clients.size} 个）`);
      });
      socket.on('error', (error) => {
        this.log(`WS 客户端 ${clientId} 错误: ${error instanceof Error ? error.message : String(error)}`);
      });
    });

    // 广播 EventHub 事件
    this.unsubscribeHub = this.eventHub.subscribe((envelope) => {
      for (const state of this.clients) {
        // 会话级过滤：客户端订阅了某个会话时只推该会话的（全局事件 sessionId 为空仍推）
        if (state.sessionId.length > 0 && envelope.sessionId.length > 0 && envelope.sessionId !== state.sessionId) {
          continue;
        }
        this.sendTo(state, envelope);
      }
    });

    // 心跳
    this.heartbeatTimer = setInterval(() => {
      for (const state of this.clients) {
        if (!state.alive) {
          try {
            state.socket.terminate();
          } catch (error) {
            // 忽略
          }
          this.clients.delete(state);
          continue;
        }
        state.alive = false;
        try {
          state.socket.ping();
        } catch (error) {
          // 忽略
        }
      }
    }, HEARTBEAT_MS);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  handleUpgrade = (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch (error) {
      socket.destroy();
      return;
    }
    if (url.pathname !== this.path) {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') ?? '';
    let clientId = '';
    try {
      const record = this.tokens.verify(token, request.socket.remoteAddress ?? '');
      clientId = record.clientId;
    } catch (error) {
      const bridgeError = asBridgeError(error);
      // 拒绝升级：先回一个 HTTP 401 再断开（浏览器/手机能看到原因）
      const text = JSON.stringify({ error: { code: bridgeError.code, message: bridgeError.message } });
      socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request, clientId);
    });
  };

  sendTo(state, frame) {
    if (state.socket.readyState !== 1) return;
    try {
      state.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.log(`下发失败(${state.clientId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  reply(state, frame) {
    this.sendTo(state, { seq: this.eventHub.currentCursor(), timestamp: Date.now(), ...frame });
  }

  async handleClientMessage(state, raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch (error) {
      this.reply(state, { type: 'error', payload: { code: ErrorCode.INVALID_PARAM, message: '帧不是合法 JSON' } });
      return;
    }
    if (message === null || typeof message !== 'object') {
      this.reply(state, { type: 'error', payload: { code: ErrorCode.INVALID_PARAM, message: '帧必须是对象' } });
      return;
    }
    const type = typeof message.type === 'string' ? message.type : '';

    try {
      if (type === 'ping') {
        this.reply(state, { type: 'pong', payload: { time: Date.now() } });
        return;
      }
      if (type === 'subscribe') {
        state.sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        this.reply(state, {
          type: 'subscribed',
          sessionId: state.sessionId,
          payload: { sessionId: state.sessionId },
        });
        return;
      }
      if (type === 'unsubscribe') {
        state.sessionId = '';
        this.reply(state, { type: 'subscribed', sessionId: '', payload: { sessionId: '' } });
        return;
      }
      if (type === 'sync') {
        const cursor = typeof message.cursor === 'number' ? message.cursor : 0;
        const replay = this.eventHub.replaySince(cursor);
        if (replay.invalidated === true) {
          this.reply(state, {
            type: 'sync.invalidated',
            payload: { cursor: replay.cursor },
          });
          return;
        }
        for (const envelope of replay.events) this.sendTo(state, envelope);
        this.reply(state, { type: 'sync.cursor', payload: { cursor: replay.cursor } });
        return;
      }
      if (type === 'state') {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : state.sessionId;
        if (sessionId.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, '缺少 sessionId');
        const value = await this.adapter.getState(sessionId);
        this.reply(state, { type: 'state.snapshot', sessionId, payload: value });
        return;
      }
      if (type === 'send') {
        const sessionId = typeof message.sessionId === 'string' && message.sessionId.length > 0
          ? message.sessionId
          : state.sessionId;
        const text = typeof message.text === 'string' ? message.text : '';
        const result = await this.adapter.prompt({
          sessionId,
          text,
          attachments: Array.isArray(message.attachments) ? message.attachments : undefined,
          requestId: typeof message.requestId === 'string' ? message.requestId : undefined,
          clientMessageId: typeof message.clientMessageId === 'string' ? message.clientMessageId : undefined,
          mode: typeof message.mode === 'string' ? message.mode : undefined,
          clientTimeZone: typeof message.clientTimeZone === 'string' ? message.clientTimeZone : undefined,
        });
        this.reply(state, {
          type: 'send.accepted',
          sessionId,
          payload: {
            sessionId,
            requestId: result.requestId,
            clientMessageId: result.clientMessageId,
            mode: result.mode,
          },
        });
        return;
      }
      if (type === 'stop') {
        const sessionId = typeof message.sessionId === 'string' && message.sessionId.length > 0
          ? message.sessionId
          : state.sessionId;
        const value = await this.adapter.cancel(sessionId);
        this.reply(state, { type: 'stop.accepted', sessionId, payload: value });
        return;
      }
      this.reply(state, {
        type: 'error',
        payload: { code: ErrorCode.INVALID_PARAM, message: `未知指令 ${type}` },
      });
    } catch (error) {
      const bridgeError = asBridgeError(error);
      this.reply(state, {
        type: 'error',
        payload: { code: bridgeError.code, message: bridgeError.message },
      });
    }
  }

  dispose() {
    this.disposed = true;
    if (typeof this.unsubscribeHub === 'function') {
      try {
        this.unsubscribeHub();
      } catch (error) {
        // 忽略
      }
      this.unsubscribeHub = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const state of this.clients) {
      try {
        state.socket.close(1001, 'bridge shutting down');
      } catch (error) {
        // 忽略
      }
    }
    this.clients.clear();
    if (this.wss !== null) {
      try {
        this.wss.close();
      } catch (error) {
        // 忽略
      }
      this.wss = null;
    }
    if (this.server !== null && typeof this.server.off === 'function') {
      this.server.off('upgrade', this.handleUpgrade);
    }
  }
}

export default WsDataPlane;
