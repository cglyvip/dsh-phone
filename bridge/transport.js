/**
 * dsh-phone-bridge · 公网通道统一状态机（contract §10，v3.2）
 *
 * 5 种 tunnelMode：quick | named | frp | relay | off
 *   - quick：Cloudflare Quick Tunnel（cloudflared，bridge/cloudflare.js）
 *   - named：用户在 CF 后台配好的固定域名，桥只透传 publicUrl（不建隧道进程）
 *   - frp：  自有 VPS + frpc（bridge/frpc.js 托管下载/校验/生成配置/spawn）
 *   - relay：订阅中转（v3.2 仅占位与状态展示，连接逻辑下一阶段）
 *   - off：  不建通道，仅局域网（LAN 永远可用，任何通道失败都降级到它）
 *
 * 语义：
 *   - switchMode = 停旧起新；当前通道进程随 dispose 全部回收
 *   - frpc 崩溃自动重启：指数退避（1s/2s/4s/8s/16s），最多 5 次，超过即报错降级 LAN
 *   - 状态（mode/url/error/status/channels）全部进 /api/health 与配对页
 *
 * 依赖注入（spawn/fetch/timer/quickStarter）全部可替换，smoke-test 用 mock 进程覆盖。
 */
import { spawn } from 'node:child_process';
import { startQuickTunnel } from '../cloudflare.js';
import {
  buildFrpcConfig,
  ensureFrpcBinary,
  frpcHomeDir,
  parseFrpcLine,
  writeFrpcConfig,
} from './frpc.js';
import { NgrokChannel, ensureNgrokBinary, ngrokHomeDir } from './ngrok.js';

export const TUNNEL_MODES = ['quick', 'named', 'frp', 'custom', 'ngrok', 'relay', 'off'];

const MAX_FRP_RESTARTS = 5;
const FRP_BACKOFF_BASE_MS = 1000;

/** 归一化 transport 配置片段（来自桥 config + transport.json 覆盖）。 */
export function normalizeTransportConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const mode = TUNNEL_MODES.includes(raw.tunnelMode) ? raw.tunnelMode : 'off';
  const frp = raw.frp !== null && typeof raw.frp === 'object' ? raw.frp : {};
  const ngrok = raw.ngrok !== null && typeof raw.ngrok === 'object' ? raw.ngrok : {};
  const relay = raw.relay !== null && typeof raw.relay === 'object' ? raw.relay : {};
  return {
    tunnelMode: mode,
    publicUrl: typeof raw.publicUrl === 'string' ? raw.publicUrl.trim() : '',
    cloudflaredPath: typeof raw.cloudflaredPath === 'string' && raw.cloudflaredPath.trim().length > 0
      ? raw.cloudflaredPath.trim()
      : 'cloudflared',
    frp: {
      serverAddr: typeof frp.serverAddr === 'string' ? frp.serverAddr.trim() : '',
      serverPort: Number.isInteger(frp.serverPort) && frp.serverPort > 0 ? frp.serverPort : 7000,
      token: typeof frp.token === 'string' ? frp.token : '',
      remotePort: Number.isInteger(frp.remotePort) && frp.remotePort >= 0 ? frp.remotePort : 0,
      useTls: frp.useTls === true,
    },
    // v3.3 §10.1 ngrok 托管：authtoken 只落 transport.json（600），不回显
    ngrok: {
      authtoken: typeof ngrok.authtoken === 'string' ? ngrok.authtoken.trim() : '',
      staticDomain: typeof ngrok.staticDomain === 'string' ? ngrok.staticDomain.trim() : '',
    },
    relay: {
      endpoint: typeof relay.endpoint === 'string' ? relay.endpoint.trim() : '',
    },
  };
}

