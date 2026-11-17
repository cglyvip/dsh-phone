/**
 * dsh-phone-bridge · frpc 托管（contract §10 frp 通道）
 *
 * 职责：
 *   1. frpc.toml 生成（官方 frp v0.5x TOML 语法：serverAddr/serverPort/auth.token/
 *      transport.tls.enable/[[proxies]]，tcp 透传到本机桥端口）
 *   2. frpc.exe 自动引导：写死官方 GitHub releases（fatedier/frp），下载后做
 *      size + sha256 双校验（元数据取自 GitHub release assets API），再从 zip
 *      里抽出 frpc.exe（含 CRC32 校验），校验不过绝不落盘；
 *      用户手放在 ~/.dsh/phone-bridge/frpc/frpc.exe 的二进制永远优先，不覆盖。
 *   3. frpc 输出解析：登录成功 / 代理成功 / frps 分配的远程端口（remotePort=0 时
 *      回填 publicUrl=vps:port）/ 登录失败原因。
 *
 * frp 参数均为官方文档常识键名，不臆造：
 *   serverAddr / serverPort / auth.method="token" / auth.token /
 *   transport.tls.enable / [[proxies]] type="tcp" localIP localPort remotePort
 *
 * token 只写入 frpc.toml（权限 600）与内存；永不进日志 / 状态 / 健康检查。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** 锁定的 frp 版本（可用环境变量 DSH_FRP_VERSION 覆盖，便于运维升级）。 */
export const FRP_VERSION = process.env.DSH_FRP_VERSION || '0.61.1';

export const FRP_REPO = 'fatedier/frp';

/** 官方 release 的 zip 资产名与 API 地址（写死官方源，不做镜像回退）。 */
export function frpReleaseInfo(version = FRP_VERSION) {
  const tag = `v${version}`;
  const asset = `frp_${version}_windows_amd64.zip`;
  return {
    tag,
    asset,
    api: `https://api.github.com/repos/${FRP_REPO}/releases/tags/${tag}`,
    download: `https://github.com/${FRP_REPO}/releases/download/${tag}/${asset}`,
    binaryName: 'frpc.exe',
  };
}

/** frps 上代理名的统一前缀（便于在 frps 日志里认出本插件）。 */
export const PROXY_NAME_PREFIX = 'dsh-phone-bridge';

/**
 * 生成这台电脑专用的 frp 代理名。
 *
 * frps 上同一个代理名只允许一个连接占用。早期版本把名字写死成
 * `dsh-phone-bridge`，于是**同一台 frps 上的第二台电脑必然注册失败**
 * （`start error: proxy [dsh-phone-bridge] already exists`），
 * 表现为配对页一直「正在启动」、手机端请求超时。
 *
 * 现在按主机名 + 主机名/平台哈希生成唯一名：不同电脑互不干扰，
 * 同一台电脑重启后名字稳定（不会每次都占一个新名字）。
 * 手机连的是 `VPS:remotePort`，与代理名无关，改名不影响已有配对。
 *
 * @param {string} [hostname] 可注入（测试用），默认取本机主机名
 * @param {string} [platform] 可注入（测试用），默认取本机平台
 * @returns {string} 形如 `dsh-phone-bridge-desktop-a1b2c3d4`
 */
export function defaultProxyName(hostname, platform) {
  const rawHost = typeof hostname === 'string' && hostname.length > 0
    ? hostname
    : os.hostname();
  const rawPlatform = typeof platform === 'string' && platform.length > 0
    ? platform
    : os.platform();
  // 代理名只保留字母数字与连字符：主机名里的空格、下划线、中文都要清掉
  const slug = rawHost.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  const digest = crypto.createHash('sha256').update(`${rawHost}|${rawPlatform}`).digest('hex').slice(0, 8);
  return `${PROXY_NAME_PREFIX}-${slug.length > 0 ? slug : 'pc'}-${digest}`;
}

