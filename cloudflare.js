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
import { spawn } from 'node:child_process';

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const DEFAULT_TIMEOUT_MS = 60000;

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

  log(`正在启动 Cloudflare 隧道：${command} tunnel --http-host-header ${TUNNEL_HOST_HEADER} --url ${target}`);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [
        'tunnel',
        '--http-host-header', TUNNEL_HOST_HEADER,
        '--url', target,
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
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
    let readyTimer;

    const stop = () => {
      if (child === undefined || child.killed || child.exitCode !== null) return;
      try {
        child.kill();
      } catch { /* 已经退出 */ }
    };

    const clearTimers = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (readyTimer !== undefined) clearTimeout(readyTimer);
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
          // cloudflared 打印 URL 时隧道可能还没完全注册；再等 1.5 秒
          readyTimer = setTimeout(() => finish(url), 1500);
        }
      }
      if (url.length > 0 && output.includes('Registered tunnel connection')) {
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
          `cloudflared 在拿到公网地址前退出了（code=${code ?? 'null'}）。` +
          (detail.length > 0 ? `\n${detail}` : ''),
        );
        return;
      }
      if (url.length > 0) {
        log(`Cloudflare 隧道已退出（code=${code ?? 'null'}），下次会重新建立。`);
        onExit(code);
      }
    });

    timer = setTimeout(() => {
      const detail = tail(output);
      fail(
        `等待 Cloudflare 公网地址超时（${Math.round(timeoutMs / 1000)} 秒）。` +
        (detail.length > 0 ? `\n${detail}` : ''),
      );
    }, timeoutMs);
  });
}