/** 通道卡片静态文案（选型建议按 contract §10 / §10.1）。 */
export const CHANNEL_LABELS = {
  quick: { label: 'Cloudflare 快速隧道', desc: '免费试用，地址重启会变' },
  named: { label: 'Cloudflare 命名隧道', desc: '固定域名，免费免维护（需在 CF 后台配置）' },
  frp: { label: 'frp（自建 VPS / OpenFrp / 樱花Frp / Sunny-Ngrok）', desc: 'frp 协议服务商通用；直连长连接，国内 VPS 延迟最低' },
  custom: { label: '自定义地址', desc: '花生壳 / natapp / cpolar / zrok 等任意工具，粘贴公网地址即可' },
  ngrok: { label: 'ngrok 官方（免费静态域名）', desc: '填 authtoken + 静态域名，桥自动托管 ngrok.exe' },
  relay: { label: '商业中转（订阅）', desc: '下一阶段开放，敬请期待' },
  off: { label: '仅局域网', desc: '手机与电脑同一 Wi-Fi 时使用' },
};

/**
 * frp 通道：托管 frpc 子进程（下载校验 → 写配置 → spawn → 崩溃重启）。
 * spawnImpl / fetchJson / fetchBuffer 可注入（smoke-test 用 mock 进程）。
 */
class FrpChannel {
  /**
   * @param {{
   *   cfg: { serverAddr: string, serverPort: number, token: string, remotePort: number, useTls: boolean },
   *   home: string, localPort: number, log: (msg: string) => void,
   *   spawnImpl?: (command: string, args: string[], options: object) => import('node:child_process').ChildProcess,
   *   fetchJson?: (url: string) => Promise<any>,
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
    this.fetchJson = options.fetchJson;
    this.fetchBuffer = options.fetchBuffer;
    this.backoffBaseMs = Number.isInteger(options.backoffBaseMs) && options.backoffBaseMs > 0
      ? options.backoffBaseMs
      : FRP_BACKOFF_BASE_MS;
    this.maxRestarts = Number.isInteger(options.maxRestarts) && options.maxRestarts > 0
      ? options.maxRestarts
      : MAX_FRP_RESTARTS;
    this.child = null;
    this.exePath = '';
    this.configPath = '';
    this.stopping = false;
    this.restarts = 0;
    this.restartTimer = null;
    this.state = { status: 'starting', url: '', error: '' };
    this.binary = 'none';
  }

  async start() {
    const frpcDir = frpcHomeDir(this.home);
    const { toml } = buildFrpcConfig({ ...this.cfg, localPort: this.localPort });
    // token 只写进 frpc.toml（600），不进日志
    this.configPath = writeFrpcConfig(frpcDir, toml);
    this.log('已生成 frpc.toml（token 不落日志）');

    const { exePath, source } = await ensureFrpcBinary({
      frpcDir,
      log: this.log,
      ...(this.fetchJson !== undefined ? { fetchJson: this.fetchJson } : {}),
      ...(this.fetchBuffer !== undefined ? { fetchBuffer: this.fetchBuffer } : {}),
    });
    this.exePath = exePath;
    this.binary = source;

    if (this.stopping) return;
    this.spawnFrpc();
  }

  spawnFrpc() {
    const child = this.spawnImpl(this.exePath, ['-c', this.configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.state = { status: 'starting', url: this.state.url, error: '' };
    const onLine = (buffer) => {
      for (const line of buffer.toString('utf8').split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        this.handleFrpcLine(line);
      }
    };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.on('error', (error) => {
      this.state = { status: 'error', url: '', error: `frpc 启动失败：${error instanceof Error ? error.message : String(error)}` };
    });
    child.on('exit', (code) => {
      if (this.child !== child) return; // 旧进程的退出事件
      this.child = null;
      if (this.stopping) {
        this.state = { status: 'stopped', url: '', error: '' };
        return;
      }
      this.scheduleRestart(code);
    });
  }

  handleFrpcLine(line) {
    const parsed = parseFrpcLine(line);
    if (parsed.event === 'login-fail') {
      this.state = {
        status: 'error',
        url: '',
        error: `frpc 登录 frps 失败：${parsed.message ?? '未知原因'}（检查 serverAddr/serverPort/token）`,
      };
      return;
    }
    if (parsed.event === 'proxy-fail') {
      this.state = { ...this.state, error: `frpc 代理建立失败：${parsed.message ?? '未知原因'}` };
      return;
    }
    if (parsed.event === 'proxy-start') {
      const remotePort = this.cfg.remotePort > 0 ? this.cfg.remotePort : parsed.remotePort;
      if (Number.isInteger(remotePort) && remotePort > 0) {
        const url = `http://${this.cfg.serverAddr}:${remotePort}`;
        this.state = { status: 'running', url, error: '' };
        this.log(`frp 通道就绪：${url}`);
      } else {
        // remotePort=0 且 frps 分配结果还没出现在日志里：保持 starting 等下一行
        this.state = { ...this.state, status: 'starting' };
      }
    }
  }

  scheduleRestart(code) {
    if (this.restarts >= this.maxRestarts) {
      this.state = {
        status: 'error',
        url: '',
        error: `frpc 连续崩溃 ${this.restarts} 次，已停止重试（已降级局域网）。请检查 VPS 上的 frps 与网络后重试`,
      };
      return;
    }
    this.restarts += 1;
    const delay = this.backoffBaseMs * 2 ** (this.restarts - 1);
    this.state = {
      ...this.state,
      status: 'starting',
      error: `frpc 退出（code=${code ?? 'null'}），${Math.round(delay / 1000)} 秒后第 ${this.restarts}/${this.maxRestarts} 次重启`,
    };
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.spawnFrpc();
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

/** 统一通道状态机。 */
export class TransportManager {
  /**
   * @param {{
   *   config: { tunnelMode: string, publicUrl: string, frp: object, relay: object },
   *   log?: (msg: string) => void,
   *   home: string,
   *   quickStarter?: (options: object) => Promise<{url: string, stop: () => void}>,
   *   spawnImpl?: (command: string, args: string[], options: object) => import('node:child_process').ChildProcess,
   *   fetchJson?: (url: string) => Promise<any>,
   *   fetchBuffer?: (url: string) => Promise<Buffer>,
   *   fetchMeta?: (url: string) => Promise<{ size: number, sha256?: string }>,
   *   backoffBaseMs?: number,
   * }} deps
   */
  constructor(deps) {
    this.cfg = normalizeTransportConfig(deps.config);
    this.log = typeof deps.log === 'function' ? deps.log : () => {};
    this.home = deps.home;
    this.quickStarter = typeof deps.quickStarter === 'function' ? deps.quickStarter : startQuickTunnel;
    this.spawnImpl = deps.spawnImpl;
    this.fetchJson = deps.fetchJson;
    this.fetchBuffer = deps.fetchBuffer;
    this.fetchMeta = deps.fetchMeta;
    this.backoffBaseMs = deps.backoffBaseMs;
    this.localPort = 0;
    this.channel = null;      // 当前通道实例：统一有 snapshot()，进程型通道另有 stop()
  }

