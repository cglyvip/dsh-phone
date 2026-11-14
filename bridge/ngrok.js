/**
 * dsh-phone-bridge · ngrok 托管（contract §10.1 ngrok 通道）
 *
 * 职责：
 *   1. ngrok.exe 自动引导：官方下载源 dl.ngrok.com（v3 stable windows-amd64 zip），
 *      下载后按字节数（Content-Length）校验；官方提供 .sha256 旁车（或运维通过
 *      DSH_NGROK_SHA256 提供摘要）时做 sha256 校验——校验不过绝不落盘。
 *      用户手放在 ~/.dsh/phone-bridge/ngrok/ngrok.exe 的二进制永远优先，不覆盖。
 *      （ngrok 的 stable 产物是移动目标、无官方 checksums 清单，故与 frp 的
 *      「锁定版本 + 官方 digest」策略不同：size 强制 + sha256 尽力，二者都过才落盘。）
 *   2. authtoken 落地：`ngrok config add-authtoken <token>`（官方 CLI），
 *      token 只进 transport.json（600）与内存，永不进日志/状态/健康检查。
 *   3. 隧道：`ngrok http <桥端口> --domain=<静态域名> --log=stdout --log-format=json`
 *      （官方 CLI 参数），解析 JSON 日志：started tunnel → url；err → 失败原因。
 *   4. 生命周期与 frpc 一致：随桥 dispose 回收；崩溃指数退避重启，最多 5 次。
 *
 * 安全：ngrok 透传保留原 Host（静态域名，非回环）——与 frp 同策略：
 * 仅本机路由（配对码/配对页/transport 切换）对 ngrok 来源 403，业务接口放行
 * （bridge/http.js 的 hostIsLoopback 判定天然覆盖，无需额外 Host 标记）。
 */
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAX_RESTARTS = 5;
const BACKOFF_BASE_MS = 1000;

/** 官方下载源（写死；可用环境变量覆盖以适配代理/镜像场景，仍强制校验）。 */
export const NGROK_VERSION_TAG = 'v3-stable';
export function ngrokReleaseInfo(versionTag = NGROK_VERSION_TAG) {
  const download = process.env.DSH_NGROK_URL
    || `https://dl.ngrok.com/ngrok-${versionTag}-windows-amd64.zip`;
  return {
    tag: versionTag,
    download,
    // 官方若提供 sha256 旁车则取之（无则 size 校验 + 运维显式提供摘要）
    sha256Sidecar: `${download}.sha256`,
    binaryName: 'ngrok.exe',
  };
}

/** ngrok 工作目录：$DSH_HOME/phone-bridge/ngrok。 */
export function ngrokHomeDir(home) {
  return path.join(home, 'phone-bridge', 'ngrok');
}

/**
 * 下载产物完整性校验：size 强制；sha256 在拿到官方/运维摘要时强制。
 * 校验不过绝不落盘。
 */
export function verifyNgrokAsset(buffer, expected) {
  if (!(buffer instanceof Buffer) || buffer.length === 0) {
    throw new Error('ngrok 下载失败：产物为空');
  }
  if (Number.isInteger(expected.size) && expected.size > 0 && buffer.length !== expected.size) {
    throw new Error(`ngrok 下载校验失败：字节数不符（期望 ${expected.size}，实际 ${buffer.length}）`);
  }
  const sha256 = typeof expected.sha256 === 'string' ? expected.sha256.toLowerCase() : '';
  if (sha256.length === 64) {
    const actual = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actual !== sha256) {
      throw new Error(`ngrok 下载校验失败：sha256 不符（期望 ${sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）——产物可能被篡改，已拒绝落盘`);
    }
    return 'sha256';
  }
  return 'size';
}

/**
 * 从 ngrok zip 中抽出 ngrok.exe（与 frpc 同构的最小 ZIP 读取：EOCD→中央目录→本地头）。
 * 解压后 CRC32 与尺寸校验，不过即抛错（不落盘）。
 */
