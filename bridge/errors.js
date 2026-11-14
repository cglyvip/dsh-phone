/**
 * dsh-phone-bridge · 统一错误码与 HTTP 小工具
 *
 * 契约要求（任务书 3.4）：错误体固定为
 *   { error: { code, message, retryAfter?, detail? } }
 * 证据等级：[官方源码/文档] —— 错误码集合取自任务书 3.4 草案，本插件自行实现。
 */

/** @typedef {'AUTH_REQUIRED'|'AUTH_INVALID'|'AUTH_EXPIRED'|'PAIRING_DISABLED'|'PAIRING_CODE_INVALID'|'SESSION_NOT_FOUND'|'MESSAGE_NOT_FOUND'|'NOT_SUPPORTED'|'INVALID_PARAM'|'RATE_LIMITED'|'DSH_ERROR'|'BRIDGE_OFFLINE'|'BRIDGE_INCOMPATIBLE'|'CONFLICT'|'INTERNAL_ERROR'} ErrorCodeName */

export const ErrorCode = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID: 'AUTH_INVALID',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  PAIRING_DISABLED: 'PAIRING_DISABLED',
  PAIRING_CODE_INVALID: 'PAIRING_CODE_INVALID',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  INVALID_PARAM: 'INVALID_PARAM',
  RATE_LIMITED: 'RATE_LIMITED',
  DSH_ERROR: 'DSH_ERROR',
  BRIDGE_OFFLINE: 'BRIDGE_OFFLINE',
  BRIDGE_INCOMPATIBLE: 'BRIDGE_INCOMPATIBLE',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/** HTTP 状态码映射（用于 REST；WS 只传 code）。 */
const STATUS = {
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  AUTH_EXPIRED: 401,
  PAIRING_DISABLED: 403,
  PAIRING_CODE_INVALID: 403,
  SESSION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  NOT_SUPPORTED: 501,
  INVALID_PARAM: 400,
  RATE_LIMITED: 429,
  DSH_ERROR: 502,
  BRIDGE_OFFLINE: 503,
  BRIDGE_INCOMPATIBLE: 409,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export class BridgeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, retryAfter?: number, detail?: unknown, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = extra.status ?? STATUS[code] ?? 400;
    this.retryAfter = extra.retryAfter;
    this.detail = extra.detail;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/** 把任意异常收敛成 BridgeError（未知异常 = INTERNAL_ERROR）。 */
export function asBridgeError(error) {
  if (error instanceof BridgeError) return error;
  const message = error && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);
  // DSH RemoteError 形如 'session/not-found'
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  if (code === 'session/not-found') {
    return new BridgeError(ErrorCode.SESSION_NOT_FOUND, message || '会话不存在', { cause: error });
  }
  if (code === 'session/agent-busy') {
    return new BridgeError(ErrorCode.CONFLICT, message || '会话正忙（Agent 正在运行）', { cause: error });
  }
  if (code === 'session/writer-held') {
    return new BridgeError(ErrorCode.CONFLICT, message || '会话写入被占用', { cause: error });
  }
  return new BridgeError(ErrorCode.INTERNAL_ERROR, message, { cause: error });
}

/** 标准错误体。 */
export function errorBody(error) {
  const err = asBridgeError(error);
  const body = { error: { code: err.code, message: err.message } };
  if (typeof err.retryAfter === 'number') body.error.retryAfter = err.retryAfter;
  if (err.detail !== undefined) body.error.detail = err.detail;
  return { status: err.status, body };
}

export function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** 读取 JSON 请求体，带大小上限。 */
export function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new BridgeError(ErrorCode.INVALID_PARAM, `请求体超过上限 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => fail(new BridgeError(ErrorCode.INVALID_PARAM, `读取请求体失败：${err.message}`, { cause: err })));
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new BridgeError(ErrorCode.INVALID_PARAM, '请求体必须是 JSON 对象'));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(new BridgeError(ErrorCode.INVALID_PARAM, `请求体不是合法 JSON：${err.message}`, { cause: err }));
      }
    });
  });
}

/** 参数校验小工具：必填字符串。 */
export function requireString(input, key, { maxLength = 4096 } = {}) {
  const value = input ? input[key] : undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `缺少必填参数 ${key}`);
  }
  if (value.length > maxLength) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `参数 ${key} 超过 ${maxLength} 字符`);
  }
  return value;
}

/** 参数校验小工具：可选字符串。 */
export function optionalString(input, key) {
  const value = input ? input[key] : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `参数 ${key} 必须是字符串`);
  }
  return value;
}

/** 参数校验小工具：可选布尔。 */
export function optionalBoolean(input, key) {
  const value = input ? input[key] : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `参数 ${key} 必须是布尔值`);
  }
  return value;
}

/** 参数校验小工具：可选正整数。 */
export function optionalInt(input, key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = input ? input[key] : undefined;
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < min || num > max) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `参数 ${key} 必须是 ${min}..${max} 之间的整数`);
  }
  return num;
}
