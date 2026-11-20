/**
 * dsh-phone-bridge v3 · 入口
 *
 * 架构（任务书 2.2 节要求的三分）：
 *   BridgeService → bridge/{http,ws,auth,errors}.js   控制面 + 数据面 + 鉴权
 *   DSH Adapter   → adapter/{dsh,project}.js          唯一与 DSH 交互的层
 *   EventHub      → bridge/eventhub.js                订阅 DSH 事件 → 规范化 → 分发
 *
 * 设计红线：
 *   - 发消息只走 sessionController.prompt（DSH Agent 循环），绝不直连模型 API。
 *   - 所有副作用都包在 ctx.effect 里，卸载时清理干净（端口、监听器、定时器）。
 *   - 令牌只落盘在电脑端，桥不回显已签发令牌。
 *
 * 证据等级：[实测] 底层 DSH 服务名与结构均已用 cordis Inspect + 真实会话日志核对。
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { BRIDGE_VERSION, CONTRACT_VERSION, MIN_CONTRACT_VERSION, PROTOCOL } from './shared/version.js';
import { BridgeError, ErrorCode, asBridgeError, sendJson, sendText } from './bridge/errors.js';
import { TokenStore, PairingCode } from './bridge/auth.js';
import { createHttpHandler } from './bridge/http.js';
import { WsDataPlane } from './bridge/ws.js';
import { EventHub } from './bridge/eventhub.js';
import { TransportManager, TUNNEL_MODES, normalizeTransportConfig } from './bridge/transport.js';
import { DshAdapter } from './adapter/dsh.js';
import { lanAddress, pairHtml } from './pair.js';
import { normalizeCloudflaredProtocol, normalizeCloudflaredDnsResolvers } from './cloudflare.js';
import { DEFAULT_RELAY_ENDPOINT, RELAY_MARKER_HEADER } from './bridge/relay.js';

export const name = 'dsh-phone-bridge';
export const version = BRIDGE_VERSION;
export const inject = [
  'webServer',
  'connection',
  'sessionController',
  'sessionQuery',
  'sessionTitle',
  'workspaceController',
  'agentDefaultModel',
];

const PORT_RETRY = 10;

/** 归一化配置（任务书 3.2 节草案）。 */
export function normalize(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const port = Number.isInteger(raw.port) ? raw.port : 8787;
  // v3.2 通道选择：tunnelMode 显式配置优先；未配置时兼容旧 cloudflareTunnel:
  //   startup → quick（原来就是启动即建 cloudflared 快速隧道），其余 → off（仅局域网）
  let tunnelMode = 'off';
  if (TUNNEL_MODES.includes(raw.tunnelMode)) {
    tunnelMode = raw.tunnelMode;
  } else if (raw.cloudflareTunnel === 'startup') {
    tunnelMode = 'quick';
  }
  const frp = raw.frp !== null && typeof raw.frp === 'object' ? raw.frp : {};
  const ngrok = raw.ngrok !== null && typeof raw.ngrok === 'object' ? raw.ngrok : {};
  const relay = raw.relay !== null && typeof raw.relay === 'object' ? raw.relay : {};
  return {
    enabled: raw.enabled !== false,
    host: typeof raw.host === 'string' && raw.host.length > 0 ? raw.host : '0.0.0.0',
    port: port >= 0 && port <= 65535 ? port : 8787,
    authMode: raw.authMode === 'none' ? 'none' : 'token',
    tokenTtlDays: Number.isFinite(raw.tokenTtlDays) ? raw.tokenTtlDays : 365,
    pairingMode: raw.pairingMode === 'disabled' ? 'disabled' : 'lan',
    allowOrigins: Array.isArray(raw.allowOrigins) ? raw.allowOrigins : [],
    publicUrl: typeof raw.publicUrl === 'string' ? raw.publicUrl : '',
    cloudflareTunnel: raw.cloudflareTunnel === 'pair' || raw.cloudflareTunnel === 'startup'
      ? raw.cloudflareTunnel
      : 'off',
    cloudflaredPath: typeof raw.cloudflaredPath === 'string' ? raw.cloudflaredPath : 'cloudflared',
    cloudflaredProtocol: normalizeCloudflaredProtocol(raw.cloudflaredProtocol),
    cloudflaredDnsResolvers: normalizeCloudflaredDnsResolvers(raw.cloudflaredDnsResolvers),
    tunnelMode,
    frp: {
      serverAddr: typeof frp.serverAddr === 'string' ? frp.serverAddr : '',
      serverPort: Number.isInteger(frp.serverPort) ? frp.serverPort : 7000,
      token: typeof frp.token === 'string' ? frp.token : '',
      remotePort: Number.isInteger(frp.remotePort) && frp.remotePort >= 0 ? frp.remotePort : 0,
      useTls: frp.useTls === true,
    },
    ngrok: {
      authtoken: typeof ngrok.authtoken === 'string' ? ngrok.authtoken : '',
      staticDomain: typeof ngrok.staticDomain === 'string' ? ngrok.staticDomain : '',
    },
    relay: {
      // 中转服务是自建的（spec/relay.md），默认地址跟着官方服务走，可在配对页改。
      endpoint: typeof relay.endpoint === 'string' && relay.endpoint.length > 0
        ? relay.endpoint
        : DEFAULT_RELAY_ENDPOINT,
      token: typeof relay.token === 'string' ? relay.token : '',
      // 8 位十六进制配对码：中转按它给隧道分组，手机端扫码时一并带上。
      pairCode: typeof relay.pairCode === 'string' ? relay.pairCode : '',
    },
    logLevel: typeof raw.logLevel === 'string' ? raw.logLevel : 'info',
    tokenFile: typeof raw.tokenFile === 'string' ? raw.tokenFile : '',
  };
}

