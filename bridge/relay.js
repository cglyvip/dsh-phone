/**
 * dsh-phone-bridge · 官方中转通道（relay）
 *
 * 解决的问题：商业软件不能让用户自备 VPS、配 frps、改路由器。这条通道让电脑
 * **主动向我们的中转服务拨出**一条 WSS 长连接，手机也从同一服务拨入，两端靠
 * 8 位配对码在服务端会合——用户零网络配置。
 *
 * 协议真源是服务端仓库的 PROTOCOL.md，这里只做桥这一侧的实现。要点：
 *   - 一条 /bridge 连接承载多个手机请求，靠 requestId（HTTP）与 connId（WS）复用
 *   - 控制帧全是文本帧；HTTP body 是紧跟控制帧的**二进制帧**，全程按字节处理
 *   - 电脑每 20 秒必须发一次 {"type":"ping"}，服务端 40 秒收不到任何帧就判定离线
 *
 * 安全边界（重要）：relay 转发到本机桥的请求，socket 源地址是 127.0.0.1，
 * 与真正的本机用户无法区分。因此这里**必须**在 request/WS 上打标记
 * （RELAY_MARKER_HEADER / relaySocket 属性），让 bridge/http.js 的「仅本机接口」
 * 判定能识别出来并拒绝——否则配对码会经公网泄露。
 */

import crypto from 'node:crypto';
import { WebSocket } from 'ws';

/** relay 转发进来的请求携带的标记头（值为随机串，防止外部伪造）。 */
export const RELAY_MARKER_HEADER = 'x-dsh-relay';

/** 默认中转服务地址：用户不必自己找地址，开箱即用。 */
export const DEFAULT_RELAY_ENDPOINT = 'wss://relay.cgly.top';

/** 配对码：8 位 [a-z0-9]，与服务端 PAIR_RE 一致。 */
const PAIR_CODE_RE = /^[a-z0-9]{8}$/;

/** 服务端心跳超时 40 秒，这里留足余量后 20 秒发一次。 */
const HEARTBEAT_MS = 20_000;

/** 断线重连退避：1s / 2s / 4s / 8s / 16s，最长不超过 60 秒。 */
const RECONNECT_BASE_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECTS = 5;

/** 配对码被占用时最多自动换码几次（8 位 36 进制，实际几乎不会触发）。 */
const MAX_CODE_RETRIES = 3;

/** 单个 HTTP 转发的兜底超时（服务端是 60 秒，这里略短以便先给出错误）。 */
const REQUEST_TIMEOUT_MS = 55_000;

/**
 * 生成一个长期配对码。
 *
 * 它只是「在服务端找到这台电脑」的地址，不是身份凭证——真正的身份验证仍由桥的
 * Bearer 令牌负责（手机配对后拿到的 dsb_xxx）。所以用普通随机数即可。
 */
export function newPairCode() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 校验配对码格式。 */
export function isValidPairCode(code) {
  return typeof code === 'string' && PAIR_CODE_RE.test(code);
}

/** 把 ws(s) 端点转成手机能直接填的 http(s) 基地址（配 /p/<code> 使用）。 */
export function relayHttpBase(endpoint) {
  return String(endpoint ?? '')
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://');
}

/** 手机应填写的基地址：https://relay.域名/p/<8位码>。 */
export function relayPublicUrl(endpoint, pairCode) {
  const base = relayHttpBase(endpoint);
  return base.length > 0 && isValidPairCode(pairCode) ? `${base}/p/${pairCode}` : '';
}

/**
 * 中转通道。
 *
 * 生命周期：start() 拨出并注册 → 长连接保持（自动重连）→ stop() 断开。
 * 状态通过 snapshot() 暴露，结构与其它通道一致（status / url / error）。
 */