/**
 * 生成 frpc.toml 内容。
 * @param {{
 *   serverAddr: string, serverPort: number, token: string,
 *   remotePort: number, useTls: boolean, localPort: number,
 *   proxyName?: string,
 * }} cfg frp 通道配置（token 必填——公网暴露必须鉴权）
 * @returns {{ toml: string, proxyName: string }}
 */
export function buildFrpcConfig(cfg) {
  const serverAddr = typeof cfg.serverAddr === 'string' ? cfg.serverAddr.trim() : '';
  const serverPort = Number.isInteger(cfg.serverPort) ? cfg.serverPort : 7000;
  const token = typeof cfg.token === 'string' ? cfg.token : '';
  const remotePort = Number.isInteger(cfg.remotePort) ? cfg.remotePort : 0;
  const useTls = cfg.useTls === true;
  const localPort = Number.isInteger(cfg.localPort) ? cfg.localPort : 0;
  // 默认按本机唯一化，避免同一台 frps 上的多台电脑撞名
  const proxyName = typeof cfg.proxyName === 'string' && cfg.proxyName.trim().length > 0
    ? cfg.proxyName.trim()
    : defaultProxyName();

  if (serverAddr.length === 0) {
    throw new Error('frp 通道缺少 serverAddr（VPS 地址）');
  }
  if (token.length === 0) {
    throw new Error('frp 通道缺少 token（frps auth.token）——公网暴露必须鉴权');
  }
  if (localPort <= 0) {
    throw new Error('frp 通道缺少本机桥端口');
  }

  const lines = [
    '# 本文件由 dsh-phone-bridge 在每次启动 frpc 时自动重写；包含 frps token，请勿外传',
    `serverAddr = "${serverAddr}"`,
    `serverPort = ${serverPort}`,
    'auth.method = "token"',
    `auth.token = "${token.replaceAll('"', '\\"')}"`,
    `transport.tls.enable = ${useTls ? 'true' : 'false'}`,
    '',
    '[[proxies]]',
    `name = "${proxyName}"`,
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${localPort}`,
  ];
  // remotePort = 0 → 由 frps 动态分配（省略该键），桥从 frpc 输出回填 publicUrl
  if (remotePort > 0) {
    lines.push(`remotePort = ${remotePort}`);
  }
  return { toml: `${lines.join('\n')}\n`, proxyName };
}

/**
 * 下载产物完整性校验：size + sha256 双校验，任一不匹配即拒绝（绝不落盘）。
 * @param {Buffer} buffer 下载到的字节
 * @param {{ size: number, sha256: string }} expected 期望值（来自 GitHub release assets 元数据）
 */
export function verifyReleaseAsset(buffer, expected) {
  if (!(buffer instanceof Buffer) || buffer.length === 0) {
    throw new Error('frp 下载失败：产物为空');
  }
  if (Number.isInteger(expected.size) && expected.size > 0 && buffer.length !== expected.size) {
    throw new Error(`frp 下载校验失败：字节数不符（期望 ${expected.size}，实际 ${buffer.length}）`);
  }
  const sha256 = typeof expected.sha256 === 'string' ? expected.sha256.toLowerCase() : '';
  if (sha256.length === 64) {
    const actual = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actual !== sha256) {
      throw new Error(`frp 下载校验失败：sha256 不符（期望 ${sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）——产物可能被篡改，已拒绝落盘`);
    }
  } else {
    throw new Error('frp 下载校验失败：缺少官方 sha256 元数据，拒绝落盘');
  }
}

/**
 * 从 frp release zip 中抽出 frpc.exe（最小 ZIP 读取器：中央目录 → 本地头 → 解压）。
 * 解压后做 CRC32 与尺寸校验，不过即抛错（不落盘）。
 * @param {Buffer} zipBytes 已通过 size/sha256 校验的 zip 字节
 * @returns {{ name: string, data: Buffer }}
 */
export function extractFrpcFromZip(zipBytes) {
  const eocd = findEocd(zipBytes);
  if (eocd === null) throw new Error('frp 产物解析失败：不是合法 zip（找不到 EOCD）');
  const eocdOffset = eocd.offset;
  const count = zipBytes.readUInt16LE(eocdOffset + 10);
  const cdSize = zipBytes.readUInt32LE(eocdOffset + 12);
  const cdOffsetField = zipBytes.readUInt32LE(eocdOffset + 16);
  const commentLen = zipBytes.readUInt16LE(eocdOffset + 20);
  // 前缀兼容（zip 被拼在自解压/签名数据后面时）：前缀长度 = eocd 位置 - 22 - 注释 - 目录尺寸 - 目录偏移字段
  const prefixSize = eocdOffset - 22 - commentLen - cdSize - cdOffsetField;
  const cdOffset = prefixSize > 0 ? cdOffsetField + prefixSize : cdOffsetField;
  if (cdOffset < 0 || cdOffset + cdSize > zipBytes.length) {
    throw new Error('frp 产物解析失败：中央目录越界（zip 结构损坏）');
  }

  let cursor = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > zipBytes.length || zipBytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('frp 产物解析失败：中央目录损坏');
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
    if (!name.endsWith('/frpc.exe') && name !== 'frpc.exe') continue;
    return extractEntry(zipBytes, localOffset, name, method, crc32, compressedSize, uncompressedSize);
  }
  throw new Error('frp 产物解析失败：zip 内未找到 frpc.exe');
}

function findEocd(bytes) {
  const minEocd = 22;
  const maxComment = 66000;
  const start = Math.max(0, bytes.length - maxComment);
  for (let i = bytes.length - minEocd; i >= start; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) return { offset: i };
  }
  return null;
}

function extractEntry(bytes, localOffset, name, method, expectedCrc, compressedSize, uncompressedSize) {
  if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('frp 产物解析失败：本地文件头损坏');
  const nameLen = bytes.readUInt16LE(localOffset + 26);
  const extraLen = bytes.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  let compressed = bytes.slice(dataStart, dataStart + compressedSize);
  let data;
  if (method === 0) {
    data = compressed;
  } else if (method === 8) {
    data = zlib.inflateRawSync(compressed);
  } else {
    throw new Error(`frp 产物解析失败：不支持的压缩方式 ${method}`);
  }
  if (uncompressedSize > 0 && data.length !== uncompressedSize) {
    throw new Error(`frp 产物解析失败：${name} 解压后尺寸不符`);
  }
  if (crc32Of(data) !== expectedCrc) {
    throw new Error(`frp 产物解析失败：${name} CRC32 校验不符——产物可能被篡改，已拒绝落盘`);
  }
  return { name, data };
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
 * 解析 frpc 输出：登录成功 / 代理成功 / frps 分配的远程端口 / 失败原因。
 * frpc 默认日志到 stdout，逐行喂给本函数。
 * @returns {{ event: 'login'|'proxy-start'|'proxy-fail'|'login-fail'|null, remotePort?: number, message?: string }}
 */
export function parseFrpcLine(line) {
  const text = typeof line === 'string' ? line : '';
  if (/login to server failed/i.test(text)) {
    return { event: 'login-fail', message: text.trim().slice(0, 300) };
  }
  if (/start proxy success/i.test(text)) {
    const port = extractRemotePort(text);
    return { event: 'proxy-start', ...(port !== null ? { remotePort: port } : {}) };
  }
  if (/start proxy fail/i.test(text)) {
    return { event: 'proxy-fail', message: text.trim().slice(0, 300) };
  }
  // frpc 0.6x 起，「代理注册失败」不再走 start proxy fail，而是单独一行
  // `[name] start error: proxy [name] already exists`（同名代理已被别的 frpc 占用）
  // 或 `[name] start error: port already used`（远程端口被占）。
  // 这类行以前被当成无关日志丢弃，桥会永远停在「正在启动」，配对页看不到任何原因。
  // 只取冒号后的内容作为原因：前面的时间戳与 run id 会把界面上的关键信息挤掉。
  if (/start error/i.test(text)) {
    const marker = text.search(/start error/i);
    const detail = text.slice(marker + 'start error'.length).replace(/^\s*[:：]?\s*/, '').trim();
    return { event: 'proxy-fail', message: (detail.length > 0 ? detail : text.trim()).slice(0, 300) };
  }
  if (/login to server success/i.test(text)) {
    return { event: 'login' };
  }
  return { event: null };
}

/**
 * 从一行 frpc 输出里抽 frps 分配的远程端口（remotePort=0 时）。
 * 兼容常见日志形态：remoteAddr=1.2.3.4:34567 / remote addr: 1.2.3.4:34567 /
 * remotePort=34567 / [vps:34567]。
 */
export function extractRemotePort(line) {
  const text = typeof line === 'string' ? line : '';
  const patterns = [
    /remoteAddr\s*=\s*[\w.\-]+:(\d{2,5})/i,
    /remote\s+addr(?:ess)?\s*[=:]\s*[\w.\-]+:(\d{2,5})/i,
    /remotePort\s*[=:]\s*(\d{2,5})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match !== null) {
      const port = Number.parseInt(match[1], 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    }
  }
  return null;
}

/**
 * 确保 frpc 二进制就位：用户手放的永远优先（存在即用，不覆盖）；
 * 缺失时从官方 GitHub releases 下载 → size/sha256 双校验 → 抽 frpc.exe 落盘。
 * @param {{
 *   frpcDir: string, log?: (msg: string) => void,
 *   fetchJson?: (url: string) => Promise<any>,
 *   fetchBuffer?: (url: string) => Promise<Buffer>,
 * }} options
 * @returns {Promise<{ exePath: string, source: 'user'|'managed' }>}
 */
export async function ensureFrpcBinary(options) {
  const frpcDir = options.frpcDir;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const fetchJson = typeof options.fetchJson === 'function' ? options.fetchJson : defaultFetchJson;
  const fetchBuffer = typeof options.fetchBuffer === 'function' ? options.fetchBuffer : defaultFetchBuffer;
  fs.mkdirSync(frpcDir, { recursive: true });

  const exePath = path.join(frpcDir, 'frpc.exe');
  if (fs.existsSync(exePath)) {
    log('检测到用户提供的 frpc.exe，跳过自动下载（用户手放优先，不覆盖）');
    return { exePath, source: 'user' };
  }

  const info = frpReleaseInfo();
  log(`未找到本地 frpc，开始从官方 release 下载：${info.download}`);
  const release = await fetchJson(info.api);
  const assets = release !== null && typeof release === 'object' && Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((item) => item !== null && typeof item === 'object' && item.name === info.asset);
  if (asset === undefined) {
    throw new Error(`frp release 未找到 ${info.asset}；请手动放置 frpc.exe 到 ${frpcDir}`);
  }
  const expected = {
    size: Number.isInteger(asset.size) ? asset.size : -1,
    sha256: typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : '',
  };
  if (expected.sha256.length === 0) {
    // GitHub 资产元数据缺 digest 时，退回 release 自带的 checksums 文件（同为官方产物）
    const checksumAsset = assets.find((item) => item !== null && typeof item === 'object'
      && typeof item.name === 'string' && /sha256_checksums\.txt$/.test(item.name));
    if (checksumAsset === undefined) {
      throw new Error('frp 下载校验失败：拿不到官方 sha256 元数据（assets.digest 与 checksums 文件均缺失），拒绝落盘');
    }
    const checksums = await (typeof fetchBuffer === 'function' ? fetchBuffer(checksumAsset.browser_download_url) : defaultFetchBuffer(checksumAsset.browser_download_url));
    const line = checksums.toString('utf8').split('\n').find((row) => row.trimEnd().endsWith(info.asset));
    if (line === undefined) {
      throw new Error('frp 下载校验失败：checksums 文件里没有该产物的条目，拒绝落盘');
    }
    expected.sha256 = line.trim().split(/\s+/)[0].toLowerCase();
  }

  const zipBytes = await fetchBuffer(asset.browser_download_url);
  verifyReleaseAsset(zipBytes, expected);
  const extracted = extractFrpcFromZip(zipBytes);
  fs.writeFileSync(exePath, extracted.data);
  try {
    fs.chmodSync(exePath, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，忽略
  }
  log(`frpc.exe 已就位（官方 ${info.tag}，${extracted.data.length} 字节，已通过 size/sha256 双校验）`);
  return { exePath, source: 'managed' };
}

async function defaultFetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-phone-bridge' } });
  if (!response.ok) throw new Error(`frp release 元数据获取失败：HTTP ${response.status}（${url}）`);
  return response.json();
}

async function defaultFetchBuffer(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'dsh-phone-bridge' } });
  if (!response.ok) throw new Error(`frp 产物下载失败：HTTP ${response.status}（${url}）`);
  return Buffer.from(await response.arrayBuffer());
}

/** frpc 工作目录：$DSH_HOME/phone-bridge/frpc。 */
export function frpcHomeDir(home) {
  return path.join(home, 'phone-bridge', 'frpc');
}

/**
 * 清理上一次运行遗留的 frpc 进程。
 *
 * DSH 被强杀、崩溃或托盘未正常退出时，Windows 上已经 spawn 的 frpc.exe 不会跟着退出。
 * 它会继续连着 frps、占着代理名和 remotePort——新启动的 frpc 于是报
 * `proxy [...] already exists`，而用户根本没开别的电脑，很难想到是本地残留进程。
 *
 * 只杀**可执行文件路径与本机托管的那份 frpc.exe 完全相同**的进程，
 * 不会碰到用户自己另外跑的 frpc。找不到进程或命令失败都静默跳过：
 * 清理是尽力而为，不能因为它挡住正常启动。
 *
 * @param {string} exePath 本机托管 frpc.exe 的绝对路径
 * @param {{ execImpl?: Function, log?: (msg: string) => void }} [options]
 * @returns {number} 被杀掉的进程数（拿不到结果时为 0）
 */
export function killOrphanFrpc(exePath, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const execImpl = typeof options.execImpl === 'function' ? options.execImpl : execFileSync;
  if (typeof exePath !== 'string' || exePath.length === 0) return 0;

  let killed = 0;
  try {
    if (process.platform === 'win32') {
      // 用环境变量传路径，避免把反斜杠/引号拼进 PowerShell 命令里出错
      // 两侧都必须先规范化：Win32_Process 返回的是反斜杠路径，而调用方可能传正斜杠
      const script = [
        "$target = [System.IO.Path]::GetFullPath($env:DSH_FRPC_TARGET)",
        "$procs = Get-CimInstance Win32_Process -Filter \"Name='frpc.exe'\" -ErrorAction SilentlyContinue",
        "$hit = @($procs | Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -eq $target) })",
        "foreach ($p in $hit) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }",
        "$hit.Count",
      ].join('; ');
      const output = execImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, DSH_FRPC_TARGET: exePath }, encoding: 'utf8', timeout: 15000, windowsHide: true },
      );
      killed = Number.parseInt(String(output).trim(), 10);
      if (!Number.isInteger(killed) || killed < 0) killed = 0;
    } else {
      // 非 Windows：按命令行精确匹配可执行文件路径
      execImpl('pkill', ['-f', `^${exePath}( |$)`], { timeout: 15000 });
      killed = 1;
    }
  } catch {
    // pkill 没有匹配到进程会返回非 0；PowerShell 查询失败也一样——都不影响启动
    return 0;
  }
  if (killed > 0) log(`已清理上一次遗留的 frpc 进程（${killed} 个），避免代理名被继续占用`);
  return killed;
}

/** 写 frpc.toml（同目录、权限 600）。 */
export function writeFrpcConfig(frpcDir, toml) {
  fs.mkdirSync(frpcDir, { recursive: true });
  const configPath = path.join(frpcDir, 'frpc.toml');
  fs.writeFileSync(configPath, toml, 'utf8');
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Windows 上 chmod 语义有限
  }
  return configPath;
}