  /** 端口就绪后由 index.js 调用（frp 需要真实桥端口做 localPort）。 */
  async start({ localPort }) {
    this.localPort = localPort;
    await this.startChannel(this.cfg.tunnelMode);
  }

  /** 停旧起新的底层实现（不持久化）。 */
  async startChannel(mode) {
    await this.stopChannel();
    this.cfg.tunnelMode = mode;
    if (mode === 'off') {
      this.channel = {
        snapshot: () => ({ status: 'off', url: '', error: '' }),
        stop: async () => {},
      };
      return;
    }
    if (mode === 'named') {
      const url = this.cfg.publicUrl;
      if (url.length === 0) {
        this.channel = {
          snapshot: () => ({ status: 'error', url: '', error: 'named 模式需要在桥配置里填写 publicUrl（Cloudflare 后台已配好的固定地址）' }),
          stop: async () => {},
        };
      } else {
        this.channel = {
          snapshot: () => ({ status: 'running', url, error: '' }),
          stop: async () => {},
        };
        this.log(`named 通道就绪：${url}`);
      }
      return;
    }
    if (mode === 'relay') {
      const endpoint = this.cfg.relay.endpoint;
      this.channel = {
        snapshot: () => endpoint.length > 0
          ? { status: 'running', url: endpoint, error: '' }
          : { status: 'reserved', url: '', error: '订阅中转服务下一阶段开放（本版仅占位展示）' },
        stop: async () => {},
      };
      return;
    }
    if (mode === 'custom') {
      // v3.3 §10.1：用户粘贴任意公网地址（花生壳/natapp/cpolar/zrok 等专有工具拿到的），
      // 桥只存 publicUrl 并探活，不托管任何进程。
      const url = this.cfg.publicUrl;
      if (url.length === 0) {
        this.channel = {
          snapshot: () => ({
            status: 'error',
            url: '',
            error: 'custom 模式需要先填写公网地址（花生壳/natapp/cpolar/zrok 等工具给出的 http/https 地址）——已降级局域网',
          }),
          stop: async () => {},
        };
        return;
      }
      const parsed = parsePublicUrl(url);
      if (parsed === null) {
        this.channel = {
          snapshot: () => ({
            status: 'error',
            url,
            error: '地址格式无效：必须是 http:// 或 https:// 开头的完整公网地址——已降级局域网',
          }),
          stop: async () => {},
        };
        return;
      }
      this.channel = {
        snapshot: () => ({ status: 'running', url: parsed, error: '' }),
        stop: async () => {},
      };
      this.log(`custom 通道就绪：${parsed}（可随时用 POST /api/transport/probe 探活）`);
      return;
    }
    if (mode === 'ngrok') {
      const channel = new NgrokChannel({
        cfg: this.cfg.ngrok,
        home: this.home,
        localPort: this.localPort,
        log: this.log,
        ...(this.spawnImpl !== undefined ? { spawnImpl: this.spawnImpl } : {}),
        ...(this.fetchMeta !== undefined ? { fetchMeta: this.fetchMeta } : {}),
        ...(this.fetchBuffer !== undefined ? { fetchBuffer: this.fetchBuffer } : {}),
        ...(this.backoffBaseMs !== undefined ? { backoffBaseMs: this.backoffBaseMs } : {}),
      });
      this.channel = channel;
      try {
        await channel.start();
      } catch (error) {
        this.channel = {
          snapshot: () => ({ status: 'error', url: '', error: `ngrok 通道启动失败：${error instanceof Error ? error.message : String(error)}（已降级局域网）`, binary: 'none', restarts: 0 }),
          stop: async () => {},
        };
        this.log(`ngrok 通道启动失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.notify();
      return;
    }
    if (mode === 'quick') {
      const state = { status: 'starting', url: '', error: 'cloudflared 连接中（约 5-20 秒）' };
      let stopped = false;
      let tunnelRef = null; // stop 闭包自持引用，避免依赖外部字段的生命周期
      const channel = {
        snapshot: () => ({ ...state }),
        stop: async () => {
          stopped = true;
          const tunnel = tunnelRef;
          if (tunnel !== null) {
            try {
              tunnel.stop();
            } catch {
              // 未就绪即停止
            }
            tunnelRef = null;
          }
        },
      };
      this.channel = channel;
      const promise = this.quickStarter({
        bridgePort: this.localPort,
        targetHost: '127.0.0.1',
        command: this.cfg.cloudflaredPath,
        timeoutMs: 60_000,
        log: this.log,
        onExit: () => {
          if (!stopped) {
            state.status = 'stopped';
            state.url = '';
            state.error = 'cloudflared 已退出';
            tunnelRef = null;
          }
        },
      }).then((tunnel) => {
        if (stopped) {
          tunnel.stop();
          return tunnel;
        }
        tunnelRef = tunnel;
        state.status = 'running';
        state.url = tunnel.url;
        state.error = '';
        this.log(`Quick Tunnel 已就绪：${tunnel.url}`);
        return tunnel;
      }).catch((error) => {
        if (!stopped) {
          state.status = 'error';
          state.url = '';
          state.error = `Quick Tunnel 失败：${error instanceof Error ? error.message : String(error)}（已降级局域网）`;
        }
        throw error;
      }).finally(() => {
        this.notify();
      });
      // 吞掉拒绝：通道错误已进状态，不能变成 unhandledRejection
      promise.catch(() => {});
      return;
    }
    // mode === 'frp'
    const channel = new FrpChannel({
      cfg: this.cfg.frp,
      home: this.home,
      localPort: this.localPort,
      log: this.log,
      ...(this.spawnImpl !== undefined ? { spawnImpl: this.spawnImpl } : {}),
      ...(this.fetchJson !== undefined ? { fetchJson: this.fetchJson } : {}),
      ...(this.fetchBuffer !== undefined ? { fetchBuffer: this.fetchBuffer } : {}),
      ...(this.backoffBaseMs !== undefined ? { backoffBaseMs: this.backoffBaseMs } : {}),
    });
    this.channel = channel;
    try {
      await channel.start();
    } catch (error) {
      this.channel = {
        snapshot: () => ({ status: 'error', url: '', error: `frp 通道启动失败：${error instanceof Error ? error.message : String(error)}（已降级局域网）`, binary: 'none', restarts: 0 }),
        stop: async () => {},
      };
      this.log(`frp 通道启动失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.notify();
  }

  async stopChannel() {
    const channel = this.channel;
    this.channel = null;
    if (channel !== null && typeof channel.stop === 'function') {
      await channel.stop();
    }
  }

  /**
   * 切换通道：停旧起新，并把选择与通道参数持久化（contract §10.1）。
   * transport.json 含 frp token / ngrok authtoken（权限 600），只落盘不回显。
   * @param {string} mode
   * @param {{ persistFile?: string, params?: { publicUrl?: string, frp?: object, ngrok?: object } }} [options]
   */
  async switchMode(mode, options = {}) {
    if (!TUNNEL_MODES.includes(mode)) {
      throw new Error(`tunnelMode 必须是 ${TUNNEL_MODES.join(' / ')} 之一`);
    }
    // 切换时可一并写入通道参数（§10.1）：先归一化再生效，保证非法值被清成默认
    const params = options.params !== null && typeof options.params === 'object' ? options.params : null;
    if (params !== null) {
      if (typeof params.publicUrl === 'string') this.cfg.publicUrl = params.publicUrl.trim();
      if (params.frp !== null && typeof params.frp === 'object') {
        this.cfg.frp = normalizeTransportConfig({ frp: params.frp }).frp;
      }
      if (params.ngrok !== null && typeof params.ngrok === 'object') {
        this.cfg.ngrok = normalizeTransportConfig({ ngrok: params.ngrok }).ngrok;
      }
    }
    this.log(`切换公网通道：${this.cfg.tunnelMode} → ${mode}`);
    await this.stopChannel();
    this.cfg.tunnelMode = mode;
    const persistFile = typeof options.persistFile === 'string' ? options.persistFile : '';
    if (persistFile.length > 0) {
      try {
        const fs = await import('node:fs');
        // 持久化完整通道参数：frp token / ngrok authtoken 只落这里（600），不回显到任何响应
        const persistPayload = {
          tunnelMode: mode,
          publicUrl: this.cfg.publicUrl,
          frp: this.cfg.frp,
          ngrok: this.cfg.ngrok,
        };
        fs.writeFileSync(persistFile, `${JSON.stringify(persistPayload, null, 2)}\n`, 'utf8');
        try {
          fs.chmodSync(persistFile, 0o600);
        } catch {
          // Windows chmod 语义有限
        }
      } catch (error) {
        this.log(`通道选择持久化失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.startChannel(mode);
    return this.status();
  }

  /** 停掉当前通道（桥 dispose / 启动失败清理时调用）。 */
  async stop() {
    await this.stopChannel();
  }

  /** 状态快照：全部进 /api/health 与配对页（不含任何 token/authtoken）。 */
  status() {
    const channels = {
      quick: { id: 'quick', ...CHANNEL_LABELS.quick, status: 'off', url: '', error: '' },
      named: { id: 'named', ...CHANNEL_LABELS.named, status: 'off', url: this.cfg.publicUrl, error: '' },
      frp: { id: 'frp', ...CHANNEL_LABELS.frp, status: 'off', url: '', error: '', binary: 'none', restarts: 0 },
      custom: { id: 'custom', ...CHANNEL_LABELS.custom, status: 'off', url: this.cfg.publicUrl, error: '' },
      ngrok: { id: 'ngrok', ...CHANNEL_LABELS.ngrok, status: 'off', url: '', error: '', binary: 'none', restarts: 0 },
      relay: { id: 'relay', ...CHANNEL_LABELS.relay, status: 'reserved', url: this.cfg.relay.endpoint, error: '' },
    };
    let tunnelStatus = 'off';
    let tunnelUrl = '';
    let tunnelError = '';
    if (this.channel !== null && typeof this.channel.snapshot === 'function') {
      const snap = this.channel.snapshot();
      channels[this.cfg.tunnelMode] = { ...channels[this.cfg.tunnelMode], ...snap };
      tunnelStatus = snap.status;
      tunnelUrl = snap.url;
      tunnelError = snap.error;
    }
    // named/custom 的展示地址兜底用配置里的 publicUrl
    if ((this.cfg.tunnelMode === 'named' || this.cfg.tunnelMode === 'custom')
      && tunnelUrl.length === 0 && this.cfg.publicUrl.length > 0) {
      tunnelUrl = this.cfg.publicUrl;
    }
    return {
      tunnelMode: this.cfg.tunnelMode,
      tunnelStatus,
      tunnelUrl,
      tunnelError,
      channels,
    };
  }

  notify() {
    if (typeof this.onStatusChange === 'function') {
      try {
        this.onStatusChange(this.status());
      } catch {
        // 忽略
      }
    }
  }
}

export default TransportManager;

/**
 * 校验并归一化一个公网地址（custom 模式 / 探活共用）。
 * 必须是 http:// 或 https:// 开头的完整 URL；返回去掉尾部斜杠的规范化地址，非法返回 null。
 */
export function parsePublicUrl(url) {
  const text = typeof url === 'string' ? url.trim() : '';
  if (text.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname.length === 0) return null;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * 探活一个公网地址（contract §10.1）：GET <url>/api/health，3 秒超时。
 * custom 模式粘贴地址后的即时验证用；不跟随业务语义，只看 HTTP 状态可达性。
 * @param {string} url 公网地址（http/https）
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ok: boolean, status: number, latencyMs: number, error?: string}>}
 */
export async function probePublicUrl(url, options = {}) {
  const started = Date.now();
  const normalized = parsePublicUrl(url);
  const latencyMs = () => Date.now() - started;
  if (normalized === null) {
    return { ok: false, status: 0, latencyMs: latencyMs(), error: '地址格式无效：必须是 http:// 或 https:// 开头的完整 URL' };
  }
  const target = `${normalized}/api/health`;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 3000;
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  try {
    const response = await doFetch(target, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'dsh-phone-bridge-probe' },
    });
    // 读完 body 避免连接悬挂（状态码即结论，不关心内容）
    await response.arrayBuffer().catch(() => {});
    const ok = response.status >= 200 && response.status < 300;
    return {
      ok,
      status: response.status,
      latencyMs: latencyMs(),
      ...(ok ? {} : { error: `目标返回 HTTP ${response.status}——地址可达，但 /api/health 不正常（确认地址指向本桥）` }),
    };
  } catch (error) {
    const message = error instanceof Error
      ? (error.name === 'TimeoutError' || error.name === 'AbortError' ? `探活超时（${timeoutMs}ms）` : error.message)
      : String(error);
    return { ok: false, status: 0, latencyMs: latencyMs(), error: message };
  }
}