export class RelayChannel {
  /**
   * @param {{
   *   endpoint: string,          // 例如 wss://relay.cgly.top
   *   token: string,             // 中转密钥（RELAY_TOKEN）
   *   pairCode: string,          // 8 位配对码
   *   localPort: number,         // 本机桥端口
   *   log?: (msg: string) => void,
   *   bridgeVersion?: string,
   *   contractVersion?: number,
   *   WebSocketImpl?: typeof WebSocket,
   *   fetchImpl?: typeof fetch,
   *   heartbeatMs?: number,
   *   reconnectBaseMs?: number,
   *   maxReconnects?: number,
   *   onPairCodeChange?: (code: string) => void,
   * }} options
   */
  constructor(options) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.token = typeof options.token === 'string' ? options.token.trim() : '';
    this.pairCode = typeof options.pairCode === 'string' ? options.pairCode.trim() : '';
    this.localPort = options.localPort;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.bridgeVersion = typeof options.bridgeVersion === 'string' ? options.bridgeVersion : '';
    this.contractVersion = Number.isInteger(options.contractVersion) ? options.contractVersion : 0;
    this.WebSocketImpl = typeof options.WebSocketImpl === 'function' ? options.WebSocketImpl : WebSocket;
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
    this.heartbeatMs = Number.isInteger(options.heartbeatMs) && options.heartbeatMs > 0
      ? options.heartbeatMs
      : HEARTBEAT_MS;
    this.reconnectBaseMs = Number.isInteger(options.reconnectBaseMs) && options.reconnectBaseMs >= 0
      ? options.reconnectBaseMs
      : RECONNECT_BASE_MS;
    this.maxReconnects = Number.isInteger(options.maxReconnects) && options.maxReconnects > 0
      ? options.maxReconnects
      : MAX_RECONNECTS;
    this.onPairCodeChange = typeof options.onPairCodeChange === 'function'
      ? options.onPairCodeChange
      : null;

    // 每次启动生成一次，转发到本机桥时带上；外部无法猜到，防止伪造「我是 relay」
    this.marker = crypto.randomBytes(16).toString('base64url');