/** 令牌文件默认位置：$DSH_HOME/phone-bridge/tokens.json */
function defaultTokenFile() {
  return path.join(defaultTokenHome(), 'phone-bridge', 'tokens.json');
}

/** DSH home 目录（frpc 托管与 transport.json 都落在它的 phone-bridge/ 下）。 */
function defaultTokenHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

/** 在指定端口上监听，被占用时依次 +1 重试。 */
function listenWithRetry(server, host, port) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (candidate) => {
      const onError = (error) => {
        if (error && error.code === 'EADDRINUSE' && attempt < PORT_RETRY) {
          attempt += 1;
          tryListen(candidate + 1);
          return;
        }
        server.off('error', onError);
        reject(error);
      };
      server.once('error', onError);
      server.listen(candidate, host, () => {
        server.off('error', onError);
        const address = server.address();
        const actual = address !== null && typeof address === 'object' && Number.isInteger(address.port)
          ? address.port
          : candidate;
        resolve(actual);
      });
    };
    tryListen(port);
  });
}

export function apply(ctx, config) {
  const cfg = normalize(config);
  const log = (message) => {
    if (cfg.logLevel === 'silent') return;
    try {
      ctx.logger?.info?.(`[dsh-phone-bridge] ${message}`);
    } catch (error) {
      // 忽略日志失败
    }
  };

  if (!cfg.enabled) {
    log('已在配置中禁用，未启动');
    return;
  }

  const adapter = new DshAdapter(ctx, { log });
  const eventHub = new EventHub({ log });
  adapter.startWorkspaceWatch();
  const tokenFile = cfg.tokenFile.length > 0 ? cfg.tokenFile : defaultTokenFile();
  const tokens = new TokenStore({ file: tokenFile, ttlMs: cfg.tokenTtlDays * 24 * 3600 * 1000, log });
  const pairing = new PairingCode({ ttlMs: 10 * 60 * 1000 });

  ctx.effect(() => {
    let disposed = false;
    const state = {
      port: 0,
      server: null,
      wsPlane: null,
    };

    eventHub.attach(ctx);

    // v3.5：规范化事件 → 会话列表预览缓存（message.created/message.done 实时更新
    // 最后一条消息，contract.md §3.1 preview/lastRole）
    eventHub.subscribe((envelope) => {
      try {
        adapter.observePreviewEvent(envelope);
      } catch {
        // 预览缓存更新失败不影响事件分发
      }
    });

    // 公网通道状态机（contract §10）：配置 = 桥 config + transport.json 覆盖
    //（配对页切换通道时写 transport.json，优先级高于插件 config 的 tunnelMode）
    const transportOverrideFile = path.join(path.dirname(tokenFile), 'transport.json');
    let transportOverrides = {};
    try {
      if (fs.existsSync(transportOverrideFile)) {
        const parsed = JSON.parse(fs.readFileSync(transportOverrideFile, 'utf8'));
        if (parsed !== null && typeof parsed === 'object') {
          // 整份覆盖：配对页填的 frp / ngrok 参数与 publicUrl 也要读回，
          // 否则「切通道 → 重启 DSH」会丢掉刚填的地址和 token。
          const overrides = {};
          if (TUNNEL_MODES.includes(parsed.tunnelMode)) overrides.tunnelMode = parsed.tunnelMode;
          if (typeof parsed.publicUrl === 'string') overrides.publicUrl = parsed.publicUrl;
          if (parsed.frp !== null && typeof parsed.frp === 'object') overrides.frp = parsed.frp;
          if (parsed.ngrok !== null && typeof parsed.ngrok === 'object') overrides.ngrok = parsed.ngrok;
          if (parsed.relay !== null && typeof parsed.relay === 'object') overrides.relay = parsed.relay;
          transportOverrides = overrides;
        }
      }
    } catch (error) {
      log(`transport.json 读取失败（按桥配置执行）: ${error instanceof Error ? error.message : String(error)}`);
    }
    const transport = new TransportManager({
      config: normalizeTransportConfig({
        tunnelMode: transportOverrides.tunnelMode ?? cfg.tunnelMode,
        publicUrl: transportOverrides.publicUrl ?? cfg.publicUrl,
        cloudflaredPath: cfg.cloudflaredPath,
        cloudflaredProtocol: cfg.cloudflaredProtocol,
        cloudflaredDnsResolvers: cfg.cloudflaredDnsResolvers,
        // 浅合并：transport.json 里有的字段优先，缺的字段沿用插件 config
        frp: { ...(cfg.frp ?? {}), ...(transportOverrides.frp ?? {}) },
        ngrok: { ...(cfg.ngrok ?? {}), ...(transportOverrides.ngrok ?? {}) },
        relay: { ...(cfg.relay ?? {}), ...(transportOverrides.relay ?? {}) },
      }),
      home: defaultTokenHome(),
      log,
      // 中转配对码被服务端判为占用时通道会自动换码；必须落盘，
      // 否则重启后旧码再来一次，手机端显示的地址就和桥上实际注册的不一致。
      // 落盘由 TransportManager.writePersistFile 完成（整份覆盖，含 relay token），
      // 这里只补一条日志方便排查。
      persistFile: transportOverrideFile,
      onPairCodeChange: (code) => {
        log(`中转配对码已切换为 ${code}，已写入 ${transportOverrideFile}`);
      },
    });
    const localControlToken = randomBytes(32).toString('base64url');

    const httpHandler = createHttpHandler({
      adapter,
      eventHub,
      tokens,
      pairing,
      transport,
      transportPersistFile: transportOverrideFile,
      localControlToken,
      config: cfg,
      log,
    });

    /**
     * 判断这个请求是不是官方中转转发进来的。
     *
     * 中转在服务端把手机请求带进本机，socket 源是 127.0.0.1，与真正的本机用户
     * 无法区分；中转会给每个请求加上每次启动随机生成的 x-dsh-relay 标记头
     * （见 bridge/relay.js），这里用定长比较把它和本机请求区分开。
     */
    function isRelayPageRequest(request) {
      if (typeof transport.relayMarker !== 'function') return false;
      const expected = transport.relayMarker();
      if (typeof expected !== 'string' || expected.length === 0) return false;
      const submitted = request.headers[RELAY_MARKER_HEADER];
      if (typeof submitted !== 'string' || submitted.length !== expected.length) return false;
      return timingSafeEqual(Buffer.from(submitted, 'utf8'), Buffer.from(expected, 'utf8'));
    }

    /** 统一的 HTTP 服务器：/health、/pair、/ 以及 /api/** */
    const server = http.createServer((request, response) => {
      let url;
      try {
        url = new URL(request.url ?? '/', 'http://localhost');
      } catch (error) {
        sendText(response, 400, '非法请求');
        return;
      }
      const pathname = url.pathname;
      const method = (request.method ?? 'GET').toUpperCase();

      if (pathname === '/health' || pathname === '/api/health') {
        const hello = eventHub.helloPayload();
        const lan = lanAddress();
        const transportStatus = transport.status();
        sendJson(response, 200, {
          status: 'ok',
          plugin: name,
          version,
          bridgeVersion: hello.bridgeVersion,
          contractVersion: hello.contractVersion,
          protocol: PROTOCOL,
          minContractVersion: MIN_CONTRACT_VERSION,
          port: state.port,
          lanUrl: lan.length > 0 ? `ws://${lan}:${state.port}` : '',
          publicUrl: transport.cfg.publicUrl,
          tunnelMode: transportStatus.tunnelMode,
          tunnelStatus: transportStatus.tunnelStatus,
          tunnelUrl: transportStatus.tunnelUrl,
          tunnelError: transportStatus.tunnelError,
          channels: transportStatus.channels,
          clients: state.wsPlane !== null ? state.wsPlane.clients.size : 0,
          cursor: eventHub.currentCursor(),
          pairingMode: cfg.pairingMode,
          time: Date.now(),
        });
        return;
      }

      if (pathname === '/pair' || pathname === '/') {
        const remote = request.socket !== null && request.socket !== undefined
          ? request.socket.remoteAddress
          : '';
        const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        // 隧道/frp 来源都从 127.0.0.1 连入，socket 层面与本机无法区分；
        // 配对页展示配对码，只允许「socket 回环 + Host 指向回环地址」的请求打开。
        const host = typeof request.headers.host === 'string' ? request.headers.host.trim().toLowerCase() : '';
        const hostPart = host.replace(/:\d+$/, '');
        const hostIsLoopback = hostPart === '127.0.0.1' || hostPart === 'localhost' || hostPart === '[::1]' || hostPart === '::1';
        if (host === 'dsh-phone-bridge-tunnel') {
          sendText(response, 403, '配对页不允许通过公网隧道访问');
          return;
        }
        // 官方中转转发进来的请求 socket 同样是 127.0.0.1，必须靠标记头识别；
        // 否则手机/任何人从 /p/<配对码> 打开配对页，就能看到并直接用掉配对码。
        if (isRelayPageRequest(request)) {
          sendText(response, 403, '配对页不允许通过公网中转访问');
          return;
        }
        if (!isLoopback || !hostIsLoopback) {
          sendText(response, 403, '配对页只允许在电脑本机打开');
          return;
        }
        const current = pairing.current();
        const lan = lanAddress();
        const lanUrl = lan.length > 0 ? `ws://${lan}:${state.port}` : '';
        const transportStatus = transport.status();
        response.setHeader('Cache-Control', 'no-store');
        sendText(
          response,
          200,
          pairHtml({
            lanUrl,
            publicUrl: transport.cfg.publicUrl,
            tunnelUrl: transportStatus.tunnelUrl,
            channels: transportStatus.channels,
            frp: transport.frpFormValues(),
            relay: transport.relayFormValues(),
            currentChannel: transportStatus.tunnelMode,
            transportApiPath: '/api/transport/mode',
            localControlToken,
            port: state.port,
            clients: state.wsPlane !== null ? state.wsPlane.clients.size : 0,
            code: current.code,
            expiresAt: current.expiresAt,
            bridgeVersion: BRIDGE_VERSION,
            contractVersion: CONTRACT_VERSION,
          }),
          'text/html; charset=utf-8',
        );
        return;
      }

      if (pathname.startsWith('/api/')) {
        void httpHandler(request, response);
        return;
      }

      sendText(response, 404, '未找到');
    });

    const boot = async () => {
      try {
        const port = await listenWithRetry(server, cfg.host, cfg.port);
        state.port = port;
        state.server = server;
        if (disposed) {
          server.close();
          return;
        }

        const wsPlane = new WsDataPlane({
          server,
          adapter,
          eventHub,
          tokens,
          log,
          path: '/ws',
        });
        wsPlane.start();
        state.wsPlane = wsPlane;

        const lan = lanAddress();
        log(`已启动: http://${cfg.host}:${port}  (局域网 ws://${lan}:${port})`);
        log(`配对页: http://127.0.0.1:${port}/pair  当前配对码: ${pairing.current().code}`);

        // v3.5：启动时对列表前 20 个会话批量补齐「最后一条消息预览」（后台执行）
        void adapter.warmPreviewCache();

        // 运行时信息落盘，供 /pair 斜杠命令读取（端口可能被 +1 重试过）
        try {
          const runtimeFile = path.join(path.dirname(tokenFile), 'runtime.json');
          fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
          fs.writeFileSync(
            runtimeFile,
            JSON.stringify({ port, code: pairing.current().code, version, time: Date.now() }, null, 2),
            'utf8',
          );
        } catch (error) {
          log(`写运行时信息失败: ${error instanceof Error ? error.message : String(error)}`);
        }

        void transport.start({ localPort: port }).catch((error) => {
          log(`公网通道启动失败: ${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        log(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    void boot();

    return () => {
      disposed = true;
      try {
        adapter.stopWorkspaceWatch();
      } catch (error) {
        // 忽略
      }
      try {
        eventHub.dispose();
      } catch (error) {
        // 忽略
      }
      try {
        state.wsPlane?.dispose?.();
      } catch (error) {
        // 忽略
      }
      try {
        // 停掉公网通道进程（cloudflared / frpc）——随桥 dispose 全部回收
        void transport.stop();
      } catch (error) {
        // 忽略
      }
      try {
        state.server?.close?.();
      } catch (error) {
        // 忽略
      }
      // 令牌文件已在 TokenStore 内持久化，无需额外处理
      log('已停止');
    };
  });

  // /pair 斜杠命令（可选依赖 commands）
  ctx.inject(['commands'], (sub) => {
    sub.effect(() => {
      const commands = sub.get('commands');
      if (commands === undefined) return;
      try {
        registerPairCommand(sub, commands, cfg, log);
      } catch (error) {
        log(`注册 /pair 命令失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });
}

/** 注册 /pair 命令（独立出来便于测试）。 */
function registerPairCommand(context, commands, cfg, log) {
  if (typeof commands.register !== 'function') return;
  commands.register({
    definitionId: 'dsh-phone-bridge',
    name: 'pair',
    description: '显示手机端配对地址与配对码',
    async handler(agent) {
      try {
        const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
          ? process.env.DSH_HOME
          : path.join(os.homedir(), '.dsh');
        const portFile = path.join(home, 'phone-bridge', 'runtime.json');
        let port = 0;
        let code = '';
        try {
          if (fs.existsSync(portFile)) {
            const parsed = JSON.parse(fs.readFileSync(portFile, 'utf8'));
            if (Number.isInteger(parsed.port)) port = parsed.port;
            if (typeof parsed.code === 'string') code = parsed.code;
          }
        } catch (error) {
          // 忽略
        }
        const lan = lanAddress();
        const url = lan.length > 0 && port > 0 ? `ws://${lan}:${port}` : '';
        const lines = [
          '手机端配对信息：',
          url.length > 0 ? `服务器地址：${url}` : '服务器地址：请在浏览器打开配对页查看',
          code.length > 0 ? `配对码：${code}` : '配对码：请在电脑上打开配对页查看',
          port > 0 ? `配对页：http://127.0.0.1:${port}/pair` : '配对页：请查看 DSH 日志',
          '手机 App → 连接页 → 扫码或手动输入地址 + 配对码。',
        ];
        if (agent !== null && agent !== undefined && typeof agent.followup === 'function') {
          agent.followup({
            id: `pair-${Date.now()}`,
            role: 'user',
            content: [{ type: 'text', text: lines.join('\n') }],
            source: { kind: 'dsh-phone-bridge', form: 'notice', summary: '手机端配对信息' },
          });
        } else {
          log(lines.join(' | '));
        }
      } catch (error) {
        log(`配对命令执行失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

export default { name, version, inject, apply, normalize };
