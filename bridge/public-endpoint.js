import { MIN_CONTRACT_VERSION, PROTOCOL } from '../shared/version.js';

const MAX_HEALTH_BYTES = 1024 * 1024;

export function parsePublicUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!/^(?:https?|tcp):\/\/[^/?#@\s\\]+\/?$/i.test(text)) return null;
  let address;
  try {
    address = new URL(text);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'tcp:'].includes(address.protocol)
    || address.hostname.length === 0 || address.username.length > 0 || address.password.length > 0
    || !['', '/'].includes(address.pathname) || address.port === '0') {
    return null;
  }
  if (address.protocol === 'tcp:') {
    if (address.port.length === 0) return null;
    address = new URL(`http://${address.host}`);
  }
  return address.origin;
}

async function readHealthBody(response) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_HEALTH_BYTES) {
    if (response.body !== null) await response.body.cancel();
    throw new Error('健康检查响应超过 1 MiB，目标不是有效的手机桥接口');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let byteCount = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      byteCount += result.value.byteLength;
      if (byteCount > MAX_HEALTH_BYTES) {
        await reader.cancel();
        throw new Error('健康检查响应超过 1 MiB，目标不是有效的手机桥接口');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteCount).toString('utf8');
}

export async function probePublicUrl(input, options = {}) {
  const startedAt = Date.now();
  const address = parsePublicUrl(input);
  const latencyMs = () => Date.now() - startedAt;
  if (address === null) {
    return {
      ok: false, status: 0, latencyMs: latencyMs(),
      error: '地址格式无效：填写 http(s)://域名[:端口] 或 tcp://域名:端口，不要附带路径、账号、查询参数或片段',
    };
  }
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 3000;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  let responseStatus = 0;
  try {
    const response = await fetchImpl(`${address}/api/health`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'dsh-phone-bridge-probe', 'ngrok-skip-browser-warning': '1' },
    });
    responseStatus = response.status;
    if (response.status < 200 || response.status >= 300) {
      if (response.body !== null) await response.body.cancel();
      return {
        ok: false, status: response.status, latencyMs: latencyMs(),
        error: response.status >= 300 && response.status < 400
          ? `目标返回 HTTP ${response.status} 重定向，请填写直接访问手机桥的公网地址`
          : `目标返回 HTTP ${response.status}，请确认穿透服务已连接并映射到手机桥端口`,
      };
    }
    const text = await readHealthBody(response);
    let health;
    try {
      health = JSON.parse(text);
    } catch {
      return {
        ok: false, status: response.status, latencyMs: latencyMs(),
        error: '公网地址返回的不是手机桥 JSON，可能是服务商验证页、广告页或其他网站',
      };
    }
    if (health === null || typeof health !== 'object' || Array.isArray(health)
      || health.status !== 'ok' || (health.plugin !== PROTOCOL && health.protocol !== PROTOCOL)) {
      return {
        ok: false, status: response.status, latencyMs: latencyMs(),
        error: '公网地址未返回 dsh-phone-bridge 身份，请将服务商的本机目标改为当前手机桥端口',
      };
    }
    if (!Number.isInteger(health.contractVersion) || health.contractVersion < MIN_CONTRACT_VERSION) {
      return {
        ok: false, status: response.status, latencyMs: latencyMs(),
        error: `手机桥协议版本不兼容，需要 contractVersion >= ${MIN_CONTRACT_VERSION}`,
      };
    }
    const hostname = new URL(address).hostname;
    const localEndpoint = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    if (!localEndpoint) {
      const privateResponse = await fetchImpl(`${address}/api/pairing-code`, {
        method: 'GET', cache: 'no-store', redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'dsh-phone-bridge-probe', 'ngrok-skip-browser-warning': '1' },
      });
      if (privateResponse.body !== null) await privateResponse.body.cancel();
      if (privateResponse.status !== 403) {
        return {
          ok: false, status: response.status, latencyMs: latencyMs(),
          error: '该穿透配置未隔离电脑配对码接口，请关闭服务商的本机 Host 重写，并保留公网 Host 后重试',
        };
      }
    }
    return {
      ok: true, status: response.status, latencyMs: latencyMs(),
      contractVersion: health.contractVersion,
      ...(typeof health.bridgeVersion === 'string' ? { bridgeVersion: health.bridgeVersion } : {}),
    };
  } catch (error) {
    return {
      ok: false, status: responseStatus, latencyMs: latencyMs(),
      error: error instanceof Error
        ? (error.name === 'TimeoutError' || error.name === 'AbortError' ? `探活超时（${timeoutMs}ms）` : error.message)
        : String(error),
    };
  }
}