    this.ws = null;
    this.stopping = false;
    this.registered = false;
    /** 是否成功注册过：成功过就无限重连（只封顶退避间隔），避免长跑后永久掉线。 */
    this.everRegistered = false;
    this.reconnects = 0;
    this.codeRetries = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    /** @type {Map<string, object>} requestId → 在途条目 */
    this.pending = new Map();
    /** 等待二进制 body 的条目队列（服务端按发送顺序紧跟 body，FIFO 匹配）。 */
    this.bodyQueue = [];
    /** @type {Map<string, import('ws').WebSocket>} */
    this.phones = new Map();
    this.state = { status: 'starting', url: '', error: '' };
  }

  /** 对外地址：手机应填的基地址（http/https 形式，不是 ws 形式）。 */
  get publicUrl() {
    return relayPublicUrl(this.endpoint, this.pairCode);
  }

  /** 与其它通道一致的快照结构。 */
  snapshot() {
    return {
      status: this.state.status,
      url: this.state.status === 'running' ? this.publicUrl : '',
      error: this.state.error,
      pairCode: this.pairCode,
    };
  }

  /** 拨出并注册；失败时不抛（由 state 表达），与其它通道的容错语义一致。 */
  async start() {
    this.stopping = false;
    if (!isValidPairCode(this.pairCode)) {
      this.state = { status: 'error', url: '', error: '中转配对码必须是 8 位小写字母或数字' };
      return;
    }
    if (this.token.length === 0) {
      this.state = { status: 'error', url: '', error: '缺少中转密钥，请在配对页填写' };
      return;
    }
    if (this.endpoint.length === 0) {
      this.state = { status: 'error', url: '', error: '中转服务地址无效（需要 wss:// 或 https://）' };
      return;
    }
    await this.connect();
  }

  /** 建立连接并注册（内部用，重连也走这里）。 */
  connect() {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      this.state = { status: 'starting', url: '', error: '' };
      let socket;
      try {
        socket = new this.WebSocketImpl(`${this.endpoint}/bridge`, {
          headers: { Authorization: `Bearer ${this.token}` },
          handshakeTimeout: 15_000,
        });
      } catch (error) {
        this.state = { status: 'error', url: '', error: `中转连接失败：${messageOf(error)}` };
        done();
        return;
      }
      this.ws = socket;

      // 注册超时：连上了但服务端不回 registered，也要给出可读的错误
      const registerTimer = setTimeout(() => {
        if (this.registered) return;
        this.state = { status: 'error', url: '', error: '中转服务未响应注册请求' };
        this.log('relay: 注册超时');
        try {
          socket.close();
        } catch {}
        done();
      }, 15_000);

      socket.on('open', () => {
        this.log(`relay: 已连接 ${this.endpoint}，注册配对码 ${maskCode(this.pairCode)}`);
        this.send({
          type: 'register',
          role: 'bridge',
          pairCode: this.pairCode,
          bridgeVersion: this.bridgeVersion,
          contractVersion: this.contractVersion,
        });
      });

      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          this.onBinaryFrame(data);
          return;
        }
        let msg;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (msg === null || typeof msg !== 'object') return;

        if (msg.type === 'registered') {
          clearTimeout(registerTimer);
          this.registered = true;
          this.everRegistered = true;
          this.reconnects = 0;
          this.codeRetries = 0;
          this.state = { status: 'running', url: this.publicUrl, error: '' };
          this.log(`relay: 注册成功，手机地址 ${this.publicUrl}`);
          this.startHeartbeat();
          done();
          return;
        }
        if (msg.type === 'error') {
          clearTimeout(registerTimer);
          const code = typeof msg.code === 'string' ? msg.code : 'UNKNOWN';
          if (code === 'CODE_TAKEN' && this.codeRetries < MAX_CODE_RETRIES) {
            // 配对码撞车（概率极低）：换一个再注册，不让用户自己处理
            this.codeRetries += 1;
            this.pairCode = newPairCode();
            if (this.onPairCodeChange !== null) {
              try {
                this.onPairCodeChange(this.pairCode);
              } catch {}
            }
            this.log(`relay: 配对码被占用，已换成 ${maskCode(this.pairCode)} 重试（${this.codeRetries}/${MAX_CODE_RETRIES}）`);
            this.registered = false;
            this.reconnects = 0;
            try {
              socket.close();
            } catch {}
            done();
            return;
          }
          if (code === 'INVALID_REGISTER') {
            this.state = { status: 'error', url: '', error: '中转注册被拒绝：配对码格式不正确' };
          } else if (code === 'CODE_TAKEN') {
            this.state = { status: 'error', url: '', error: '中转配对码已被占用，请在配对页重置配对码' };
          } else if (code === 'AUTH_INVALID') {
            this.state = { status: 'error', url: '', error: '中转密钥无效，请检查后重填' };
          } else {
            this.state = { status: 'error', url: '', error: `中转服务返回错误：${code}` };
          }
          this.log(`relay: ${this.state.error}`);
          done();
          return;
        }
        if (msg.type === 'pong') return;
        if (msg.type === 'req') {
          this.handleHttpRequest(msg);
          return;
        }
        if (msg.type === 'ws-open') {
          this.openPhoneSocket(msg);
          return;
        }
        if (msg.type === 'ws-in') {
          this.onPhoneData(msg);
          return;
        }
        if (msg.type === 'ws-close') {
          this.closePhoneSocket(msg.connId);
        }
      });

      socket.on('close', (code, reason) => {
        clearTimeout(registerTimer);
        this.stopHeartbeat();
        this.ws = null;
        this.registered = false;
        this.failAllPending('中转连接已断开');
        this.closeAllPhones();
        if (this.stopping) {
          this.state = { status: 'off', url: '', error: '' };
          done();
          return;
        }
        const detail = reason !== null && reason !== undefined && reason.length > 0
          ? `（${reason.toString()}）`
          : '';
        this.log(`relay: 连接断开 code=${code}${detail}`);
        this.scheduleReconnect(code, detail);
        done();
      });

      socket.on('error', (error) => {
        // close 事件随后会到，这里只记日志避免重复处理
        this.log(`relay: 连接错误 ${messageOf(error)}`);
      });
    });
  }

  /** 断线重连（指数退避，间隔封顶 60 秒）。 */
  scheduleReconnect(code, detail) {
    if (this.reconnectTimer !== null) return;
    // 成功注册过的通道无限重连：用户装好就该一直能用，
    // 不能因为网络抖了几分钟就永久放弃。从未成功过的才限制次数，避免密码错时死循环。
    const limit = this.everRegistered ? Number.POSITIVE_INFINITY : this.maxReconnects;
    if (this.reconnects >= limit) {
      this.state = {
        status: 'error',
        url: '',
        error: `中转连接已断开${detail}，重试 ${this.reconnects} 次后放弃`,
      };
      return;
    }
    this.reconnects += 1;
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** (this.reconnects - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    this.state = {
      status: 'starting',
      url: '',
      error: `中转连接断开${detail}，${Math.max(1, Math.round(delay / 1000))} 秒后重连（第 ${this.reconnects} 次）`,
    };
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping) return;
      void this.connect();
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, this.heartbeatMs);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  send(frame) {
    const socket = this.ws;
    if (socket === null || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.log(`relay: 发送失败 ${messageOf(error)}`);
      return false;
    }
  }

  /** 同步排入控制帧和二进制帧，等写出再读下一块，避免整个下载堆在 WS 发送队列。 */
  sendWithBody(frame, buffer) {
    const socket = this.ws;
    if (socket === null || socket.readyState !== 1) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        socket.send(JSON.stringify(frame));
        socket.send(buffer, (error) => resolve(!error));
      } catch (error) {
        this.log(`relay: 发送失败 ${messageOf(error)}`);
        resolve(false);
      }
    });
  }

  // ───────────────────────── HTTP 转发 ─────────────────────────

  /**
   * 服务端送来一个手机 HTTP 请求：在本机发起同样的请求，再把响应原样回传。
   *
   * 为什么不在本机直接复用 http 处理函数：走一次真实的回环 HTTP 请求，
   * 桥的鉴权、路由、媒体字节流全部照旧生效，无需为 relay 单独维护一份逻辑。
   * 但必须带上 RELAY_MARKER_HEADER，让「仅本机接口」判定认出它来自公网。
   */
  handleHttpRequest(msg) {
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    const path = typeof msg.path === 'string' ? msg.path : '';
    const method = typeof msg.method === 'string' ? msg.method.toUpperCase() : 'GET';
    const bodyLength = Number.isInteger(msg.bodyLength) && msg.bodyLength > 0 ? msg.bodyLength : 0;
    if (requestId.length === 0 || this.pending.has(requestId)) return;
    // 中转协议送来已剥掉 /p/<码> 的根相对路径，保留编码段和原查询串。
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#\u0000- \u007f]/.test(path)) {
      this.send({ type: 'res', requestId, status: 400, headers: {}, bodyLength: 0, end: true });
      return;
    }

    const headers = Object.create(null);
    for (const [name, value] of Object.entries(msg.headers ?? {})) {
      const key = name.toLowerCase();
      if (key === 'host' || key === 'connection' || key === 'content-length' || key === 'transfer-encoding') continue;
      headers[key] = value;
    }
    headers[RELAY_MARKER_HEADER] = this.marker;
    // fetch 会自动解压响应，回环要求原始表示，避免字节与 Content-Length 不一致。
    headers['accept-encoding'] = 'identity';

    // 真实来源 IP：nginx 在服务端写入 x-real-ip，中转服务原样带过来。
    // 桥的配对防爆破按这个计，否则所有中转用户会共用 127.0.0.1 一个计数器。
    const realIp = typeof headers['x-real-ip'] === 'string' ? headers['x-real-ip'].trim() : '';
    if (realIp.length > 0) headers['x-forwarded-for'] = realIp;

    const entry = {
      requestId,
      method,
      path,
      headers,
      wantBytes: bodyLength,
      chunks: [],
      received: 0,
      timer: null,
      abort: null,
    };
    this.pending.set(requestId, entry);

    const timer = setTimeout(() => {
      if (!this.finishEntry(requestId)) return;
      try {
        if (typeof entry.abort === 'function') entry.abort();
      } catch {}
      this.send({ type: 'res', requestId, status: 504, headers: {}, bodyLength: 0, end: true });
      this.log(`relay: 本机 ${method} 请求超时`);
    }, REQUEST_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    entry.timer = timer;

    if (bodyLength === 0) {
      void this.dispatchHttp(entry, undefined);
      return;
    }
    // 服务端在 req 帧之后紧跟一帧二进制 body：排队等它
    this.bodyQueue.push(entry);
  }

  /** 真正发起本机请求并把结果回给服务端。 */
  async dispatchHttp(entry, body) {
    const { requestId, method, path, headers } = entry;
    const controller = new AbortController();
    const isCurrent = () => this.pending.get(requestId) === entry;
    entry.abort = () => controller.abort();
    let reader;
    let headersSent = false;
    let complete = false;
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${this.localPort}${path}`, {
        method,
        headers,
        body: body !== undefined && body.length > 0 ? body : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!isCurrent()) return;

      const outHeaders = {};
      for (const [key, value] of response.headers.entries()) {
        // 连接级响应头由中转端管理；长度、Range、ETag 和文件名原样透传。
        if (key === 'transfer-encoding' || key === 'connection') continue;
        outHeaders[key] = value;
      }
      const noBody = response.body === null || method === 'HEAD';
      headersSent = this.send({
        type: 'res', requestId, status: response.status, headers: outHeaders, bodyLength: 0, end: noBody,
      });
      if (!headersSent || noBody) {
        complete = noBody;
        return;
      }

      reader = response.body.getReader();
      while (isCurrent()) {
        const { done, value } = await reader.read();
        if (!isCurrent()) return;
        if (done) {
          complete = true;
          this.send({ type: 'res', requestId, status: response.status, headers: {}, bodyLength: 0, end: true });
          return;
        }
        if (value?.length > 0) {
          const written = await this.sendWithBody({
            type: 'res', requestId, status: response.status, headers: {}, bodyLength: value.length, end: false,
          }, value);
          if (!written) return;
        }
      }
    } catch (error) {
      // 超时或断连已结束的请求不能重复写；开始传文件后也不能把 JSON 拼进文件。
      if (!isCurrent()) return;
      this.finishEntry(requestId);
      if (headersSent || method === 'HEAD') {
        this.send({ type: 'res', requestId, status: 502, headers: {}, bodyLength: 0, end: true });
      } else {
        const detail = Buffer.from(JSON.stringify({ error: { code: 'BRIDGE_ERROR', message: '桥处理请求失败' } }));
        await this.sendWithBody({
          type: 'res', requestId, status: 502,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(detail.length),
          },
          bodyLength: detail.length, end: true,
        }, detail);
      }
      this.log(`relay: 本机 ${method} 请求失败：${messageOf(error)}`);
    } finally {
      reader?.releaseLock();
      if (!complete) controller.abort();
      if (isCurrent()) this.finishEntry(requestId);
    }
  }

  /** 收到服务端的二进制帧：按 FIFO 归属到最早一个仍在等 body 的请求。 */
  onBinaryFrame(data) {
    while (this.bodyQueue.length > 0) {
      const entry = this.bodyQueue[0];
      if (!this.pending.has(entry.requestId)) {
        this.bodyQueue.shift();
        continue;
      }
      const buffer = Buffer.from(data);
      entry.chunks.push(buffer);
      entry.received += buffer.length;
      if (entry.received >= entry.wantBytes) {
        this.bodyQueue.shift();
        const body = Buffer.concat(entry.chunks, entry.received).subarray(0, entry.wantBytes);
        void this.dispatchHttp(entry, body);
      }
      return;
    }
  }

  /** 结束一个在途条目：清定时器、出队、删表。返回它是否还在。 */
  finishEntry(requestId) {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.pending.delete(requestId);
    const index = this.bodyQueue.indexOf(entry);
    if (index >= 0) this.bodyQueue.splice(index, 1);
    return true;
  }

  failAllPending(reason) {
    const count = this.pending.size;
    for (const requestId of [...this.pending.keys()]) {
      const entry = this.pending.get(requestId);
      if (typeof entry?.abort === 'function') {
        try {
          entry.abort();
        } catch {}
      }
      this.finishEntry(requestId);
    }
    if (count > 0) this.log(`relay: ${reason}，已取消 ${count} 个在途请求`);
  }

  // ───────────────────────── WebSocket 转发 ─────────────────────────

  /** 手机连进来：在本机桥开一条同样的 WS。 */
  openPhoneSocket(msg) {
    const connId = typeof msg.connId === 'string' ? msg.connId : '';
    if (connId.length === 0) return;
    const path = typeof msg.path === 'string' && msg.path.length > 0 ? msg.path : '/ws';
    const search = typeof msg.search === 'string' ? msg.search : '';

    let socket;
    try {
      socket = new this.WebSocketImpl(`ws://127.0.0.1:${this.localPort}${path}${search}`, {
        headers: { [RELAY_MARKER_HEADER]: this.marker },
        handshakeTimeout: 15_000,
      });
    } catch (error) {
      this.log(`relay: 本机 WS 建立失败 ${messageOf(error)}`);
      this.send({ type: 'ws-close', connId });
      return;
    }
    this.phones.set(connId, socket);

    socket.on('message', (data, isBinary) => {
      this.send({
        type: 'ws-out',
        connId,
        payload: Buffer.from(data).toString('base64'),
        binary: isBinary,
      });
    });
    socket.on('close', () => {
      if (this.phones.get(connId) === socket) this.phones.delete(connId);
      this.send({ type: 'ws-close', connId });
    });
    socket.on('error', (error) => {
      this.log(`relay: 本机 WS 错误 ${connId}：${messageOf(error)}`);
    });
  }

  /** 手机发来的帧：原样转给本机桥。 */
  onPhoneData(msg) {
    const connId = typeof msg.connId === 'string' ? msg.connId : '';
    const socket = this.phones.get(connId);
    if (socket === undefined || socket.readyState !== 1) return;
    let buffer;
    try {
      buffer = Buffer.from(typeof msg.payload === 'string' ? msg.payload : '', 'base64');
    } catch {
      return;
    }
    try {
      if (msg.binary === true) socket.send(buffer);
      else socket.send(buffer.toString('utf8'));
    } catch (error) {
      this.log(`relay: 转发到本机 WS 失败 ${connId}：${messageOf(error)}`);
    }
  }

  closePhoneSocket(connId) {
    const socket = this.phones.get(String(connId));
    if (socket === undefined) return;
    this.phones.delete(String(connId));
    try {
      socket.close();
    } catch {}
  }

  closeAllPhones() {
    for (const [connId, socket] of this.phones) {
      try {
        socket.close();
      } catch {}
      this.phones.delete(connId);
    }
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  /** 停止通道：断开中转连接，清理在途请求与手机 WS。 */
  async stop() {
    this.stopping = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failAllPending('通道已停止');
    this.closeAllPhones();
    const socket = this.ws;
    this.ws = null;
    this.registered = false;
    this.everRegistered = false;
    if (socket !== null) {
      try {
        socket.close();
      } catch {}
    }
    this.state = { status: 'off', url: '', error: '' };
  }
}

/**
 * 规范化中转地址：接受 ws/wss，也接受用户直接填的 https/http。
 * 返回统一为 ws(s) 形式，去掉尾部斜杠。
 */
export function normalizeEndpoint(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (text.length === 0) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  let protocol = url.protocol.toLowerCase();
  if (protocol === 'https:') protocol = 'wss:';
  else if (protocol === 'http:') protocol = 'ws:';
  if (protocol !== 'ws:' && protocol !== 'wss:') return '';
  if (url.hostname.length === 0) return '';
  return `${protocol}//${url.host}`;
}

function maskCode(code) {
  return code.length === 8 ? `${code.slice(0, 2)}****${code.slice(-2)}` : '********';
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
