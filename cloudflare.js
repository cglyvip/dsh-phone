/**
 * dsh-phone-bridge v2 · Cloudflare Quick Tunnel 管理
 *
 * 参考 hdsh-remote-pair (MIT)：/pair 需要公网地址时临时拉起
 * `cloudflared tunnel --url http://127.0.0.1:<桥端口>`，解析出
 * `https://xxx.trycloudflare.com` 后交给配对链接与二维码使用。
 *
 * 安全（v3.1）：启动隧道时加 `--http-host-header dsh-phone-bridge-tunnel`，
 * cloudflared 会把发往源站的每个请求 Host 头改写为该标记。桥侧据此识别
 * 「隧道来源」：loopback-only 接口（/api/pairing-code、/pair）对隧道流量
 * 一律 403 —— 否则隧道流量从 127.0.0.1 连入，socket 层面无法与本机用户区分，
 * 外网用户就能自助拿配对码。本机直连/局域网的 Host 是 IP:端口，判别 100% 可靠。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 锁定的 cloudflared 版本（环境变量 DSH_CLOUDFLARED_VERSION 可覆盖）。 */
export const CLOUDFLARED_VERSION = process.env.DSH_CLOUDFLARED_VERSION || '2026.11.1';

export const CLOUDFLARED_REPO = 'Cloudflare/cloudflared';

/** 官方 release 的裸 exe 资产与 API 地址（Windows 版不是 zip，直接是 exe）。 */
export function cloudflaredReleaseInfo(version = CLOUDFLARED_VERSION) {
  const tag = version; // 官方 tag 形如 2026.11.1（无 v 前缀）
  const asset = 'cloudflared-windows-amd64.exe';
  return {
    tag,
    asset,
    api: `https://api.github.com/repos/${CLOUDFLARED_REPO}/releases/tags/${tag}`,
    download: `https://github.com/${CLOUDFLARED_REPO}/releases/download/${tag}/${asset}`,
    binaryName: 'cloudflared.exe',
  };
}

/** cloudflared 托管目录：$DSH_HOME/phone-bridge/cloudflared。 */
export function cloudflaredHomeDir(home) {
  return path.join(home, 'phone-bridge', 'cloudflared');
}

