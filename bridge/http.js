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
import { timingSafeEqual } from 'node:crypto';
import { probePublicUrl, TUNNEL_MODES } from './transport.js';
import { RELAY_MARKER_HEADER } from './relay.js';

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

/** 极简路由表：仅附件 GET 路由可复用同一处理器支持 HEAD。 */
function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method && !(method === 'HEAD' && route.head === true)) continue;
    const match = route.pattern.exec(pathname);
    if (match !== null) return { route, params: match.slice(1) };
  }
  return null;
}

function attachmentIdOf(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BridgeError(ErrorCode.INVALID_PARAM, '附件 ID 的 URL 编码无效');
  }
}

/** 文件名仅用于响应头展示，不用于选择磁盘对象或 MIME。 */
function attachmentDisposition(kind, value) {
  const name = String(value ?? '').replace(/\\/g, '/').split('/').at(-1)
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255).toWellFormed();
  if (name.length === 0) return kind;
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename*=UTF-8''${encoded}`;
}

/** 三条下载路由统一走流式文件响应，不为 Range 预读整个文件。 */
function sendAttachment(request, response, file) {
  response.setHeader('Cache-Control', 'private, max-age=86400');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (file.mediaType) response.setHeader('Content-Type', file.mediaType);
  if (file.disposition === 'attachment' || file.name) {
    response.setHeader('Content-Disposition', attachmentDisposition(file.disposition ?? 'inline', file.name));
  }
  // HTTP Range 只用于 GET；HEAD 返回完整资源的头，不打开文件流。
  if (request.method === 'HEAD') delete request.headers.range;
  const stream = send(request, '/' + encodeURIComponent(file.fileName), {
    root: file.root,
    index: false,
    dotfiles: 'deny',
    acceptRanges: true,
  });
  stream.on('error', (error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error.status === 416) {
      response.statusCode = 416;
      response.setHeader('Content-Length', '0');
      response.end();
      return;
    }
    response.removeHeader('Content-Disposition');
    response.removeHeader('Content-Range');
    response.removeHeader('ETag');
    response.removeHeader('Last-Modified');
    if (error.status === 403 || error.status === 404) {
      sendJson(response, 404, errorBody(new BridgeError(file.notFound, '附件不存在')).body);
      return;
    }
    const status = error.status ?? 500;
    const code = status < 500 ? ErrorCode.INVALID_PARAM : ErrorCode.INTERNAL_ERROR;
    sendJson(response, status, errorBody(new BridgeError(code, '无法读取附件')).body);
  });
  stream.pipe(response);
}

/**
 * @param {{
 *   adapter: import('../adapter/dsh.js').DshAdapter,
 *   eventHub: import('./eventhub.js').EventHub,
 *   tokens: import('./auth.js').TokenStore,
 *   pairing: import('./auth.js').PairingCode,
 *   transport?: import('./transport.js').TransportManager,
 *   transportPersistFile?: string,
 *   config: object,
 *   log: (msg: string) => void,
 * }} deps
 */
export function createHttpHandler(deps) {
  const { adapter, eventHub, tokens, pairing, transport, transportPersistFile, localControlToken, config, log } = deps;

  /**
   * 取当前中转通道的标记串。relay 转发到本机桥的请求 socket 源是 127.0.0.1，
   * 与本机用户无法区分；靠这个随机串（每次启动生成、不经网络传输）识别来源。
   */
  function relayMarker() {
    if (transport === undefined || transport === null) return '';
    if (typeof transport.relayMarker !== 'function') return '';
    const marker = transport.relayMarker();
    return typeof marker === 'string' ? marker : '';
  }

  /**
   * 判断请求是否由中转通道转发进来。
   *
   * 标记串是 32 字节随机的 base64url，只存在于本进程与转发头里，外部猜不到；
   * 用定长比较避免时序侧信道。值对不上就当作普通请求，不做任何特殊处理。
   */
  function isRelayRequest(request) {
    const value = request.headers[RELAY_MARKER_HEADER];
    if (typeof value !== 'string' || value.length === 0) return false;
    const expected = relayMarker();
    if (expected.length === 0) return false;
    const actual = Buffer.from(value, 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  }

  /** 请求的真实来源 IP：中转请求带 x-forwarded-for（由中转服务从 nginx 的 x-real-ip 传入）。 */
  function requestIp(request) {
    if (isRelayRequest(request)) {
      const forwarded = request.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length > 0) {
        const first = forwarded.split(',')[0].trim();
        if (first.length > 0) return first;
      }
    }
    return clientIp(request);
  }

  const routes = [
    { method: 'GET', pattern: /^\/api\/health$/, handler: handleHealth },
    { method: 'GET', pattern: /^\/api\/version$/, handler: handleVersion },
    { method: 'POST', pattern: /^\/api\/pair$/, handler: handlePair, open: true },
    { method: 'GET', pattern: /^\/api\/pairing-code$/, handler: handlePairingCode, open: true, loopbackOnly: true },
    { method: 'GET', pattern: /^\/api\/transport$/, handler: handleTransportStatus },
    { method: 'POST', pattern: /^\/api\/transport\/mode$/, handler: handleTransportSwitch, loopbackOnly: true, localControl: true },
    { method: 'POST', pattern: /^\/api\/transport\/probe$/, handler: handleTransportProbe, loopbackOnly: true, localControl: true },
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
    { method: 'GET', pattern: /^\/api\/attachments\/([^/]+)$/, handler: handleAttachment, head: true },
    { method: 'GET', pattern: /^\/api\/media\/([^/]+)$/, handler: handleMediaFile, head: true },
    { method: 'GET', pattern: /^\/api\/files\/([^/]+)$/, handler: handleFileAttachment, head: true },
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

  /** GET /api/transport（v3.2 §10）：公网通道状态（mode/url/error/每通道明细）。 */
  async function handleTransportStatus() {
    if (transport === undefined) {
      throw new BridgeError(ErrorCode.NOT_SUPPORTED, '当前版本未启用通道管理');
    }
    return transport.status();
  }

  /**
   * POST /api/transport/mode（v3.2 §10 / v3.3 §10.1，仅本机）：一键切换公网通道，停旧起新。
   * body: { "tunnelMode"|"mode": "quick"|"named"|"frp"|"custom"|"ngrok"|"relay"|"off",
   *         publicUrl?, frp?, ngrok? }
   * 切换时可一并写入通道参数并持久化到 transport.json（600）；
   * frp token / ngrok authtoken 只落盘，不回显到任何响应。
   */
  async function handleTransportSwitch(params, request) {
    if (transport === undefined) {
      throw new BridgeError(ErrorCode.NOT_SUPPORTED, '当前版本未启用通道管理');
    }
    const body = await readJsonBody(request);
    const rawMode = typeof body.tunnelMode === 'string' && body.tunnelMode.trim().length > 0
      ? body.tunnelMode
      : (typeof body.mode === 'string' ? body.mode : undefined);
    if (typeof rawMode !== 'string' || rawMode.trim().length === 0) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, '缺少 tunnelMode（或兼容别名 mode）');
    }
    const mode = rawMode.trim();
    if (!TUNNEL_MODES.includes(mode)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `tunnelMode 必须是 ${TUNNEL_MODES.join(' / ')} 之一`);
    }
    const switchParams = {};
    if (typeof body.publicUrl === 'string') switchParams.publicUrl = body.publicUrl;
    if (body.frp !== null && typeof body.frp === 'object') switchParams.frp = body.frp;
    if (body.ngrok !== null && typeof body.ngrok === 'object') switchParams.ngrok = body.ngrok;
    // v3.8：relay 参数（endpoint / token / pairCode）漏了这一行，配对页「开启中转」
    // 永远报「中转密钥不能为空」——参数在路由层就被丢掉了，根本到不了 TransportManager。
    if (body.relay !== null && typeof body.relay === 'object') switchParams.relay = body.relay;
    return transport.switchMode(mode, {
      ...(Object.keys(switchParams).length > 0 ? { params: switchParams } : {}),
      ...(typeof transportPersistFile === 'string' && transportPersistFile.length > 0
        ? { persistFile: transportPersistFile }
        : {}),
    });
  }

  /**
   * POST /api/transport/probe（v3.3 §10.1，仅本机）：探活公网地址。
   * body: { "url": "https://..." } → 对 <url>/api/health GET 一次（3s 超时）
   * → { ok, status, latencyMs, error? }。custom 模式粘贴地址后即时验证用。
   */
  async function handleTransportProbe(params, request) {
    if (transport === undefined) {
      throw new BridgeError(ErrorCode.NOT_SUPPORTED, '当前版本未启用通道管理');
    }
    const body = await readJsonBody(request);
    const url = requireString(body, 'url');
    return probePublicUrl(url, { timeoutMs: 3000 });
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

  /** PUT /api/sessions/:id/permission（§9.5/§9.6：运行时改权限模式与审批策略，任意组合）；成功后广播 session.updated。 */
  async function handlePutPermission(params, request) {
    const sessionId = decodeURIComponent(params[0]);
    const body = await readJsonBody(request);
    const mode = typeof body.mode === 'string' && body.mode.trim().length > 0 ? body.mode.trim() : undefined;
    const approval = typeof body.approval === 'string' && body.approval.trim().length > 0 ? body.approval.trim() : undefined;
    if (mode === undefined && approval === undefined) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, 'PUT 需要 mode / approval 至少一项');
    }
    const result = await adapter.setPermission(sessionId, {
      ...(mode !== undefined ? { mode } : {}),
      ...(approval !== undefined ? { approval } : {}),
    });
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

  /** 图片对象以原始二进制响应返回，不走 JSON 或 base64。 */
  async function handleAttachment(params, request, query) {
    const file = await adapter.imageAttachmentPath(attachmentIdOf(params[0]));
    return { ...file, name: query.get('name'), notFound: ErrorCode.ATTACHMENT_NOT_FOUND };
  }

  /** 已落盘的媒体文件（生图/生视频、会话交付），流式转出字节。 */
  async function handleMediaFile(params) {
    const file = await adapter.mediaFilePath(attachmentIdOf(params[0]));
    return { ...file, notFound: ErrorCode.MEDIA_NOT_FOUND };
  }

  /** 通用文件对象只按摘要定位，文件名可由消息块带到下载请求。 */
  async function handleFileAttachment(params, request, query) {
    const file = await adapter.genericAttachmentPath(attachmentIdOf(params[0]));
    return {
      ...file,
      name: query.get('name'),
      disposition: 'attachment',
      notFound: ErrorCode.ATTACHMENT_NOT_FOUND,
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

  /** 判断请求是否来自本机 socket（隧道/frp 来源也是 127.0.0.1，所以必须再看 Host）。 */
  function isLoopback(request) {
    const address = request.socket !== null && request.socket !== undefined ? request.socket.remoteAddress : '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  /**
   * Host 是否指向回环地址（127.0.0.1 / localhost / [::1]，端口任意）。
   * frp tcp 透传的 Host 是 vps:remotePort，局域网手机是 LAN IP:port——都不是回环，
   * 因此「socket 回环 + Host 回环」能把本机用户与所有公网通道来源区分开。
   */
  function hostIsLoopback(request) {
    const host = typeof request.headers.host === 'string' ? request.headers.host.trim().toLowerCase() : '';
    if (host.length === 0) return false;
    const hostPart = host.replace(/:\d+$/, '');
    return hostPart === '127.0.0.1' || hostPart === 'localhost' || hostPart === '[::1]' || hostPart === '::1';
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

  function hasLocalControlToken(request, route) {
    if (route.localControl !== true || route.loopbackOnly !== true
      || typeof localControlToken !== 'string' || localControlToken.length === 0) {
      return false;
    }
    const submitted = request.headers['x-dsh-local-control-token'];
    if (typeof submitted !== 'string') return false;
    const actual = Buffer.from(submitted, 'utf8');
    const expected = Buffer.from(localControlToken, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
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
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, If-Range');
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS');
        response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Disposition, ETag');
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
        // 公网通道（cloudflared 快速/命名隧道、frp tcp 透传、官方中转）的请求都从
        // 127.0.0.1 连入，socket 层面与本机用户无法区分：
        //   - 官方中转：请求带 x-dsh-relay 标记头 → 显式拒绝
        //   - quick 隧道：Host 被改写成 dsh-phone-bridge-tunnel → 显式拒绝
        //   - frp tcp：Host 是 vps:remotePort → 非 Host 回环 → 拒绝
        //   - 本机用户：Host 是 127.0.0.1[:port]/localhost[:port] → 放行
        // 业务接口不受影响（各通道 + LAN 的 Bearer 请求全部正常放行）。
        if (isRelayRequest(request)) {
          throw new BridgeError(ErrorCode.ROUTE_LOCAL_ONLY, '该接口不允许通过公网中转访问');
        }
        if (isTunnelRequest(request)) {
          throw new BridgeError(ErrorCode.ROUTE_LOCAL_ONLY, '该接口不允许通过公网隧道访问');
        }
        if (!isLoopback(request) || !hostIsLoopback(request)) {
          throw new BridgeError(ErrorCode.ROUTE_LOCAL_ONLY, '该接口仅限本机访问');
        }
      }
      if (route.open !== true && !hasLocalControlToken(request, route)) {
        const token = readToken(request, url);
        if (token.length === 0) {
          throw new BridgeError(ErrorCode.AUTH_REQUIRED, '缺少访问令牌');
        }
        // verify 失败会抛 BridgeError（AUTH_INVALID / AUTH_EXPIRED）
        tokens.verify(token, clientIp(request));
      }
      const result = await route.handler(params, request, url.searchParams);
      if (route.head === true) {
        sendAttachment(request, response, result);
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