export function extractNgrokFromZip(zipBytes) {
  const eocdOffset = findEocd(zipBytes);
  if (eocdOffset === null) throw new Error('ngrok 产物解析失败：不是合法 zip（找不到 EOCD）');
  const count = zipBytes.readUInt16LE(eocdOffset + 10);
  const cdSize = zipBytes.readUInt32LE(eocdOffset + 12);
  const cdOffsetField = zipBytes.readUInt32LE(eocdOffset + 16);
  const commentLen = zipBytes.readUInt16LE(eocdOffset + 20);
  const prefixSize = eocdOffset - 22 - commentLen - cdSize - cdOffsetField;
  const cdOffset = prefixSize > 0 ? cdOffsetField + prefixSize : cdOffsetField;
  if (cdOffset < 0 || cdOffset + cdSize > zipBytes.length) {
    throw new Error('ngrok 产物解析失败：中央目录越界（zip 结构损坏）');
  }

  let cursor = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > zipBytes.length || zipBytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('ngrok 产物解析失败：中央目录损坏');
    }
    const method = zipBytes.readUInt16LE(cursor + 10);
    const crc32 = zipBytes.readUInt32LE(cursor + 16);
    const compressedSize = zipBytes.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBytes.readUInt32LE(cursor + 24);
    const nameLen = zipBytes.readUInt16LE(cursor + 28);
    const extraLen = zipBytes.readUInt16LE(cursor + 30);
    const commentLen2 = zipBytes.readUInt16LE(cursor + 32);
    const localOffset = zipBytes.readUInt32LE(cursor + 42);
    const name = zipBytes.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen2;
    if (!name.endsWith('/ngrok.exe') && name !== 'ngrok.exe') continue;
    const dataStart = localOffset + 30 + readLocalNameLen(zipBytes, localOffset) + readLocalExtraLen(zipBytes, localOffset);
    const compressed = zipBytes.slice(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : (method === 8 ? zlib.inflateRawSync(compressed) : null);
    if (data === null) throw new Error(`ngrok 产物解析失败：不支持的压缩方式 ${method}`);
    if (uncompressedSize > 0 && data.length !== uncompressedSize) {
      throw new Error(`ngrok 产物解析失败：${name} 解压后尺寸不符`);
    }
    if (crc32Of(data) !== crc32) {
      throw new Error(`ngrok 产物解析失败：${name} CRC32 校验不符——产物可能被篡改，已拒绝落盘`);
    }
    return { name, data };
  }
  throw new Error('ngrok 产物解析失败：zip 内未找到 ngrok.exe');
}