/** PATH 中查找 cloudflared（用户装过 winget/scoop 的优先 PATH）。 */
export function findCloudflaredOnPath(environment = process.env) {
  const rawPath = typeof environment.PATH === 'string' ? environment.PATH : '';
  if (rawPath.length === 0) return '';
  const names = process.platform === 'win32' ? ['cloudflared.exe', 'cloudflared'] : ['cloudflared', 'cloudflared.exe'];
  for (const directory of rawPath.split(path.delimiter)) {
    const cleanDirectory = directory.trim().replace(/^"|"$/g, '');
    if (cleanDirectory.length === 0) continue;
    for (const name of names) {
      const candidate = path.join(cleanDirectory, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return '';
}

/**
 * 确保 cloudflared 二进制就位（对齐 frpc/ngrok 托管策略）：
 *   1. 配置的 cloudflaredPath 优先（用户显式指定，存在即用）；
 *   2. 用户手放 ~/.dsh/phone-bridge/cloudflared/cloudflared.exe 次之，不覆盖；
 *   3. PATH 中的 cloudflared 再次（winget 安装场景）；
 *   4. 都没有 → 官方 GitHub release 下载（size + sha256 双校验，校验不过绝不落盘）。
 * @returns {Promise<{ exePath: string, source: 'configured'|'user'|'path'|'managed' }>}
 */
export async function ensureCloudflaredBinary(options) {
  const dir = options.dir;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const fetchJson = typeof options.fetchJson === 'function' ? options.fetchJson : defaultFetchJson;
  const fetchBuffer = typeof options.fetchBuffer === 'function' ? options.fetchBuffer : defaultFetchBuffer;
  fs.mkdirSync(dir, { recursive: true });

  const configuredPath = typeof options.executablePath === 'string' ? options.executablePath.trim() : '';
  if (configuredPath.length > 0 && configuredPath !== 'cloudflared') {
    const absolutePath = path.resolve(configuredPath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`配置的 cloudflaredPath 不存在或不是文件：${absolutePath}`);
    }
    log(`使用配置的官方 cloudflared：${absolutePath}`);
    return { exePath: absolutePath, source: 'configured' };
  }

  const exePath = path.join(dir, 'cloudflared.exe');
  if (fs.existsSync(exePath)) {
    log('检测到用户提供的 cloudflared.exe，跳过自动下载（用户手放优先，不覆盖）');
    return { exePath, source: 'user' };
  }

  const pathExecutable = findCloudflaredOnPath();
  if (pathExecutable.length > 0) {
    log(`使用 PATH 中的 cloudflared：${pathExecutable}`);
    return { exePath: pathExecutable, source: 'path' };
  }

  const info = cloudflaredReleaseInfo();
  log(`未找到本地 cloudflared，开始从官方 release 下载：${info.download}`);
  const release = await fetchJson(info.api);
  const assets = release !== null && typeof release === 'object' && Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((item) => item !== null && typeof item === 'object' && item.name === info.asset);
  if (asset === undefined) {
    throw new Error(`cloudflared release 未找到 ${info.asset}；请手动安装（winget install Cloudflare.cloudflared）或把 cloudflared.exe 放到 ${dir}`);
  }
  // 官方 release 资产不带独立 checksums 文件：size 强制 + sha256 尽力（assets.digest）
  const expected = {
    size: Number.isInteger(asset.size) ? asset.size : -1,
    sha256: typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : '',
  };
  const bytes = await fetchBuffer(asset.browser_download_url);
  if (!(bytes instanceof Buffer) || bytes.length === 0) {
    throw new Error('cloudflared 下载失败：产物为空');
  }
  if (Number.isInteger(expected.size) && expected.size > 0 && bytes.length !== expected.size) {
    throw new Error(`cloudflared 下载校验失败：字节数不符（期望 ${expected.size}，实际 ${bytes.length}）`);
  }
  if (expected.sha256.length === 64) {
    const { createHash } = await import('node:crypto');
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected.sha256) {
      throw new Error('cloudflared 下载校验失败：sha256 不符——产物可能被篡改，已拒绝落盘');
    }
  }
  fs.writeFileSync(exePath, bytes);
  log(`cloudflared.exe 已就位（官方 ${info.tag}，${bytes.length} 字节，校验通过）`);
  return { exePath, source: 'managed' };
}

async function defaultFetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-phone-bridge' } });
  if (!response.ok) throw new Error(`cloudflared release 元数据获取失败：HTTP ${response.status}（${url}）`);
  return response.json();
}

async function defaultFetchBuffer(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'dsh-phone-bridge' } });
  if (!response.ok) throw new Error(`cloudflared 下载失败：HTTP ${response.status}（${url}）`);
  return Buffer.from(await response.arrayBuffer());
}

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const DEFAULT_TIMEOUT_MS = 60000;

export function normalizeCloudflaredProtocol(value) {
  if (value === undefined) return 'auto';
  if (typeof value !== 'string' || !['auto', 'http2', 'quic'].includes(value.trim())) {
    throw new Error('cloudflaredProtocol 必须是 auto / http2 / quic');
  }
  return value.trim();
}

export function normalizeCloudflaredDnsResolvers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(resolver => typeof resolver !== 'string')) {
    throw new Error('cloudflaredDnsResolvers 必须是 DNS address:port 字符串数组');
  }
  return value.map(resolver => resolver.trim()).filter(resolver => resolver.length > 0);
}

/** 隧道流量的 Host 头标记（bridge/http.js 的 isTunnelRequest 用同一常量值）。 */
export const TUNNEL_HOST_HEADER = 'dsh-phone-bridge-tunnel';

function tail(text, max = 1600) {
  const value = String(text ?? '').trim();
  return value.length > max ? value.slice(value.length - max) : value;
}

