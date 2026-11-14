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
    { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)$/, handler: handleGetSession },
    { method: 'PATCH', pattern: /^\/api\/sessions\/([^/]+)$/, handler: handlePatchSession },
    { method: 'DELETE', pattern: /^\/api\/sessions\/([^/]+)$/, handler: handleDeleteSession },
    { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)\/messages$/, handler: handleGetMessages },
    { method: 'POST', pattern: /^\/api\/sessions\/([^/]+)\/messages$/, handler: handlePostMessage },
    { method: 'POST', pattern: /^\/api\/sessions\/([^/]+)\/stop$/, handler: handleStop },
    { method: 'GET', pattern: /^\/api\/sessions\/([^/]+)\/state$/, handler: handleGetState },
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
    const issued = tokens.issue({ clientName, ip: clientIp(request) });
    log(`配对成功: ${clientName} (${clientIp(request)})`);
    return {
      token: issued.token,
      clientId: issued.clientId,
      expiresAt: issued.expiresAt,
      bridgeVersion: eventHub.helloPayload().bridgeVersion,
      contractVersion: eventHub.helloPayload().contractVersion,
    };
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

  async function handleDeleteSession(params) {
    const sessionId = decodeURIComponent(params[0]);
    return adapter.archiveSession(sessionId, true);
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
    const text = requireString(body, 'text');
    const result = await adapter.prompt({
      sessionId,
      text,
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

  /** 判断请求是否来自本机（用于 /api/pairing-code） */
  function isLoopback(request) {
    const address = request.socket !== null && request.socket !== undefined ? request.socket.remoteAddress : '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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
      if (route.loopbackOnly === true && !isLoopback(request)) {
        throw new BridgeError(ErrorCode.AUTH_REQUIRED, '该接口仅限本机访问');
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