function readLocalNameLen(bytes, localOffset) {
  return bytes.readUInt16LE(localOffset + 26);
}
function readLocalExtraLen(bytes, localOffset) {
  return bytes.readUInt16LE(localOffset + 28);
}
function findEocd(bytes) {
  const maxComment = 66000;
  const start = Math.max(0, bytes.length - maxComment);
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) return i;
  }
  return null;
}
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();
function crc32Of(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * 解析 ngrok 日志行（--log=stdout --log-format=json 的 JSON 行；
 * 兼容 term 格式的 "started tunnel" 文本）。
 * @returns {{ event: 'tunnel-start'|'error'|null, url?: string, message?: string }}
 */
export function parseNgrokLine(line) {
  const text = typeof line === 'string' ? line.trim() : '';
  if (text.length === 0) return { event: null };
  if (text.startsWith('{')) {
    try {
      const record = JSON.parse(text);
      const level = typeof record.lvl === 'string' ? record.lvl : '';
      const msg = typeof record.msg === 'string' ? record.msg : '';
      const url = typeof record.url === 'string' ? record.url
        : (typeof record.uri === 'string' && record.uri.startsWith('http') ? record.uri : '');
      if (level === 'err' || level === 'error') {
        return { event: 'error', message: `${msg}${typeof record.err === 'string' ? `：${record.err}` : ''}`.trim().slice(0, 300) };
      }
      if (/started tunnel/.test(msg) && url.length > 0) {
        return { event: 'tunnel-start', url };
      }
      return { event: null };
    } catch {
      // 非 JSON 行走 term 解析
    }
  }
  const termMatch = text.match(/started tunnel[^\n]*(https?:\/\/[^\s]+)/i);
  if (termMatch !== null) return { event: 'tunnel-start', url: termMatch[1] };
  if (/\b(err|ERROR)\b/i.test(text)) return { event: 'error', message: text.slice(0, 300) };
  return { event: null };
}

/**
 * 确保 ngrok.exe 就位：用户手放的永远优先；缺失时官方源下载 → size/sha256 校验 →
 * zip 抽取落盘。校验不过绝不落盘。
 * @param {{
 *   ngrokDir: string, log?: (msg: string) => void,
 *   fetchMeta?: (url: string) => Promise<{ size: number, sha256?: string }>,
 *   fetchBuffer?: (url: string) => Promise<Buffer>,
 * }} options
 * @returns {Promise<{ exePath: string, source: 'user'|'managed', verification: string }>}
 */
export async function ensureNgrokBinary(options) {
  const ngrokDir = options.ngrokDir;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const fetchMeta = typeof options.fetchMeta === 'function' ? options.fetchMeta : defaultFetchMeta;
  const fetchBuffer = typeof options.fetchBuffer === 'function' ? options.fetchBuffer : defaultFetchBuffer;
  fs.mkdirSync(ngrokDir, { recursive: true });

  const exePath = path.join(ngrokDir, 'ngrok.exe');
  if (fs.existsSync(exePath)) {
    log('检测到用户提供的 ngrok.exe，跳过自动下载（用户手放优先，不覆盖）');
    return { exePath, source: 'user', verification: 'none' };
  }

  const info = ngrokReleaseInfo();
  log(`未找到本地 ngrok，开始从官方源下载：${info.download}`);
  const expected = await fetchMeta(info.download);
  const zipBytes = await fetchBuffer(info.download);
  const verification = verifyNgrokAsset(zipBytes, {
    size: expected.size,
    sha256: expected.sha256 ?? process.env.DSH_NGROK_SHA256 ?? '',
  });
  const extracted = extractNgrokFromZip(zipBytes);
  fs.writeFileSync(exePath, extracted.data);
  try {
    fs.chmodSync(exePath, 0o600);
  } catch {
    // Windows chmod 语义有限
  }
  log(`ngrok.exe 已就位（${info.tag}，${extracted.data.length} 字节，${verification === 'sha256' ? 'size/sha256 双校验通过' : 'size 校验通过（官方未提供 sha256 旁车，可用 DSH_NGROK_SHA256 显式提供）'}`);
  return { exePath, source: 'managed', verification };
}

async function defaultFetchMeta(url) {
  // 官方源元数据：Content-Length（强制）+ .sha256 旁车（尽力）
  let size = -1;
  try {
    const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'dsh-phone-bridge' } });
    const length = Number.parseInt(head.headers.get('content-length') ?? '', 10);
    if (Number.isInteger(length) && length > 0) size = length;
  } catch {
    // 交给下载后的实际字节数
  }
  let sha256 = '';
  try {
    const sidecar = await fetch(`${ngrokReleaseInfo().sha256Sidecar}`, { headers: { 'User-Agent': 'dsh-phone-bridge' } });
    if (sidecar.ok) {
      const text = (await sidecar.text()).trim().split(/\s+/)[0];
      if (/^[0-9a-f]{64}$/i.test(text)) sha256 = text.toLowerCase();
    }
  } catch {
    // 无旁车：size 校验兜底
  }
  return { size, ...(sha256.length > 0 ? { sha256 } : {}) };
}

async function defaultFetchBuffer(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'dsh-phone-bridge' } });
  if (!response.ok) throw new Error(`ngrok 下载失败：HTTP ${response.status}（${url}）`);
  return Buffer.from(await response.arrayBuffer());
}

/** 写 ngrok 的 authtoken（官方 CLI：ngrok config add-authtoken）。 */
function saveNgrokAuthtoken(exePath, authtoken) {
  return new Promise((resolve, reject) => {
    const child = this.spawnImpl(exePath, ['config', 'add-authtoken', authtoken], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error) => reject(error));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      // 不把 token 带进错误信息
      reject(new Error(`ngrok config add-authtoken 失败（code=${code ?? 'null'}）：${output.replace(new RegExp(escapeRegExp(authtoken), 'g'), '***').trim().slice(0, 200)}`));
    });
  });
}

