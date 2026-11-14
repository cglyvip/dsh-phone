/**
 * dsh-phone-bridge · HTTP 控制面（REST）
 *
 * 只做"控制"：列出/新建/改名/归档/置顶/搜索会话，读写模型设置，配对取令牌。
 * 消息正文与流式增量走 WebSocket（bridge/ws.js）。
 *
 * 认证：除 /api/health 与 /api/pair 外，全部要求
 *   Authorization: Bearer <token>   或   ?token=<token>
 *
 * 证据等级：[实测] 路由与错误码按项目契约（shared/contract/contract.md）实现，
 * 底层 DSH 调用全部经 adapter/dsh.js 的已核实方法。
 */

import {
  BridgeError,
  ErrorCode,
  asBridgeError,
  errorBody,
  readJsonBody,
  requireString,
  optionalString,
  optionalInt,
  optionalBoolean,
  sendJson,
} from './errors.js';
import send from 'send';

/**
 * 隧道流量的 Host 头标记（与 cloudflare.js 的 TUNNEL_HOST_HEADER 一致）。
 * Quick Tunnel 启动时带 --http-host-header，所有经隧道进来的请求 Host 必然是
 * 这个值；本机直连/局域网的 Host 是 IP:端口。用它识别隧道来源比看
 * socket.remoteAddress 可靠 —— 隧道流量从 127.0.0.1 连入，socket 层面
 * 与本机用户无法区分。
 */
const TUNNEL_HOST = 'dsh-phone-bridge-tunnel';

/** /api/pair 防爆破：同源连续失败次数与锁定时长（contract §2.2 / 安全修复）。 */
const PAIR_MAX_FAILURES = 20;
const PAIR_LOCK_MS = 15 * 60 * 1000;

/** 极简路由表：method + 正则 → handler(params, ctx) */
function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match !== null) return { route, params: match.slice(1) };
  }
  return null;
}

/**
 * @param {{
 *   adapter: import('../adapter/dsh.js').DshAdapter,
 *   eventHub: import('./eventhub.js').EventHub,
 *   tokens: import('./auth.js').TokenStore,
 *   pairing: import('./auth.js').PairingCode,
 *   config: object,
 *   log: (msg: string) => void,
 * }} deps
 */