/**
 * 启动一条 Quick Tunnel。
 * @returns {Promise<{url: string, target: string, stop: () => void}>}
 */
export function startQuickTunnel(options) {
  const bridgePort = Number(options?.bridgePort);
  if (!Number.isInteger(bridgePort) || bridgePort <= 0) {
    return Promise.reject(new Error('Cloudflare 隧道：桥端口无效'));
  }
  const targetHost = typeof options.targetHost === 'string' && options.targetHost.length > 0
    ? options.targetHost
    : '127.0.0.1';
  // 防御：调用方若误传带协议头的地址（如 http://127.0.0.1），剥掉 scheme 再包 IPv6 括号
  const cleanHost = targetHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const displayHost = cleanHost.includes(':') ? `[${cleanHost}]` : cleanHost;
  const target = `http://${displayHost}:${bridgePort}`;
  const command = typeof options.command === 'string' && options.command.trim().length > 0
    ? options.command.trim()
    : 'cloudflared';
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const onExit = typeof options.onExit === 'function' ? options.onExit : () => {};
  const protocol = normalizeCloudflaredProtocol(options.protocol);
  const dnsResolvers = normalizeCloudflaredDnsResolvers(options.dnsResolvers);
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const environment = { ...process.env };
  if (dnsResolvers.length > 0) {
    environment.TUNNEL_DNS_RESOLVER_ADDRS = dnsResolvers.join(',');
  }

  log(`正在启动 Cloudflare 隧道：${command} tunnel --protocol ${protocol} --http-host-header ${TUNNEL_HOST_HEADER} --url ${target}`);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, [
        'tunnel',
        '--protocol', protocol,
        '--http-host-header', TUNNEL_HOST_HEADER,
        '--url', target,
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: environment,
      });
    } catch (error) {
      reject(new Error(
        `无法启动 cloudflared：${error?.message ?? String(error)}。` +
        '请安装 cloudflared 并加入 PATH，或在配置里设置 cloudflaredPath。',
      ));
      return;
    }

    let settled = false;
    let output = '';
    let url = '';
    let timer;
    let registered = false;

    const stop = () => {
      if (child === undefined || child.killed || child.exitCode !== null) return;
      try {
        child.kill();
      } catch { /* 已经退出 */ }
    };

    const clearTimers = () => {
      if (timer !== undefined) clearTimeout(timer);
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimers();
      stop();
      reject(new Error(message));
    };

    const finish = (found) => {
      if (settled) return;
      settled = true;
      url = found;
      clearTimers();
      resolve({ url, target, stop });
    };

    const consume = (chunk) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-8000);
      if (url.length === 0) {
        const found = output.match(URL_PATTERN);
        if (found !== null && found.length > 0) {
          url = found[0].replace(/\/+$/, '');
        }
      }
      if (output.includes('Registered tunnel connection')) registered = true;
      if (url.length > 0 && registered) {
        finish(url);
      }
    };

    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);

    child.on('error', (error) => {
      const hint = error?.code === 'ENOENT'
        ? '找不到 cloudflared。请先安装（winget install Cloudflare.cloudflared）并加入 PATH，或在配置里设置 cloudflaredPath。'
        : `cloudflared 启动失败：${error?.message ?? String(error)}`;
      fail(hint);
    });

    child.on('exit', (code) => {
      if (!settled) {
        const detail = tail(output);
        fail(
          `cloudflared 在完成公网连接注册前退出了（code=${code ?? 'null'}）。` +
          (detail.length > 0 ? `\n${detail}` : ''),
        );
        return;
      }
      if (url.length > 0) {
        log(`Cloudflare 隧道已退出（code=${code ?? 'null'}），下次会重新建立。`);
        onExit(code, tail(output));
      }
    });

    timer = setTimeout(() => {
      const detail = tail(output);
      fail(
        `等待 Cloudflare 公网连接注册超时（${Math.round(timeoutMs / 1000)} 秒）。` +
        (detail.length > 0 ? `\n${detail}` : ''),
      );
    }, timeoutMs);
  });
}