function escapeRegExp(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ngrok 通道：托管 ngrok 子进程（下载校验 → add-authtoken → spawn → 崩溃重启）。
 * spawnImpl / fetchMeta / fetchBuffer 可注入（smoke-test 用 mock 进程）。
 */
export class NgrokChannel {
  /**
   * @param {{
   *   cfg: { authtoken: string, staticDomain: string },
   *   home: string, localPort: number, log: (msg: string) => void,
   *   spawnImpl?: (command: string, args: string[], options: object) => import('node:child_process').ChildProcess,
   *   fetchMeta?: (url: string) => Promise<{ size: number, sha256?: string }>,
   *   fetchBuffer?: (url: string) => Promise<Buffer>,
   *   backoffBaseMs?: number, maxRestarts?: number,
   * }} options
   */
  constructor(options) {
    this.cfg = options.cfg;
    this.home = options.home;
    this.localPort = options.localPort;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
    this.fetchMeta = options.fetchMeta;
    this.fetchBuffer = options.fetchBuffer;
    this.backoffBaseMs = Number.isInteger(options.backoffBaseMs) && options.backoffBaseMs > 0
      ? options.backoffBaseMs
      : BACKOFF_BASE_MS;
    this.maxRestarts = Number.isInteger(options.maxRestarts) && options.maxRestarts > 0
      ? options.maxRestarts
      : MAX_RESTARTS;
    this.child = null;
    this.exePath = '';
    this.stopping = false;
    this.restarts = 0;
    this.restartTimer = null;
    this.state = { status: 'starting', url: '', error: '' };
    this.binary = 'none';
    this.spawns = [];
  }

  async start() {
    if (typeof this.cfg.authtoken !== 'string' || this.cfg.authtoken.length === 0) {
      throw new Error('ngrok 通道缺少 authtoken（dashboard.ngrok.com 获取）');
    }
    if (typeof this.cfg.staticDomain !== 'string' || this.cfg.staticDomain.length === 0) {
      throw new Error('ngrok 通道缺少静态域名（免费静态域名在 dashboard.ngrok.com 的 Domains 页分配）');
    }
    const ngrokDir = ngrokHomeDir(this.home);
    const { exePath, source, verification } = await ensureNgrokBinary({
      ngrokDir,
      log: this.log,
      ...(this.fetchMeta !== undefined ? { fetchMeta: this.fetchMeta } : {}),
      ...(this.fetchBuffer !== undefined ? { fetchBuffer: this.fetchBuffer } : {}),
    });
    this.exePath = exePath;
    this.binary = source;
    this.verification = verification;
    if (this.stopping) return;

    // 官方 CLI：ngrok config add-authtoken <token>（token 不进日志）
    await saveNgrokAuthtoken.call(this, exePath, this.cfg.authtoken);
    this.log('ngrok authtoken 已写入本地配置（token 不落日志）');
    if (this.stopping) return;
    this.spawnNgrok();
  }

  spawnNgrok() {
    // 官方 CLI：ngrok http <端口> --domain=<静态域名> --log=stdout --log-format=json
    const args = [
      'http', String(this.localPort),
      `--domain=${this.cfg.staticDomain}`,
      '--log=stdout',
      '--log-format=json',
    ];
    const child = this.spawnImpl(this.exePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.state = { status: 'starting', url: this.state.url, error: '' };
    const onLine = (buffer) => {
      for (const line of buffer.toString('utf8').split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        this.handleNgrokLine(line);
      }
    };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.on('error', (error) => {
      this.state = { status: 'error', url: '', error: `ngrok 启动失败：${error instanceof Error ? error.message : String(error)}` };
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) {
        this.state = { status: 'stopped', url: '', error: '' };
        return;
      }
      this.scheduleRestart(code);
    });
  }

  handleNgrokLine(line) {
    const parsed = parseNgrokLine(line);
    if (parsed.event === 'tunnel-start') {
      this.state = { status: 'running', url: parsed.url ?? '', error: '' };
      this.log(`ngrok 通道就绪：${parsed.url}`);
      return;
    }
    if (parsed.event === 'error') {
      this.state = {
        ...this.state,
        status: this.state.status === 'running' ? 'running' : 'error',
        error: `ngrok 报错：${parsed.message ?? '未知原因'}`,
      };
    }
  }

  scheduleRestart(code) {
    if (this.restarts >= this.maxRestarts) {
      this.state = {
        status: 'error',
        url: '',
        error: `ngrok 连续崩溃 ${this.restarts} 次，已停止重试（已降级局域网）。请检查 authtoken/静态域名后重试`,
      };
      return;
    }
    this.restarts += 1;
    const delay = this.backoffBaseMs * 2 ** (this.restarts - 1);
    this.state = {
      ...this.state,
      status: 'starting',
      error: `ngrok 退出（code=${code ?? 'null'}），${Math.round(delay / 1000)} 秒后第 ${this.restarts}/${this.maxRestarts} 次重启`,
    };
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.spawnNgrok();
    }, delay);
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child !== null) {
      try {
        this.child.kill();
      } catch {
        // 已经退出
      }
      this.child = null;
    }
    this.state = { status: 'stopped', url: '', error: '' };
  }

  snapshot() {
    return { ...this.state, binary: this.binary, restarts: this.restarts };
  }
}