export function createHttpHandler(deps) {
  const { adapter, eventHub, tokens, pairing, config, log } = deps;

  const routes = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: handleHealth },
    { method: 'GET', pattern: /^\/api\/version$/, handler: handleVersion },
    { method: 'POST', pattern: /^\/api\/pair$/, handler: handlePair, open: true },
    { method: 'GET', pattern: /^\/api\/pairing-code$/, handler: handlePairingCode, open: true, loopbackOnly: true },
    { method: 'GET', pattern: /^\/api\/sessions$/, handler: handleListSessions },
    { method: 'POST', pattern: /^\/api\/sessions$/, handler: handleCreateSession },
    { method: 'POST', pattern: /^\/api\/sessions\/batch-delete$/, handler: handleBatchDelete },
    { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)$/, handler: handleGetSession },
    { method: 'PATCH', pattern: /^\/api\/sessions\/([^/]+)$/, handler: handlePatchSession },
    { method: 'DELETE', pattern: /^\/api\/sessions\/([^/]+)$/, handler: handleDeleteSession },
    { method: 'POST', pattern: /^\/api\/uploads$/, handler: handleUpload },
    { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)\/messages$/, handler: handleGetMessages },
    { method: 'POST', pattern: /^\/api\/sessions\/([^/]+)\/messages$/, handler: handlePostMessage },
    { method: 'POST', pattern: /^\/api\/sessions\/([^/]+)\/stop$/, handler: handleStop },
    { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)\/state$/, handler: handleGetState },
    { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)\/permission$/, handler: handleGetPermission },
    { method: 'PUT', pattern: /^\/api\/sessions\/([^/]+)\/permission$/, handler: handlePutPermission },
    { method: 'GET', pattern: /^\/api\/models$/, handler: handleGetModels },
    { method: 'GET', pattern: /^\/api\/settings\/model$/, handler: handleGetDefaultModel },
    { method: 'PUT', pattern: /^\/api\/settings\/model$/, handler: handlePutDefaultModel },
    { method: 'GET', pattern: /^\/api\/workspaces$/, handler: handleListWorkspaces },
    { method: 'GET', pattern: /^\/api\/dirs$/, handler: handleListDirs },
    { method: 'GET', pattern: /^\/api\/attachments\/([^/]+)$/, handler: handleAttachment, raw: true },
    { method: 'GET', pattern: /^\/api\/media\/([^/]+)$/, handler: handleMediaFile, raw: true },
    { method: 'GET', pattern: /^\/api\/files\/([^/]+)$/, handler: handleFileAttachment, raw: true },
    { method: 'GET', pattern: /^\/api\/sync$/, handler: handleSync },
    { method: 'GET', pattern: /^\/api\/search$/, handler: handleSearch },
  ];

  async function handleHealth() {
    return {
      status: 'ok',
      plugin: 'dsh-phone-bridge',
      bridgeVersion: eventHub.helloPayload().bridgeVersion,
      contractVersion: eventHub.helloPayload().contractVersion,
      cursor: eventHub.currentCursor(),
      time: Date.now(),
    };
  }

  async function handleVersion() {
    return eventHub.helloPayload();
  }

  async function handlePair(params, request) {
    // 防爆破：锁定期间直接拒绝（在解析 body 之前，避免无谓消耗）
    assertPairNotLocked(request);
    try {
      const body = await readJsonBody(request);
      const code = requireString(body, 'code');
      const clientName = optionalString(body, 'clientName') ?? '手机端';
      if (config.pairingMode === 'disabled') {
        throw new BridgeError(ErrorCode.PAIRING_DISABLED, '当前已关闭配对');
      }
      const ok = pairing.consume(code);
      if (!ok) {
        throw new BridgeError(ErrorCode.PAIRING_CODE_INVALID, '配对码错误或已过期');
      }
      recordPairSuccess(request);
      const issued = tokens.issue({ clientName, ip: clientIp(request) });
      log(`配对成功: ${clientName} (${clientIp(request)})`);
      return {
        token: issued.token,
        clientId: issued.clientId,
        expiresAt: issued.expiresAt,
        bridgeVersion: eventHub.helloPayload().bridgeVersion,
        contractVersion: eventHub.helloPayload().contractVersion,
      };
    } catch (error) {
      // 除「已关闭配对 / 已限流」外的失败都计入爆破计数（错误码猜测）
      const bridgeError = asBridgeError(error);
      if (bridgeError.code !== ErrorCode.PAIRING_DISABLED && bridgeError.code !== ErrorCode.RATE_LIMITED) {
        recordPairFailure(request);
      }
      throw error;
    }
  }

  async function handlePairingCode() {
    if (config.pairingMode === 'disabled') {
      throw new BridgeError(ErrorCode.PAIRING_DISABLED, '当前已关闭配对');
    }
    const current = pairing.current();
    return {
      code: current.code,
      expiresAt: current.expiresAt,
      expiresInMs: Math.max(0, current.expiresAt - Date.now()),
    };
  }

  async function handleListSessions(params, request, query) {
    const raw = query.get('archived');
    const archived = raw === 'true' || raw === '1';
    const sessions = await adapter.listSessions(archived);
    return { items: sessions, archived };
  }

  async function handleCreateSession(params, request) {
    const body = await readJsonBody(request);
    const result = await adapter.createSession({
      cwd: optionalString(body, 'cwd'),
      workspaceId: optionalString(body, 'workspaceId'),
      agentPreset: optionalString(body, 'agentPreset'),
      title: optionalString(body, 'title'),
    });
    return { sessionId: result.sessionId };
  }

  async function handleGetSession(params) {
    return adapter.getSession(decodeURIComponent(params[0]));
  }

  async function handlePatchSession(params, request) {
    const sessionId = decodeURIComponent(params[0]);
    const body = await readJsonBody(request);
    if (typeof body.title === 'string') {
      return adapter.renameSession(sessionId, body.title);
    }
    if (body.pinned === true) return adapter.pinSession(sessionId);
    if (body.pinned === false) return adapter.unpinSession(sessionId);
    if (body.archived === true) return adapter.archiveSession(sessionId, optionalBoolean(body, 'stopActivity'));
    if (body.archived === false) return adapter.unarchiveSession(sessionId);
    throw new BridgeError(ErrorCode.INVALID_PARAM, 'PATCH 需要 title / pinned / archived 之一');
  }

  /**
   * DELETE /api/sessions/:id
   *   无 purge 参数 → v3.0 行为不变：归档（软删，可恢复）。
   *   ?purge=true  → v3.1 硬删请求：DSH 没有对外硬删能力（adapter.purgeSession
   *                  内有完整核实记录），降级为归档并放 archivedFallback 上报。
   */
  async function handleDeleteSession(params, request, query) {
    const sessionId = decodeURIComponent(params[0]);
    const purge = query.get('purge');
    if (purge === 'true' || purge === '1') {
      const outcome = await adapter.purgeSession(sessionId);
      return {
        purged: outcome.purged === true ? [sessionId] : [],
        archivedFallback: outcome.purged === true ? [] : [sessionId],
        failed: [],
      };
    }
    return adapter.archiveSession(sessionId, true);
  }

  /** POST /api/sessions/batch-delete：批量硬删，≤200 个，部分成功返回 200。 */
  async function handleBatchDelete(params, request) {
    const body = await readJsonBody(request);
    const ids = Array.isArray(body.ids) ? body.ids : undefined;
    if (ids === undefined) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, '请求体需要 { "ids": ["..."] }');
    }
    return adapter.batchDeleteSessions(ids);
  }

  async function handleGetMessages(params, request, query) {
    const sessionId = decodeURIComponent(params[0]);
    const turns = optionalInt({ turns: query.get('turns') }, 'turns', { min: 1, max: 200 });
    const beforeTurn = optionalInt({ beforeTurn: query.get('beforeTurn') }, 'beforeTurn', { min: 0, max: 1e9 });
    return adapter.getHistoryPage(sessionId, { turns, beforeTurn });
  }

  async function handlePostMessage(params, request) {
    const sessionId = decodeURIComponent(params[0]);
    const body = await readJsonBody(request);
    // v3.1：text 允许为空（纯附件消息）；空文本且无附件时由 adapter 报 INVALID_PARAM。
    const text = optionalString(body, 'text') ?? '';
    const result = await adapter.prompt({
      sessionId,
      text,
      attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
      requestId: optionalString(body, 'requestId'),
      clientMessageId: optionalString(body, 'clientMessageId'),
      mode: optionalString(body, 'mode'),
      clientTimeZone: optionalString(body, 'clientTimeZone'),
    });
    return result;
  }

  async function handleStop(params) {
    const sessionId = decodeURIComponent(params[0]);
    return adapter.cancel(sessionId);
  }

  async function handleGetState(params) {
    return adapter.getState(decodeURIComponent(params[0]));
  }

  /** GET /api/sessions/:id/permission（v3.1 §9.5：当前权限模式，只读）。 */
  async function handleGetPermission(params) {
    return adapter.getPermission(decodeURIComponent(params[0]));
  }

  /** PUT /api/sessions/:id/permission（v3.1 §9.5：运行时改权限模式）；成功后广播 session.updated。 */
  async function handlePutPermission(params, request) {
    const sessionId = decodeURIComponent(params[0]);
    const body = await readJsonBody(request);
    const mode = requireString(body, 'mode');
    const result = await adapter.setPermission(sessionId, mode.trim());
    // 已有机制：让订阅该会话的手机刷新标签
    eventHub.publish('session.updated', sessionId, Date.now(), { sessionId }, 0);
    return result;
  }

  async function handleGetModels() {
    const catalog = await adapter.getModelCatalog();
    const current = await adapter.getDefaultModel();
    return { ...catalog, current };
  }

  async function handleGetDefaultModel() {
    return { selection: await adapter.getDefaultModel() };
  }

  async function handlePutDefaultModel(params, request) {
    const body = await readJsonBody(request);
    const provider = requireString(body, 'provider');
    const model = requireString(body, 'model');
    const reasoningEffort = optionalString(body, 'reasoningEffort');
    const saved = await adapter.saveDefaultModel({ provider, model, reasoningEffort });
    return { selection: saved };
  }

  async function handleListWorkspaces() {
    return adapter.listWorkspaces();
  }

  async function handleListDirs(params, request, query) {
    const target = query.get('path') ?? '';
    return adapter.browseDirectories(target);
  }

  async function handleSync(params, request, query) {
    const cursor = Number.parseInt(query.get('cursor') ?? '0', 10);
    return eventHub.replaySince(Number.isFinite(cursor) ? cursor : 0);
  }

  async function handleSearch(params, request, query) {
    return adapter.search(query.get('q') ?? '');
  }

  /**
   * 取图片附件的原始字节，直接以二进制响应返回（不走 JSON）。
   * 手机端 <Image> 组件可以直接把 URL 交给它渲染，省掉一次 base64 解码。
   */
  async function handleAttachment(params, request) {
    const raw = Array.isArray(params) && params.length > 0 ? params[0] : '';
    const attachmentId = decodeURIComponent(raw);
    const image = await adapter.readImageAttachment(attachmentId);
    return {
      __raw: true,
      status: 200,
      mediaType: image.mediaType,
      data: image.data,
    };
  }

  /** 已落盘的媒体文件（AI 生成视频），按文件名转出字节。 */
  async function handleMediaFile(params) {
    const raw = Array.isArray(params) && params.length > 0 ? params[0] : '';
    const name = decodeURIComponent(raw);
    const media = await adapter.mediaFilePath(name);
    return {
      __stream: true,
      root: media.root,
      fileName: media.fileName,
    };
  }

  /** 通用文件附件（工具结果里的 file 块），按内容寻址转出字节。 */
  async function handleFileAttachment(params) {
    const raw = Array.isArray(params) && params.length > 0 ? params[0] : '';
    const attachmentId = decodeURIComponent(raw);
    const stored = await adapter.readGenericAttachment(attachmentId);
    return {
      __raw: true,
      status: 200,
      mediaType: 'application/octet-stream',
      data: stored.data,
    };
  }

  /**
   * POST /api/uploads（v3.1，contract.md §9.1）：原始字节流上传。
   * 头：X-File-Name（URL 编码的原始文件名）、X-Media-Type（可省，缺省 octet-stream）。
   * 边收边落临时文件并算 sha256，上限 200 MB（超限 413 INVALID_PARAM），
   * 完成后由 adapter 写入内容寻址对象存储（同字节幂等复用）。
   */
  async function handleUpload(params, request) {
    // Content-Length 已超限时先排空请求体再交 adapter 抛 413：
    // 若不排空就写响应，服务器会在客户端还在发送时关闭连接（RST），
    // 客户端可能读不到 413 响应体。排空最长等 3 秒（客户端停滞时兜底）。
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > 200 * 1024 * 1024) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        if (typeof timer.unref === 'function') timer.unref();
        request.resume();
        request.once('end', resolve);
        request.once('close', resolve);
      });
    }
    const nameHeader = request.headers['x-file-name'];
    const name = typeof nameHeader === 'string' ? nameHeader : '';
    const mediaTypeHeader = request.headers['x-media-type'];
    const mediaType = typeof mediaTypeHeader === 'string' ? mediaTypeHeader : '';
    return adapter.saveUpload(request, {
      name,
      mediaType,
      contentLength: request.headers['content-length'],
    });
  }

  /** 判断请求是否来自本机 socket（隧道流量也是 127.0.0.1，所以必须再看 Host 标记）。 */
  function isLoopback(request) {
    const address = request.socket !== null && request.socket !== undefined ? request.socket.remoteAddress : '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  /** 判断请求是否经公网隧道进来（cloudflared --http-host-header 改写过的 Host）。 */
  function isTunnelRequest(request) {
    const host = typeof request.headers.host === 'string' ? request.headers.host.trim().toLowerCase() : '';
    return host === TUNNEL_HOST;
  }

  // ── /api/pair 防爆破：同源连续错 20 次 → 锁 15 分钟（RATE_LIMITED + retryAfter）──

  /** @type {Map<string, { failures: number, lockedUntil: number }>} */
  const pairLocks = new Map();

  function pairSource(request) {
    const ip = clientIp(request);
    return ip.length > 0 ? ip : 'unknown';
  }

  function assertPairNotLocked(request) {
    const entry = pairLocks.get(pairSource(request));
    if (entry === undefined) return;
    const remaining = entry.lockedUntil - Date.now();
    if (remaining > 0) {
      throw new BridgeError(ErrorCode.RATE_LIMITED, `配对失败次数过多，已临时锁定，请 ${Math.ceil(remaining / 1000)} 秒后再试`, {
        retryAfter: remaining,
      });
    }
    if (entry.failures >= PAIR_MAX_FAILURES) {
      // 锁定期满：重置，给新一轮机会
      pairLocks.delete(pairSource(request));
    }
  }

  function recordPairFailure(request) {
    const key = pairSource(request);
    const entry = pairLocks.get(key) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= PAIR_MAX_FAILURES) {
      entry.lockedUntil = Date.now() + PAIR_LOCK_MS;
      log(`配对失败已达 ${entry.failures} 次，来源 ${key} 锁定 15 分钟`);
    }
    pairLocks.set(key, entry);
  }

  function recordPairSuccess(request) {
    pairLocks.delete(pairSource(request));
  }

  function clientIp(request) {
    const address = request.socket !== null && request.socket !== undefined ? request.socket.remoteAddress : '';
    return typeof address === 'string' ? address : '';
  }

  function readToken(request, url) {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      return header.slice(7).trim();
    }
    const fromQuery = url.searchParams.get('token');
    return typeof fromQuery === 'string' ? fromQuery : '';
  }

  /**
   * 返回 (req, res) => Promise<void> 的处理器。
   */
  return async function handle(request, response) {
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch (error) {
      sendJson(response, 400, errorBody(new BridgeError(ErrorCode.INVALID_PARAM, '请求地址非法')));
      return;
    }
    const pathname = url.pathname;
    const method = (request.method ?? 'GET').toUpperCase();

    // CORS：仅当配置里显式列了来源时才放开
    const allowOrigins = Array.isArray(config.allowOrigins) ? config.allowOrigins : [];
    if (allowOrigins.length > 0) {
      const origin = request.headers.origin;
      if (typeof origin === 'string' && allowOrigins.includes(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      }
    }
    if (method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    const found = matchRoute(routes, method, pathname);
    if (found === null) {
      const body = errorBody(new BridgeError(ErrorCode.INVALID_PARAM, `未知接口 ${method} ${pathname}`));
      sendJson(response, body.status, body.body);
      return;
    }

    const { route, params } = found;

    try {
      if (route.loopbackOnly === true) {
        // 隧道流量从 127.0.0.1 连入，socket 层面与本机用户无法区分，
        // 所以 loopback-only 接口同时拒绝隧道 Host（安全修复：配对码曾可经隧道获取）。
        if (isTunnelRequest(request)) {
          throw new BridgeError(ErrorCode.ROUTE_LOCAL_ONLY, '该接口不允许通过公网隧道访问');
        }
        if (!isLoopback(request)) {
          throw new BridgeError(ErrorCode.ROUTE_LOCAL_ONLY, '该接口仅限本机访问');
        }
      }
      if (route.open !== true) {
        const token = readToken(request, url);
        if (token.length === 0) {
          throw new BridgeError(ErrorCode.AUTH_REQUIRED, '缺少访问令牌');
        }
        // verify 失败会抛 BridgeError（AUTH_INVALID / AUTH_EXPIRED）
        tokens.verify(token, clientIp(request));
      }
      const result = await route.handler(params, request, url.searchParams);
      // 流式文件响应（视频等）：交给 send 处理 Range / 条件请求 / MIME
      if (result !== null && typeof result === 'object' && result.__stream === true) {
        response.setHeader('Cache-Control', 'private, max-age=86400');
        const stream = send(request, '/' + encodeURIComponent(result.fileName), {
          root: result.root,
          index: false,
          dotfiles: 'deny',
          acceptRanges: true,
        });
        stream.on('error', (streamError) => {
          if (!response.headersSent) {
            response.statusCode = streamError.status ?? 500;
          }
          response.end();
        });
        stream.pipe(response);
        return;
      }
      // 原始字节响应（图片等）：不包 JSON，直接写二进制
      if (result !== null && typeof result === 'object' && result.__raw === true) {
        const body = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data ?? []);
        response.statusCode = typeof result.status === 'number' ? result.status : 200;
        response.setHeader('Content-Type', result.mediaType ?? 'application/octet-stream');
        response.setHeader('Content-Length', String(body.length));
        response.setHeader('Cache-Control', 'private, max-age=86400');
        response.end(body);
        return;
      }
      const statusCode = method === 'POST' && pathname.endsWith('/messages') ? 202 : 200;
      sendJson(response, statusCode, result);
    } catch (error) {
      const bridgeError = asBridgeError(error);
      if (bridgeError.code === ErrorCode.INTERNAL_ERROR) {
        log(`接口 ${method} ${pathname} 失败: ${bridgeError.message}`);
      }
      if (typeof bridgeError.retryAfter === 'number') {
        response.setHeader('Retry-After', String(Math.ceil(bridgeError.retryAfter / 1000)));
      }
      const body = errorBody(bridgeError);
      sendJson(response, body.status, body.body);
    }
  };
}

export default createHttpHandler;
