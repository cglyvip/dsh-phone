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

import { BRIDGE_VERSION, CONTRACT_VERSION, MIN_CONTRACT_VERSION, PROTOCOL } from './shared/version.js';
import { BridgeError, ErrorCode, asBridgeError, sendJson, sendText } from './bridge/errors.js';
import { TokenStore, PairingCode } from './bridge/auth.js';
import { createHttpHandler } from './bridge/http.js';
import { WsDataPlane } from './bridge/ws.js';
import { EventHub } from './bridge/eventhub.js';
import { DshAdapter } from './adapter/dsh.js';
import { lanAddress, pairHtml } from './pair.js';
import { startQuickTunnel } from './cloudflare.js';

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
  return {
    enabled: raw.enabled !== false,
    host: typeof raw.host === 'string' && raw.host.length > 0 ? raw.host : '0.0.0.0',
    port: port >= 0 && port <= 65535 ? port : 8787,
    authMode: raw.authMode === 'none' ? 'none' : 'token',
    tokenTtlDays: Number.isFinite(raw.tokenTtlDays) ? raw.tokenTtlDays : 7,
    pairingMode: raw.pairingMode === 'disabled' ? 'disabled' : 'lan',
    allowOrigins: Array.isArray(raw.allowOrigins) ? raw.allowOrigins : [],
    publicUrl: typeof raw.publicUrl === 'string' ? raw.publicUrl : '',
    cloudflareTunnel: raw.cloudflareTunnel === 'pair' || raw.cloudflareTunnel === 'startup'
      ? raw.cloudflareTunnel
      : 'off',
    cloudflaredPath: typeof raw.cloudflaredPath === 'string' ? raw.cloudflaredPath : 'cloudflared',
    logLevel: typeof raw.logLevel === 'string' ? raw.logLevel : 'info',
    tokenFile: typeof raw.tokenFile === 'string' ? raw.tokenFile : '',
  };
}

/** 令牌文件默认位置：$DSH_HOME/phone-bridge/tokens.json */
function defaultTokenFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'phone-bridge', 'tokens.json');
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
      tunnel: null,
      tunnelUrl: '',
      tunnelPromise: null,
    };

    eventHub.attach(ctx);

    const httpHandler = createHttpHandler({ adapter, eventHub, tokens, pairing, config: cfg, log });

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
          publicUrl: cfg.publicUrl,
          tunnelUrl: state.tunnelUrl,
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
        if (!isLoopback) {
          sendText(response, 403, '配对页只允许在电脑本机打开');
          return;
        }
        const current = pairing.current();
        const lan = lanAddress();
        const lanUrl = lan.length > 0 ? `ws://${lan}:${state.port}` : '';
        sendText(
          response,
          200,
          pairHtml({
            lanUrl,
            publicUrl: cfg.publicUrl,
            tunnelUrl: state.tunnelUrl,
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

        if (cfg.cloudflareTunnel === 'startup') {
          void ensureTunnel();
        }
      } catch (error) {
        log(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const ensureTunnel = () => {
      if (state.tunnelPromise !== null) return state.tunnelPromise;
      state.tunnelPromise = startQuickTunnel({
        bridgePort: state.port,
        targetHost: 'http://127.0.0.1',
        command: cfg.cloudflaredPath,
        timeoutMs: 60_000,
        log,
        onExit: () => {
          state.tunnelUrl = '';
          state.tunnel = null;
          state.tunnelPromise = null;
        },
      }).then((tunnel) => {
        state.tunnel = tunnel;
        state.tunnelUrl = tunnel.url;
        log(`Cloudflare 隧道已就绪: ${tunnel.url}`);
        return tunnel;
      }).catch((error) => {
        state.tunnelPromise = null;
        log(`隧道启动失败: ${error instanceof Error ? error.message : String(error)}`);
        throw asBridgeError(error);
      });
      return state.tunnelPromise;
    };

    // 让后续逻辑能触达隧道
    state.ensureTunnel = ensureTunnel;

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
        state.tunnel?.stop?.();
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
