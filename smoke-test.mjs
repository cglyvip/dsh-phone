/**
 * dsh-phone-bridge v3 · 冒烟测试（不依赖 DSH 运行时）
 *
 * 用一个假的 cordis ctx 把插件跑起来，端到端验证：
 *   REST：health / pairing-code / pair / sessions / messages / models / settings
 *   WS ：hello / subscribe / 事件推送 / send / stop
 *
 * 运行：node smoke-test.mjs
 * 证据等级：[实测] —— 全部断言基于本文件构造的假 DSH 服务。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { apply, normalize } from './index.js';
import { lastChatMessage, previewOfBlocks, projectEvents, toPreviewText } from './adapter/project.js';
import { buildFrpcConfig, ensureFrpcBinary, extractFrpcFromZip, frpReleaseInfo, verifyReleaseAsset, writeFrpcConfig } from './bridge/frpc.js';
import { ensureNgrokBinary, extractNgrokFromZip, ngrokReleaseInfo, parseNgrokLine, verifyNgrokAsset } from './bridge/ngrok.js';
import { probePublicUrl } from './bridge/transport.js';
import { BRIDGE_VERSION } from './shared/version.js';
import { FRP_PROVIDERS, pairHtml } from './pair.js';
import { TUNNEL_PROVIDERS } from './shared/tunnel-providers.js';
import { normalizeTransportConfig, TransportManager } from './bridge/transport.js';

/** v3.1 上传上限（与 adapter/dsh.js 的 MAX_UPLOAD_BYTES 一致）。 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

// ── v3.2 §10 frp 托管测试工具 ──────────────────────────────────────────────

function crc32Of(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

/** 构造一个最小 zip（stored 方法，含中央目录 + EOCD），装着 frpc.exe。 */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32Of(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, entry.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(entry.data.length, 20);
    cen.writeUInt32LE(entry.data.length, 24);
    cen.writeUInt16LE(nameBytes.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBytes);
    offset += 30 + nameBytes.length + entry.data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

/** frpc mock 子进程工厂：先吐日志行，exitAfterMs 后崩溃退出。 */
function makeFrpcSpawner({ lines, exitAfterMs = 40 }) {
  const spawns = [];
  return {
    spawns,
    spawnImpl: (command, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 40000 + spawns.length;
      child.killed = false;
      child.kill = () => {
        if (!child.killed) {
          child.killed = true;
          queueMicrotask(() => child.emit('exit', 0));
        }
        return true;
      };
      spawns.push({ command, args, pid: child.pid });
      queueMicrotask(() => {
        // ngrok config add-authtoken 是一闪而过的子命令：mock 让它立即以 0 退出
        if (args[0] === 'config' && args[1] === 'add-authtoken') {
          child.emit('exit', 0);
          return;
        }
        for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`));
        if (exitAfterMs >= 0) {
          const timer = setTimeout(() => {
            if (!child.killed) child.emit('exit', 1);
          }, exitAfterMs);
          if (typeof timer.unref === 'function') timer.unref();
        }
      });
      return child;
    },
  };
}

async function waitForCondition(getValue, expect, timeoutMs = 8000, label = '条件') {
  const started = Date.now();
  for (;;) {
    const value = getValue();
    if (expect(value)) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等待 ${label} 超时（当前 ${JSON.stringify(value)}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ── 假 DSH 服务 ────────────────────────────────────────────────────────────

const SESSION_A = 'session-aaaa';
const SESSION_B = 'session-bbbb';
const SESSION_C = 'session-cccc';

const fakeEvents = [
  { type: 'permission/preset', seq: 0, time: 1000, data: { preset: 'workspace-write' } },
  { type: 'sandbox/mode', seq: 1, time: 1001, data: { mode: 'workspace-write' } },
  { type: 'approval/policy', seq: 2, time: 1002, data: { policy: 'ask' } },
  { type: 'model/selection', seq: 3, time: 1003, data: { provider: 'magpie', model: 'x/y', reasoningEffort: 'high' } },
  { type: 'user/message', seq: 10, time: 1010, data: { role: 'user', id: 'u1', content: [{ type: 'text', text: '你好' }] } },
  { type: 'turn/start', seq: 11, time: 1011, data: { turn: 1 } },
  {
    type: 'assistant/message',
    seq: 12,
    time: 1012,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        id: 'a1',
        content: [{ type: 'text', text: '你好，有什么可以帮你的？' }],
        source: { kind: 'model', provider: 'magpie', model: 'x/y' },
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    },
  },
  { type: 'turn/end', seq: 13, time: 1013, data: { turn: 1, reason: { kind: 'stop' } } },
  { type: 'session/title', seq: 14, time: 1014, data: { title: '打招呼', messageSeqs: [10] } },
];

let createdCounter = 0;

function makeFakeCtx() {
  const handlers = new Map();
  const disposers = [];
  const fakeServices = {
    // 测试辅助记录（v3.1 断言用）
    __archived: [],
    __staged: [],
    __appended: [],
    __liveSessions: new Map(),
    webServer: { register: () => () => {} },
    connection: { admit: () => true },
    sessionController: {
      async list() {
        return {
          items: [
            { sessionId: SESSION_A, updatedAt: 1014, running: false, blank: false, cwd: 'E:\\work', agentAvailable: true },
            { sessionId: SESSION_B, updatedAt: 900, running: false, blank: true, cwd: 'E:\\work', agentAvailable: true },
            { sessionId: SESSION_C, updatedAt: 800, running: false, blank: true, cwd: 'E:\\work', agentAvailable: true },
          ],
        };
      },
      async search(request) {
        return { items: [{ sessionId: SESSION_A, snippet: '你好' }], hasMore: false };
      },
      async create() {
        createdCounter += 1;
        return { sessionId: `session-new-${createdCounter}` };
      },
      async rename(request) {
        return { title: request.title, seq: 1 };
      },
      async fork() {
        return { sessionId: 'session-fork' };
      },
      async prompt(request) {
        this.lastPrompt = request;
        return { accepted: true };
      },
      cancel() {
        return { accepted: true };
      },
      async state() {
        return { cursor: 14, active: true, running: false, queue: null, pendingInput: [] };
      },
      async modelCatalog() {
        return {
          default: { provider: 'magpie', model: 'x/y' },
          routableProviders: ['magpie'],
          groups: [
            {
              id: 'magpie',
              name: 'Magpie',
              models: [
                { id: 'x/y', name: 'X/Y', description: '测试模型', reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' } },
              ],
            },
          ],
          failures: [],
        };
      },
      async selectModel(request) {
        return { selected: { provider: request.provider, model: request.model } };
      },
      async initializeDefaultModel() {
        return undefined;
      },
    },
    sessionQuery: {
      async listSessions() {
        return [
          { header: { version: 4, id: SESSION_A, createdAt: 1000, cwd: 'E:\\work', isSeeded: false }, live: true, persisted: true },
        ];
      },
      async readSession(sessionId) {
        if (sessionId !== SESSION_A && sessionId !== SESSION_B) {
          const error = new Error('会话不存在');
          error.code = 'session/not-found';
          throw error;
        }
        // 模拟真实日志：桥/预设服务追加的旋钮事件也出现在会话日志里
        const appended = fakeServices.__appended
          .filter((item) => item.id === sessionId)
          .map((item, index) => ({ type: item.type, seq: 9000 + index, time: 9000 + index, data: item.data }));
        return {
          session: { version: 4, id: sessionId, createdAt: 1000, cwd: 'E:\\work', isSeeded: false, agentPreset: 'cordis' },
          inheritedEventCount: 0,
          events: [...fakeEvents, ...appended],
        };
      },
      async readTitleSnapshots(ids) {
        return ids.map((sessionId) => ({
          sessionId,
          status: 'fulfilled',
          value: {
            session: { version: 4, id: sessionId, createdAt: 1000, isSeeded: false },
            title: sessionId === SESSION_A ? { title: '打招呼' } : undefined,
          },
        }));
      },
    },
    sessionTitle: {
      async rename() {
        return undefined;
      },
    },
    workspaceController: {
      async archiveSession(request) {
        fakeServices.__archived.push(request.sessionId);
        return { archivedSessionIds: [SESSION_B] };
      },
      async unarchiveSession() {
        return undefined;
      },
      async pinSession() {
        return { pinnedSessionIds: [SESSION_A] };
      },
      async unpinSession() {
        return undefined;
      },
    },
    // v3.1：文件附件走 fileUploads 暂存收据（官方 dsh-client-file-upload 的形状）
    fileUploads: {
      async uploadStream(request) {
        const chunks = [];
        for await (const chunk of request.data) chunks.push(Buffer.from(chunk));
        const data = Buffer.concat(chunks);
        const hex = crypto.createHash('sha256').update(data).digest('hex');
        fakeServices.__staged.push({
          sessionId: request.sessionId,
          name: request.name ?? '',
          bytes: data.length,
        });
        return {
          receiptId: `receipt-${fakeServices.__staged.length}`,
          file: { attachmentId: `sha256:${hex}`, name: request.name ?? '', bytes: data.length },
        };
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'magpie', model: 'x/y', reasoningEffort: 'high' };
      },
      async saveSelection() {
        return undefined;
      },
    },
    // v3.1 §9.5：活会话存储 + 权限预设（形状按 dsh-permission-presets 官方服务）
    sessions: {
      get(sessionId) {
        return fakeServices.__liveSessions.get(sessionId);
      },
    },
    permissionPresets: {
      __knobs: new Map(),
      catalog() {
        return {
          options: [
            { value: 'workspace-write', name: 'workspace-write' },
            { value: 'danger-full-access', name: 'danger-full-access' },
          ],
          defaultOptions: [
            { value: 'workspace-write', name: 'workspace-write' },
            { value: 'danger-full-access', name: 'danger-full-access' },
          ],
          defaultPreset: 'workspace-write',
        };
      },
      resolve(name) {
        if (name === 'workspace-write') return { sandbox: 'workspace-write', approval: 'ask' };
        if (name === 'danger-full-access') return { sandbox: 'danger-full-access', approval: 'never' };
        throw new Error(`permission: unknown preset "${name}"`);
      },
      current(session) {
        // 按真实 derive() 语义折叠该会话的旋钮事件（真实实现折会话日志）
        let sandbox;
        let approval;
        let preset;
        for (const item of fakeServices.__appended) {
          if (item.id !== session.id) continue;
          if (item.type === 'sandbox/mode') sandbox = item.data.mode;
          else if (item.type === 'approval/policy') approval = item.data.policy;
          else if (item.type === 'permission/preset') preset = item.data.preset;
        }
        const specOf = (name) => {
          try {
            return this.resolve(name);
          } catch {
            return undefined;
          }
        };
        if (preset !== undefined) {
          const spec = specOf(preset);
          if (spec !== undefined && spec.sandbox === sandbox) return preset;
        }
        if (sandbox !== undefined) {
          for (const name of ['workspace-write', 'danger-full-access']) {
            const spec = specOf(name);
            if (spec !== undefined && spec.sandbox === sandbox && spec.approval === (approval ?? spec.approval)) return name;
          }
          return 'custom';
        }
        // 无旋钮事件 → 组合默认（假服务默认 = workspace-write 预设）
        return 'workspace-write';
      },
      set(session, name) {
        // 按真实 apply()：permission/preset + setSandboxMode + setApprovalPolicy 三条事件
        const spec = this.resolve(name);
        fakeServices.permissionPresets.__knobs.set(session.id, { sandbox: spec.sandbox, approval: spec.approval, preset: name });
        fakeServices.__appended.push({ id: session.id, type: 'permission/preset', data: { preset: name } });
        fakeServices.__appended.push({ id: session.id, type: 'sandbox/mode', data: { mode: spec.sandbox } });
        fakeServices.__appended.push({ id: session.id, type: 'approval/policy', data: { policy: spec.approval } });
      },
    },
    workspaceRegistry: {
      async list() {
        return [{ workspaceId: 'w1', path: 'E:\\work', title: 'work' }];
      },
    },
    commands: {
      register(definition) {
        fakeServices.commands.registered = definition;
      },
    },
  };

  const ctx = {
    get(name) {
      return fakeServices[name];
    },
    on(eventName, handler) {
      if (!handlers.has(eventName)) handlers.set(eventName, new Set());
      handlers.get(eventName).add(handler);
      return () => handlers.get(eventName)?.delete(handler);
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') {
        disposers.push(disposer);
        if (globalThis.__disposers === undefined) globalThis.__disposers = [];
        globalThis.__disposers.push(disposer);
      }
      return () => {};
    },
    inject(names, callback) {
      callback(ctx);
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    // 测试辅助
    __emit(eventName, ...args) {
      const set = handlers.get(eventName);
      if (set === undefined) return;
      for (const handler of set) handler(...args);
    },
    __services: fakeServices,
  };
  return ctx;
}

// ── 测试工具 ──────────────────────────────────────────────────────────────

async function request(port, method, pathname, options = {}) {
  const url = `http://127.0.0.1:${port}${pathname}`;
  const headers = { ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    json = undefined;
  }
  return { status: response.status, json, text };
}

function waitFor(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 WS 帧超时')), timeoutMs);
    const onMessage = (raw) => {
      const frame = JSON.parse(raw.toString('utf8'));
      if (predicate(frame)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(frame);
      }
    };
    ws.on('message', onMessage);
  });
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function waitForPort(runtimeFile, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 40));
    try {
      const parsed = JSON.parse(readFileSync(runtimeFile, 'utf8'));
      if (Number.isInteger(parsed.port) && parsed.port > 0) return parsed;
    } catch (error) {
      // 还没写出来
    }
  }
  throw new Error(`等待 runtime.json 超时: ${runtimeFile}`);
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-smoke-'));
  const tokenFile = join(tmpDir, 'tokens.json');
  const runtimeFile = join(tmpDir, 'runtime.json');
  // 隔离 $DSH_HOME：否则适配层会把偏好模型写进真实的 ~/.dsh/phone-bridge/model.json，
  // 测试用的假模型（a/b）会污染手机端新建会话。
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpDir;

  const ctx = makeFakeCtx();
  const cfg = normalize({ port: 0, host: '127.0.0.1', logLevel: 'silent', tokenFile });
  assert.equal(cfg.port, 0, 'normalize 应保留 0（随机端口）');
  apply(ctx, cfg);

  const runtime = await waitForPort(runtimeFile);
  const port = runtime.port;
  assert.ok(port > 0, '端口应大于 0');
  pass('插件启动并监听端口');

  // 1) health
  const health = await request(port, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  assert.equal(health.json.plugin, 'dsh-phone-bridge');
  assert.equal(health.json.bridgeVersion, BRIDGE_VERSION);
  assert.equal(health.json.contractVersion, 3);
  pass('GET /api/health');

  // 2) 未带令牌应 401
  const unauthorized = await request(port, 'GET', '/api/sessions');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.json.error.code, 'AUTH_REQUIRED');
  pass('未带令牌请求被拒（AUTH_REQUIRED）');

  // 3) 本机取配对码
  const pairingCode = await request(port, 'GET', '/api/pairing-code');
  assert.equal(pairingCode.status, 200);
  assert.match(pairingCode.json.code, /^\d{6}$/);
  pass('GET /api/pairing-code');

  // 4) 配对换令牌
  const paired = await request(port, 'POST', '/api/pair', { body: { code: pairingCode.json.code, clientName: '冒烟测试' } });
  assert.equal(paired.status, 200);
  assert.ok(paired.json.token.startsWith('dsb_'));
  const token = paired.json.token;
  pass('POST /api/pair 换到令牌');

  // 5) 配对码一次性
  const reused = await request(port, 'POST', '/api/pair', { body: { code: pairingCode.json.code } });
  assert.equal(reused.status, 403);
  assert.equal(reused.json.error.code, 'PAIRING_CODE_INVALID');
  pass('配对码一次性（重复使用被拒）');

  // 6) 会话列表（含标题）
  const sessions = await request(port, 'GET', '/api/sessions', { token });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.json.items.length, 3);
  const sessionA = sessions.json.items.find((item) => item.sessionId === SESSION_A);
  assert.ok(sessionA !== undefined);
  assert.equal(sessionA.title, '打招呼');
  pass('GET /api/sessions（标题已补全）');

  // 6b) v3.5 §3.1：preview / lastRole（启动批量补齐后台跑，轮询等它落库）
  let previewA = null;
  let previewC = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const list = await request(port, 'GET', '/api/sessions', { token });
    previewA = list.json.items.find((item) => item.sessionId === SESSION_A) ?? null;
    previewC = list.json.items.find((item) => item.sessionId === SESSION_C) ?? null;
    if (previewA !== null && previewA.preview.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(previewA !== null, '会话列表应包含会话 A');
  assert.equal(previewA.preview, '你好，有什么可以帮你的？', '预览应是最后一条 assistant 消息');
  assert.equal(previewA.lastRole, 'assistant');
  assert.ok(previewC !== null, '会话列表应包含会话 C');
  assert.equal(previewC.preview, '', '空会话预览应为空串');
  assert.equal(previewC.lastRole, '', '空会话 lastRole 应为空串');
  pass('GET /api/sessions preview（启动批量补齐 + 空会话空串）');

  // 7) 单个会话
  const one = await request(port, 'GET', `/api/sessions/${SESSION_A}`, { token });
  assert.equal(one.status, 200);
  assert.equal(one.json.messageCount, 2);
  assert.equal(one.json.meta.preset, 'workspace-write');
  pass('GET /api/sessions/:id');

  // 8) 404 映射
  const missing = await request(port, 'GET', '/api/sessions/session-nope', { token });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'SESSION_NOT_FOUND');
  pass('会话不存在 → SESSION_NOT_FOUND(404)');

  // 9) 历史分页
  const history = await request(port, 'GET', `/api/sessions/${SESSION_A}/messages?turns=5`, { token });
  assert.equal(history.status, 200);
  assert.equal(history.json.messages.length, 2);
  assert.equal(history.json.messages[0].role, 'user');
  assert.equal(history.json.messages[1].role, 'assistant');
  pass('GET /api/sessions/:id/messages（按 turn 分页）');

  // 10) 新建会话
  const created = await request(port, 'POST', '/api/sessions', { token, body: { cwd: 'E:\\work', title: '新会话' } });
  assert.equal(created.status, 200);
  assert.ok(created.json.sessionId.startsWith('session-new-'));
  pass('POST /api/sessions');

  // 11) 发消息（202）
  const sent = await request(port, 'POST', `/api/sessions/${SESSION_A}/messages`, {
    token,
    body: { text: '再问一句', clientMessageId: 'cm-1', requestId: 'req-1' },
  });
  assert.equal(sent.status, 202);
  assert.equal(sent.json.accepted, true);
  assert.equal(ctx.__services.sessionController.lastPrompt.content[0].text, '再问一句');
  pass('POST /api/sessions/:id/messages（走 sessionController.prompt）');

  // 12) 停止
  const stopped = await request(port, 'POST', `/api/sessions/${SESSION_A}/stop`, { token });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.accepted, true);
  pass('POST /api/sessions/:id/stop');

  // 13) 模型目录
  const models = await request(port, 'GET', '/api/models', { token });
  assert.equal(models.status, 200);
  assert.equal(models.json.groups.length, 1);
  assert.equal(models.json.groups[0].models[0].id, 'x/y');
  assert.equal(models.json.current.model, 'x/y');
  pass('GET /api/models');

  // 14) 改默认模型
  const putModel = await request(port, 'PUT', '/api/settings/model', {
    token,
    body: { provider: 'magpie', model: 'a/b', reasoningEffort: 'low' },
  });
  assert.equal(putModel.status, 200);
  assert.equal(putModel.json.selection.model, 'a/b');
  pass('PUT /api/settings/model');

  // 15) 重命名 / 归档 / 置顶
  const renamed = await request(port, 'PATCH', `/api/sessions/${SESSION_A}`, { token, body: { title: '改名了' } });
  assert.equal(renamed.status, 200);
  const pinned = await request(port, 'PATCH', `/api/sessions/${SESSION_A}`, { token, body: { pinned: true } });
  assert.equal(pinned.status, 200);
  assert.deepEqual(pinned.json.pinnedSessionIds, [SESSION_A]);
  const archived = await request(port, 'DELETE', `/api/sessions/${SESSION_B}`, { token });
  assert.equal(archived.status, 200);
  pass('PATCH / DELETE 会话（重命名/置顶/归档）');

  // 16) WS：hello + subscribe + 事件推送 + send + stop
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const hello = await waitFor(ws, (frame) => frame.type === 'hello');
  assert.equal(hello.payload.bridgeVersion, BRIDGE_VERSION);
  assert.equal(hello.payload.contractVersion, 3);
  pass('WS hello');

  ws.send(JSON.stringify({ type: 'subscribe', sessionId: SESSION_A }));
  await waitFor(ws, (frame) => frame.type === 'subscribed');

  const pushed = waitFor(ws, (frame) => frame.type === 'message.created');
  ctx.__emit('session/event', { id: SESSION_A }, {
    type: 'user/message',
    seq: 20,
    time: Date.now(),
    data: { role: 'user', id: 'u2', content: [{ type: 'text', text: '实时推送' }] },
  });
  const pushedFrame = await pushed;
  assert.equal(pushedFrame.sessionId, SESSION_A);
  assert.equal(pushedFrame.payload.text, '实时推送');
  pass('WS 实时事件推送（session/event）');

  // 只推订阅的会话
  const otherSession = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 300);
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'));
      if (frame.sessionId === SESSION_B) {
        clearTimeout(timer);
        resolve(frame);
      }
    });
  });
  ctx.__emit('session/event', { id: SESSION_B }, {
    type: 'user/message',
    seq: 21,
    time: Date.now(),
    data: { role: 'user', id: 'u3', content: [{ type: 'text', text: '别的会话' }] },
  });
  assert.equal(await otherSession, null, '不应推送未订阅会话的事件');
  pass('WS 会话过滤');

  // 16b) v3.5 §3.1：message.created 事件实时更新预览
  //（假 ctx 没有 workspaceController.follow，归档集合为空 → B 仍在主列表里）
  let liveA = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const list = await request(port, 'GET', '/api/sessions', { token });
    liveA = list.json.items.find((item) => item.sessionId === SESSION_A) ?? null;
    if (liveA !== null && liveA.preview === '实时推送' && liveA.lastRole === 'user') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(liveA !== null, '主列表应包含会话 A');
  assert.equal(liveA.preview, '实时推送', '预览应随 message.created 实时更新');
  assert.equal(liveA.lastRole, 'user');
  const liveList = await request(port, 'GET', '/api/sessions', { token });
  const liveB = liveList.json.items.find((item) => item.sessionId === SESSION_B);
  assert.ok(liveB !== undefined, '会话列表应包含会话 B');
  assert.equal(liveB.preview, '别的会话', '未订阅/未预热会话的预览也应被事件更新');
  assert.equal(liveB.lastRole, 'user');
  pass('会话预览随 message.created 实时更新');

  // 助手流式增量
  const streamFrame = waitFor(ws, (frame) => frame.type === 'assistant.stream');
  ctx.__emit('agent/assistant-stream', {
    agent: { id: SESSION_A },
    frame: { type: 'chunk', attemptId: 'att-1', revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: '流式' } },
  });
  const streamed = await streamFrame;
  assert.equal(streamed.payload.frame.chunk.text, '流式');
  pass('WS 助手流式增量（agent/assistant-stream）');

  // WS send
  const accepted = waitFor(ws, (frame) => frame.type === 'send.accepted');
  ws.send(JSON.stringify({ type: 'send', sessionId: SESSION_A, text: '从WS发', clientMessageId: 'cm-ws' }));
  const acceptedFrame = await accepted;
  assert.equal(acceptedFrame.payload.clientMessageId, 'cm-ws');
  assert.equal(ctx.__services.sessionController.lastPrompt.content[0].text, '从WS发');
  pass('WS send → sessionController.prompt');

  // WS sync 补拉
  const cursorFrame = waitFor(ws, (frame) => frame.type === 'sync.cursor' || frame.type === 'sync.invalidated');
  ws.send(JSON.stringify({ type: 'sync', cursor: 0 }));
  await cursorFrame;
  pass('WS sync 补拉');

  ws.close();

  // 17) 图片附件（二进制响应）
  // 造一个最小 PNG 放进 $DSH_HOME/attachments/v1/objects/<前2位>/<64 位>
  const pngBytes = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000101ff5f5b1f0000000049454e44ae426082',
    'hex',
  );
  const attachmentHex = crypto.createHash('sha256').update(pngBytes).digest('hex');
  const attachmentHome = mkdtempSync(join(tmpdir(), 'dsh-bridge-att-'));
  const objectDir = join(attachmentHome, 'attachments', 'v1', 'objects', attachmentHex.slice(0, 2));
  mkdirSync(objectDir, { recursive: true });
  writeFileSync(join(objectDir, attachmentHex), pngBytes);
  const previousAttachmentHome = process.env.DSH_HOME;
  process.env.DSH_HOME = attachmentHome;
  const imageResponse = await fetch(`http://127.0.0.1:${port}/api/attachments/sha256%3A${attachmentHex}`, {
    headers: { Authorization: `Bearer ${paired.json.token}` },
  });
  const imageBody = Buffer.from(await imageResponse.arrayBuffer());
  assert.equal(imageResponse.status, 200, '图片应返回 200');
  assert.equal(imageResponse.headers.get('content-type'), 'image/png', '图片 Content-Type 应为 image/png');
  assert.equal(imageBody.length, pngBytes.length, '图片字节数应一致');
  assert.ok(imageBody.equals(pngBytes), '图片字节内容应一致');
  // ?token= 查询参数鉴权（手机 Image/Video 组件带不了 Authorization 头）
  const queryTokenImage = await fetch(`http://127.0.0.1:${port}/api/attachments/sha256%3A${attachmentHex}?token=${encodeURIComponent(paired.json.token)}`);
  assert.equal(queryTokenImage.status, 200, '?token= 查询参数应通过鉴权');
  assert.ok(Buffer.from(await queryTokenImage.arrayBuffer()).equals(pngBytes), '?token= 取到的图片字节应一致');
  const missingImage = await request(port, 'GET', `/api/attachments/sha256:${'0'.repeat(64)}`, { token: paired.json.token });
  assert.equal(missingImage.status, 404, '不存在的附件应返回 404');
  assert.equal(missingImage.json.error.code, 'ATTACHMENT_NOT_FOUND', '不存在的附件应报 ATTACHMENT_NOT_FOUND');
  const badId = await request(port, 'GET', '/api/attachments/not-a-hash', { token: paired.json.token });
  assert.equal(badId.json.error.code, 'INVALID_PARAM', '非法附件 ID 应报 INVALID_PARAM');
  if (previousAttachmentHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousAttachmentHome;
  pass('GET /api/attachments/:id 二进制图片');

  // 17b) 媒体文件（AI 生成视频）二进制响应
  const mediaBytes = Buffer.from('00000018667479706d703432', 'hex');
  const mediaName = 'smoke-clip.mp4';
  const mediaHome = mkdtempSync(join(tmpdir(), 'dsh-bridge-media-'));
  const mediaDir = join(mediaHome, 'dsh-imagegen', 'videos', 'files');
  mkdirSync(mediaDir, { recursive: true });
  writeFileSync(join(mediaDir, mediaName), mediaBytes);
  const previousMediaHome = process.env.DSH_HOME;
  process.env.DSH_HOME = mediaHome;
  const mediaResponse = await fetch(`http://127.0.0.1:${port}/api/media/${mediaName}`, {
    headers: { Authorization: `Bearer ${paired.json.token}` },
  });
  const mediaBody = Buffer.from(await mediaResponse.arrayBuffer());
  assert.equal(mediaResponse.status, 200, '视频应返回 200');
  assert.equal(mediaResponse.headers.get('content-type'), 'video/mp4', '视频 Content-Type 应为 video/mp4');
  assert.ok(mediaBody.equals(mediaBytes), '视频字节内容应一致');
  const missingMedia = await request(port, 'GET', '/api/media/nope.mp4', { token: paired.json.token });
  assert.equal(missingMedia.status, 404, '不存在的媒体应返回 404');
  assert.equal(missingMedia.json.error.code, 'MEDIA_NOT_FOUND', '不存在的媒体应报 MEDIA_NOT_FOUND');
  const traversal = await request(port, 'GET', '/api/media/..%2F..%2Fsecret.txt', { token: paired.json.token });
  assert.equal(traversal.json.error.code, 'INVALID_PARAM', '路径穿越应报 INVALID_PARAM');
  const rangeResponse = await fetch(`http://127.0.0.1:${port}/api/media/${mediaName}`, {
    headers: { Authorization: `Bearer ${paired.json.token}`, Range: 'bytes=0-3' },
  });
  const rangeBody = Buffer.from(await rangeResponse.arrayBuffer());
  assert.equal(rangeResponse.status, 206, 'Range 请求应返回 206');
  assert.equal(rangeBody.length, 4, 'Range 应只返回请求区间字节');
  assert.ok(rangeBody.equals(mediaBytes.subarray(0, 4)), 'Range 字节应与源文件一致');
  if (previousMediaHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousMediaHome;
  pass('GET /api/media/:name 二进制视频');

  // 17b2) v3.7：会话工作区里的媒体（media:v1.<base64url(绝对路径)>）
  // 远程会话把视频交付到工作区（`deliver/demo.mp4`），既不在 dsh-imagegen 目录下、
  // 也不是纯文件名 —— 老的白名单写法永远转不出字节，这正是「手机收不到视频」的直接原因。
  const localMediaHome = mkdtempSync(join(tmpdir(), 'dsh-bridge-local-media-'));
  const previousLocalMediaHome = process.env.DSH_HOME;
  process.env.DSH_HOME = localMediaHome;
  // 白名单根之一是 $DSH_HOME/dsh-imagegen，先建出来（真实环境由生图插件落盘）
  mkdirSync(join(localMediaHome, 'dsh-imagegen'), { recursive: true });
  // 另一个白名单根：临时目录冒充「远程电脑上的会话工作区」
  const workspaceDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-workspace-'));
  const originalWorkspaceList = ctx.__services.workspaceRegistry.list;
  ctx.__services.workspaceRegistry.list = async () => [
    { workspaceId: 'w-work', path: workspaceDir, title: '交付' },
  ];
  const deliveredDir = join(workspaceDir, 'deliver');
  mkdirSync(deliveredDir, { recursive: true });
  const deliveredFile = join(deliveredDir, 'demo.mp4');
  writeFileSync(deliveredFile, mediaBytes);
  /** 与 adapter/project.js 的 encodeLocalMediaId 保持同一约定：media:v1.<base64url> */
  const encodeMediaId = (absolute) => `media:v1.${Buffer.from(absolute, 'utf8').toString('base64url')}`;
  const deliveredId = encodeMediaId(deliveredFile);
  const mediaUrlOf = (id) => `http://127.0.0.1:${port}/api/media/${encodeURIComponent(id)}?token=${encodeURIComponent(paired.json.token)}`;

  const deliveredResponse = await fetch(mediaUrlOf(deliveredId));
  const deliveredBody = Buffer.from(await deliveredResponse.arrayBuffer());
  assert.equal(deliveredResponse.status, 200, '工作区内的视频应返回 200');
  assert.equal(deliveredResponse.headers.get('content-type'), 'video/mp4', '工作区视频 Content-Type 应为 video/mp4');
  assert.ok(deliveredBody.equals(mediaBytes), '工作区视频字节应一致');

  // 鸿蒙 1.0.x 的 ApiClient.mediaSrcOf 会剥掉 `media:` 前缀，桥实际收到 `v1.<base64url>`
  const strippedResponse = await fetch(mediaUrlOf(deliveredId.slice('media:'.length)));
  assert.equal(strippedResponse.status, 200, '剥掉 media: 前缀的 v1 形态也应可用');
  assert.ok(Buffer.from(await strippedResponse.arrayBuffer()).equals(mediaBytes), '剥前缀形态字节应一致');

  const deliveredRange = await fetch(mediaUrlOf(deliveredId), { headers: { Range: 'bytes=2-5' } });
  const deliveredRangeBody = Buffer.from(await deliveredRange.arrayBuffer());
  assert.equal(deliveredRange.status, 206, '工作区视频的 Range 请求应返回 206');
  assert.ok(deliveredRangeBody.equals(mediaBytes.subarray(2, 6)), 'Range 字节应与源文件一致');

  // 白名单外：路径本身合法，但不是任何会话工作区 / 生成目录 → 404，不透露存在性
  const outsideDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-outside-'));
  const outsideFile = join(outsideDir, 'secret.mp4');
  writeFileSync(outsideFile, mediaBytes);
  const outsideResponse = await request(port, 'GET', `/api/media/${encodeURIComponent(encodeMediaId(outsideFile))}`, { token });
  assert.equal(outsideResponse.status, 404, '白名单外的媒体应返回 404');
  assert.equal(outsideResponse.json.error.code, 'MEDIA_NOT_FOUND', '白名单外的媒体应报 MEDIA_NOT_FOUND');
  // 穿越写法同样出不去（realpath 归一化后仍在白名单外）
  const outsideName = outsideDir.split(/[\\/]/).pop();
  const traversalId = encodeMediaId(`${workspaceDir}/../${outsideName}/secret.mp4`);
  const traversalResponse = await request(port, 'GET', `/api/media/${encodeURIComponent(traversalId)}`, { token });
  assert.equal(traversalResponse.json.error.code, 'MEDIA_NOT_FOUND', '白名单内起手的穿越路径仍应被拒');

  // 非媒体扩展名：防止把密钥/配置文件当媒体转出
  const textFile = join(workspaceDir, 'notes.txt');
  writeFileSync(textFile, 'not media');
  const textResponse = await request(port, 'GET', `/api/media/${encodeURIComponent(encodeMediaId(textFile))}`, { token });
  assert.equal(textResponse.status, 400, '非媒体扩展名应返回 400');
  assert.equal(textResponse.json.error.code, 'INVALID_PARAM', '非媒体扩展名应报 INVALID_PARAM');

  // 相对路径：v1 只接受绝对路径（相对路径必须由投影层按 cwd 展开）
  const relativeId = `media:v1.${Buffer.from('deliver/demo.mp4', 'utf8').toString('base64url')}`;
  const relativeResponse = await request(port, 'GET', `/api/media/${encodeURIComponent(relativeId)}`, { token });
  assert.equal(relativeResponse.status, 400, 'v1 相对路径应返回 400');
  assert.equal(relativeResponse.json.error.code, 'INVALID_PARAM', 'v1 相对路径应报 INVALID_PARAM');

  // 文件不存在：404
  const missingLocal = await request(port, 'GET', `/api/media/${encodeURIComponent(encodeMediaId(join(workspaceDir, 'nope.mp4')))}`, { token });
  assert.equal(missingLocal.json.error.code, 'MEDIA_NOT_FOUND', '不存在的本地媒体应报 MEDIA_NOT_FOUND');

  ctx.__services.workspaceRegistry.list = originalWorkspaceList;
  if (previousLocalMediaHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousLocalMediaHome;
  pass('GET /api/media v1（工作区视频 / 剥前缀形态 / Range / 越权 404 / 非媒体 400）');

  // 17c) 通用文件附件（file 块）二进制响应
  const fileBytes = Buffer.from('DSH-FILE-ATTACHMENT-PAYLOAD', 'utf8');
  const fileHex = crypto.createHash('sha256').update(fileBytes).digest('hex');
  const fileHome = mkdtempSync(join(tmpdir(), 'dsh-bridge-file-'));
  const fileObjectDir = join(fileHome, 'attachments', 'v1', 'file-objects', fileHex.slice(0, 2));
  mkdirSync(fileObjectDir, { recursive: true });
  writeFileSync(join(fileObjectDir, fileHex), fileBytes);
  const previousFileHome = process.env.DSH_HOME;
  process.env.DSH_HOME = fileHome;
  const fileResponse = await fetch(`http://127.0.0.1:${port}/api/files/sha256%3A${fileHex}`, {
    headers: { Authorization: `Bearer ${paired.json.token}` },
  });
  const fileBody = Buffer.from(await fileResponse.arrayBuffer());
  assert.equal(fileResponse.status, 200, '文件附件应返回 200');
  assert.equal(fileResponse.headers.get('content-type'), 'application/octet-stream', '文件 Content-Type 应为 octet-stream');
  assert.ok(fileBody.equals(fileBytes), '文件字节内容应一致');
  const missingFile = await request(port, 'GET', `/api/files/sha256:${'f'.repeat(64)}`, { token: paired.json.token });
  assert.equal(missingFile.status, 404, '不存在的文件应返回 404');
  assert.equal(missingFile.json.error.code, 'ATTACHMENT_NOT_FOUND', '不存在的文件应报 ATTACHMENT_NOT_FOUND');
  if (previousFileHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousFileHome;
  pass('GET /api/files/:id 二进制文件');

  // 17d) 投影层：生成类工具的媒体引用 → 可渲染块，本机路径从正文剥离
  const imageResultText = JSON.stringify({
    task_id: 't1',
    status: 'completed',
    message: 'Generation completed.',
    files: ['C:\\Users\\x\\.dsh\\dsh-imagegen\\images\\abc-0.png'],
    images: [{
      attachment_id: `sha256:${'a'.repeat(64)}`,
      media_type: 'image/png',
      bytes: 1234,
      width: 1024,
      height: 1024,
      name: 'abc-1.png',
    }],
  });
  const videoResultText = JSON.stringify({
    task_id: 't2',
    status: 'completed',
    message: 'Video generation completed.',
    videos: [{ url: '/api/dsh-imagegen/video/file/clip.mp4', mime: 'video/mp4', duration: 5 }],
  });
  const projected = projectEvents([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    {
      type: 'tool/result',
      seq: 2,
      time: 2,
      data: { turn: 1, step: 1, callId: 'c1', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: imageResultText }] } },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: 3,
      data: { turn: 1, step: 1, callId: 'c2', message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: videoResultText }] } },
    },
    {
      type: 'assistant/message',
      seq: 4,
      time: 4,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '![生成图片](C:\\Users\\x\\.dsh\\dsh-imagegen\\images\\abc-0.png)\n\n生成完成。' }],
        },
      },
    },
  ]);
  const imageTool = projected.messages.find((m) => m.seq === 2);
  const imageBlock = imageTool.blocks.find((b) => b.type === 'image');
  assert.equal(imageBlock.attachmentId, `sha256:${'a'.repeat(64)}`, '生图结果应补出 image 块');
  assert.equal(imageTool.text.includes('C:\\Users'), false, '工具正文不应带本机路径');
  assert.equal(imageTool.text.includes('task_id'), false, '工具正文不应保留原始 JSON');
  assert.ok(imageTool.text.startsWith('Generation completed.'), '工具正文应换成友好 message');
  const videoTool = projected.messages.find((m) => m.seq === 3);
  const videoBlock = videoTool.blocks.find((b) => b.type === 'video');
  assert.equal(videoBlock.attachmentId, 'media:clip.mp4', '生视频结果应补出 video 块');
  assert.equal(videoBlock.mediaType, 'video/mp4');
  const assistant = projected.messages.find((m) => m.seq === 4);
  assert.equal(assistant.text.includes('C:\\Users'), false, '助手正文不应带本机路径');
  assert.ok(assistant.text.includes('生成完成'), '助手正文其余内容应保留');
  pass('生成类工具媒体投影（图片/视频块 + 剥离本机路径）');

  // 17e) v3.7：非 JSON 交付形态（present 工具 + 助手正文 markdown）+ 媒体块提升
  // 实测远程会话：视频由 present 工具逐行 `Presented <绝对路径>` 交付，
  // 助手正文用 markdown 表格链接 `[demo](<deliver/demo.mp4>)` 给出相对路径。
  // 老实现只认 JSON，两条路径都抽不出媒体块 —— 手机端因此什么都收不到。
  const remoteCwd = 'D:\\work';
  const presentedPath = `${remoteCwd}\\deliver\\demo.mp4`;
  const relativeTarget = 'deliver/demo.mp4';
  const expectedAbsolute = 'D:\\work\\deliver\\demo.mp4';
  const expectedVideoId = `media:v1.${Buffer.from(expectedAbsolute, 'utf8').toString('base64url')}`;
  const delivered = projectEvents([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    {
      type: 'tool/result',
      seq: 2,
      time: 2,
      data: {
        turn: 1,
        step: 1,
        callId: 'c1',
        message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: `Presented ${presentedPath}` }] },
      },
    },
    {
      type: 'assistant/message',
      seq: 3,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `今日交付：\n\n| 视频 | 时长 |\n| --- | --- |\n| [demo](<${relativeTarget}>) | 30s |` }],
        },
      },
    },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'stop' } } },
  ], { cwd: remoteCwd });

  const presentedTool = delivered.messages.find((m) => m.seq === 2);
  const presentedBlock = presentedTool.blocks.find((b) => b.type === 'video');
  assert.ok(presentedBlock !== undefined, 'present 工具结果应抽成 video 块');
  assert.equal(presentedBlock.attachmentId, expectedVideoId, 'Presented 绝对路径应编码成 media:v1.<base64url>');
  assert.equal(presentedBlock.name, 'demo.mp4', '媒体块应带可读文件名');
  assert.equal(presentedBlock.mediaType, 'video/mp4');
  assert.equal(presentedTool.text.includes('Presented'), false, 'Presented 行应降级为文件名，不再暴露路径');
  assert.equal(presentedTool.text, 'demo.mp4', 'Presented 行只留文件名');

  const deliveredAssistant = delivered.messages.find((m) => m.seq === 3);
  const markdownBlock = deliveredAssistant.blocks.find((b) => b.type === 'video');
  assert.ok(markdownBlock !== undefined, '助手正文的 markdown 链接应抽成 video 块');
  assert.equal(markdownBlock.attachmentId, expectedVideoId, '相对路径应按 cwd 展开后编码');
  assert.equal(deliveredAssistant.text.includes('deliver/'), false, '正文里的媒体路径应降级为链接文字');
  assert.ok(deliveredAssistant.text.includes('demo'), '正文应保留可读的链接文字');
  assert.ok(deliveredAssistant.text.includes('30s'), '正文表格其余内容应保留');
  // 工具行的媒体块要提升到同 turn 的助手消息上：鸿蒙端工具行不渲染 blocks
  assert.ok(
    deliveredAssistant.blocks.some((b) => b.type === 'video' && b.attachmentId === expectedVideoId),
    '媒体块应同时挂在同 turn 助手消息上（手机端工具行不渲染 blocks）',
  );

  // 拿不到 cwd 时不得瞎猜相对路径（宁可不给）
  const noCwd = projectEvents([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 2,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `[E9](${relativeTarget})` }] } },
    },
  ]);
  const noCwdAssistant = noCwd.messages.find((m) => m.seq === 2);
  assert.equal(
    noCwdAssistant.blocks.some((b) => b.type === 'video'),
    false,
    '没有 cwd 时相对路径不应臆造成媒体块',
  );
  // 外链不能被当成本机媒体
  const external = projectEvents([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 2,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '[示例](https://example.com/a.mp4)' }] } },
    },
  ], { cwd: remoteCwd });
  const externalAssistant = external.messages.find((m) => m.seq === 2);
  assert.equal(externalAssistant.blocks.some((b) => b.type === 'video'), false, 'http(s) 外链不应变成媒体块');
  assert.ok(externalAssistant.text.includes('https://example.com/a.mp4'), '外链正文应原样保留');
  pass('非 JSON 交付投影（Presented 行 / markdown 相对路径 / 提升到助手消息 / 无 cwd 不外推）');

  // 18) v3.1：POST /api/uploads 上传（幂等 / 尺寸解析 / 超限 413）
  const uploadHome = mkdtempSync(join(tmpdir(), 'dsh-bridge-upload-'));
  const previousUploadHome = process.env.DSH_HOME;
  process.env.DSH_HOME = uploadHome;

  const upload = async (bytes, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        ...headers,
      },
      body: bytes,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  };

  const pngUploadName = encodeURIComponent('截图 测试.png');
  const uploaded = await upload(pngBytes, { 'X-File-Name': pngUploadName, 'X-Media-Type': 'image/png' });
  assert.equal(uploaded.status, 200, '上传图片应返回 200');
  assert.ok(uploaded.json.attachmentId.startsWith('sha256:'), 'attachmentId 应为 sha256 前缀');
  assert.equal(uploaded.json.attachmentId, `sha256:${attachmentHex}`, 'attachmentId 应等于内容 sha256');
  assert.equal(uploaded.json.mediaType, 'image/png');
  assert.equal(uploaded.json.name, '截图 测试.png', 'X-File-Name 应解码中文与空格');
  assert.equal(uploaded.json.bytes, pngBytes.length);
  assert.equal(uploaded.json.width, 1, 'PNG 魔数应解析出宽');
  assert.equal(uploaded.json.height, 1, 'PNG 魔数应解析出高');
  assert.equal(uploaded.json.kind, 'image');
  const uploadedObject = join(uploadHome, 'attachments', 'v1', 'objects', attachmentHex.slice(0, 2), attachmentHex);
  assert.ok(existsSync(uploadedObject), '图片对象应写入 attachments/v1/objects/<前2位>/<hex>');
  pass('POST /api/uploads 上传 PNG（对象落盘 + 中文文件名解码 + 尺寸解析）');

  // 幂等：同字节重传直接复用对象
  const reuploaded = await upload(pngBytes, { 'X-File-Name': pngUploadName, 'X-Media-Type': 'image/png' });
  assert.equal(reuploaded.status, 200);
  assert.equal(reuploaded.json.attachmentId, uploaded.json.attachmentId, '同字节重传应得到同一 attachmentId');
  const shardFiles = readdirSync(join(uploadHome, 'attachments', 'v1', 'objects', attachmentHex.slice(0, 2)));
  assert.equal(shardFiles.length, 1, '同对象不应重复落盘');
  pass('POST /api/uploads 幂等（同 sha256 复用已有对象）');

  // JPEG 魔数尺寸解析（手工构造 SOF0：7x5）
  const jpegBytes = Buffer.from(
    'ffd8' + 'ffe000104a46494600010100000100010000' + 'ffc00011080005000703011100021101031101',
    'hex',
  );
  const jpegUpload = await upload(jpegBytes, { 'X-File-Name': 'photo.jpg', 'X-Media-Type': 'image/jpeg' });
  assert.equal(jpegUpload.status, 200);
  assert.equal(jpegUpload.json.mediaType, 'image/jpeg');
  assert.equal(jpegUpload.json.width, 7, 'JPEG SOF0 应解析出宽');
  assert.equal(jpegUpload.json.height, 5, 'JPEG SOF0 应解析出高');
  assert.equal(jpegUpload.json.kind, 'image');
  pass('POST /api/uploads JPEG 尺寸魔数解析');

  // 非图片 → file-objects，kind=file，宽高 0
  const pdfBytes = Buffer.from('%PDF-1.4 smoke', 'utf8');
  const pdfUpload = await upload(pdfBytes, { 'X-File-Name': 'doc.pdf', 'X-Media-Type': 'application/pdf' });
  assert.equal(pdfUpload.status, 200);
  assert.equal(pdfUpload.json.kind, 'file');
  assert.equal(pdfUpload.json.mediaType, 'application/pdf');
  assert.equal(pdfUpload.json.width, 0);
  assert.equal(pdfUpload.json.height, 0);
  const pdfHex = pdfUpload.json.attachmentId.slice('sha256:'.length);
  assert.ok(existsSync(join(uploadHome, 'attachments', 'v1', 'file-objects', pdfHex.slice(0, 2), pdfHex)), '文件对象应写入 file-objects');
  pass('POST /api/uploads 非图片对象（file-objects + kind=file）');

  // 超限 413：Content-Length 预检（不等真实传完 200MB）
  const oversize = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/uploads',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(MAX_UPLOAD_BYTES + 1),
          'X-File-Name': 'big.bin',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = undefined;
          }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', reject);
    req.end('x');
  });
  assert.equal(oversize.status, 413, '超过 200MB 应返回 413');
  assert.equal(oversize.body.error.code, 'INVALID_PARAM');
  assert.ok(oversize.body.error.message.includes('200 MB'), '413 message 应说明大小上限');
  pass('POST /api/uploads 超限返回 413 INVALID_PARAM');

  // 19) v3.1：带附件发消息（附件块拼在 text 之前）
  const sentImage = await request(port, 'POST', `/api/sessions/${SESSION_A}/messages`, {
    token,
    body: {
      text: '看看这张图',
      attachments: [{
        attachmentId: uploaded.json.attachmentId,
        name: '截图.png',
        mediaType: 'image/png',
        bytes: pngBytes.length,
      }],
    },
  });
  assert.equal(sentImage.status, 202);
  const imagePrompt = ctx.__services.sessionController.lastPrompt;
  assert.equal(imagePrompt.content.length, 2);
  assert.equal(imagePrompt.content[0].type, 'image', '图片块应排在 text 之前');
  assert.equal(imagePrompt.content[0].attachment.attachmentId, uploaded.json.attachmentId);
  assert.equal(imagePrompt.content[0].attachment.mediaType, 'image/png');
  assert.equal(imagePrompt.content[0].attachment.width, 1);
  assert.equal(imagePrompt.content[0].attachment.height, 1);
  assert.equal(imagePrompt.content[0].attachment.name, '截图.png');
  assert.equal(imagePrompt.content[1].type, 'text');
  assert.equal(imagePrompt.content[1].text, '看看这张图');
  pass('REST 带图片附件发消息（image attachment 块 + text 顺序）');

  const sentFile = await request(port, 'POST', `/api/sessions/${SESSION_A}/messages`, {
    token,
    body: {
      text: '这是文档',
      attachments: [{
        attachmentId: pdfUpload.json.attachmentId,
        name: '文档.pdf',
        mediaType: 'application/pdf',
        bytes: pdfBytes.length,
      }],
    },
  });
  assert.equal(sentFile.status, 202);
  const filePrompt = ctx.__services.sessionController.lastPrompt;
  assert.equal(filePrompt.content.length, 2);
  assert.equal(filePrompt.content[0].type, 'file', '文件应映射为 file 块（经 fileUploads 暂存收据）');
  assert.ok(filePrompt.content[0].receiptId.startsWith('receipt-'), 'file 块应携带 DSH 暂存收据');
  const staged = ctx.__services.__staged;
  const stagedEntry = staged.find((item) => item.name === '文档.pdf');
  assert.ok(stagedEntry !== undefined, '应调用 fileUploads.uploadStream 暂存文件');
  assert.equal(stagedEntry.bytes, pdfBytes.length);
  assert.equal(stagedEntry.sessionId, SESSION_A);
  assert.equal(filePrompt.content[1].type, 'text');
  pass('REST 带文件附件发消息（fileUploads 暂存收据）');

  // 未上传过的 attachmentId → 404
  const unknownAttachment = await request(port, 'POST', `/api/sessions/${SESSION_A}/messages`, {
    token,
    body: {
      text: '带一个没上传过的附件',
      attachments: [{ attachmentId: `sha256:${'0'.repeat(64)}`, name: 'ghost.png', mediaType: 'image/png', bytes: 1 }],
    },
  });
  assert.equal(unknownAttachment.status, 404, '未上传的 attachmentId 应返回 404');
  assert.equal(unknownAttachment.json.error.code, 'INVALID_PARAM');
  assert.ok(unknownAttachment.json.error.message.includes('上传'), '错误信息应提示先上传');
  pass('未上传过的 attachmentId → 404 INVALID_PARAM');

  // 超过 9 个附件 → 400
  const tooMany = await request(port, 'POST', `/api/sessions/${SESSION_A}/messages`, {
    token,
    body: {
      text: '太多附件',
      attachments: Array.from({ length: 10 }, () => ({
        attachmentId: `sha256:${'a'.repeat(64)}`,
        name: 'x.png',
        mediaType: 'image/png',
        bytes: 1,
      })),
    },
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.error.code, 'INVALID_PARAM');
  pass('单条消息超过 9 个附件 → INVALID_PARAM');

  // 纯附件消息（text 为空）也允许，块结构保持附件在前
  const sentImageOnly = await request(port, 'POST', `/api/sessions/${SESSION_A}/messages`, {
    token,
    body: {
      text: '',
      attachments: [{
        attachmentId: uploaded.json.attachmentId,
        name: '截图.png',
        mediaType: 'image/png',
        bytes: pngBytes.length,
      }],
    },
  });
  assert.equal(sentImageOnly.status, 202);
  const imageOnlyPrompt = ctx.__services.sessionController.lastPrompt;
  assert.equal(imageOnlyPrompt.content.length, 1);
  assert.equal(imageOnlyPrompt.content[0].type, 'image');
  pass('纯附件消息（空 text）允许且块结构正确');

  // WS send 载荷同样支持 attachments
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  await waitFor(ws2, (frame) => frame.type === 'hello');
  const wsAccepted = waitFor(ws2, (frame) => frame.type === 'send.accepted');
  ws2.send(JSON.stringify({
    type: 'send',
    sessionId: SESSION_A,
    text: 'WS带图',
    attachments: [{ attachmentId: uploaded.json.attachmentId, name: '截图.png', mediaType: 'image/png', bytes: pngBytes.length }],
  }));
  await wsAccepted;
  const wsPrompt = ctx.__services.sessionController.lastPrompt;
  assert.equal(wsPrompt.content[0].type, 'image', 'WS send 的附件也应映射为 image 块');
  assert.equal(wsPrompt.content[1].text, 'WS带图');
  ws2.close();
  pass('WS send 载荷新增 attachments');

  // 20) v3.1：归档会话删除（purge 降级 + batch-delete 部分成功）
  const purged = await request(port, 'DELETE', `/api/sessions/${SESSION_B}?purge=true`, { token });
  assert.equal(purged.status, 200);
  assert.deepEqual(purged.json.purged, [], 'DSH 无硬删能力，purged 应为空');
  assert.deepEqual(purged.json.archivedFallback, [SESSION_B], '应降级为归档并在 archivedFallback 上报');
  assert.deepEqual(purged.json.failed, []);
  assert.ok(ctx.__services.__archived.includes(SESSION_B), 'purge 应真实调用 workspaceController.archiveSession');
  pass('DELETE ?purge=true 降级归档（archivedFallback 如实上报）');

  const batch = await request(port, 'POST', '/api/sessions/batch-delete', {
    token,
    body: { ids: [SESSION_A, 'session-nope', SESSION_A] },
  });
  assert.equal(batch.status, 200, '批量删除部分成功应返回 200');
  assert.deepEqual(batch.json.purged, []);
  assert.deepEqual(batch.json.archivedFallback, [SESSION_A], '重复 id 应去重');
  assert.equal(batch.json.failed.length, 1);
  assert.equal(batch.json.failed[0].id, 'session-nope');
  assert.equal(batch.json.failed[0].code, 'SESSION_NOT_FOUND');
  assert.ok(typeof batch.json.failed[0].message === 'string' && batch.json.failed[0].message.length > 0);
  pass('POST /api/sessions/batch-delete（部分成功 + 三个数组齐全）');

  const overBatch = await request(port, 'POST', '/api/sessions/batch-delete', {
    token,
    body: { ids: Array.from({ length: 201 }, (_, index) => `session-x${index}`) },
  });
  assert.equal(overBatch.status, 400);
  assert.equal(overBatch.json.error.code, 'INVALID_PARAM');
  pass('batch-delete 超过 200 个 → INVALID_PARAM');

  if (previousUploadHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousUploadHome;

  // 21) v3.1 安全修复：隧道流量（Host: dsh-phone-bridge-tunnel）不得触碰仅本机接口
  // 注：每个请求独立 agent（不复用 keep-alive 连接）——前面的 413 测试故意声明
  // Content-Length 超限但只发 1 字节（非法分帧），服务器销毁该连接，
  // 复用池化死连接会让下一个请求误报 ECONNRESET。
  const rawRequest = (method, pathname, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers,
        agent: new http.Agent({ keepAlive: false }),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

  const tunnelHeaders = { Host: 'dsh-phone-bridge-tunnel' };
  const tunnelPairingCode = await rawRequest('GET', '/api/pairing-code', tunnelHeaders);
  assert.equal(tunnelPairingCode.status, 403, '隧道流量取配对码必须 403');
  assert.equal(tunnelPairingCode.json.error.code, 'ROUTE_LOCAL_ONLY');
  const tunnelPairPage = await rawRequest('GET', '/pair', tunnelHeaders);
  assert.equal(tunnelPairPage.status, 403, '隧道流量打开 /pair 页必须 403');
  const loopbackPairingCode = await rawRequest('GET', '/api/pairing-code', { Host: '127.0.0.1' });
  assert.equal(loopbackPairingCode.status, 200, '本机（普通 Host）取配对码不受影响');
  pass('隧道流量访问仅本机接口 → 403 ROUTE_LOCAL_ONLY（本机不受影响）');

  // /api/pair 隧道可达（合法的外地配对路径）
  const tunnelPair = await rawRequest('POST', '/api/pair', {
    Host: 'dsh-phone-bridge-tunnel',
    'Content-Type': 'application/json',
  }, JSON.stringify({ code: loopbackPairingCode.json.code, clientName: '隧道配对' }));
  assert.equal(tunnelPair.status, 200, '/api/pair 应保持隧道可达');
  assert.ok(tunnelPair.json.token.startsWith('dsb_'));
  pass('/api/pair 隧道可达（防爆破前）');

  // /api/pair 防爆破：同源连续错 20 次 → 429 RATE_LIMITED + retryAfter
  let saw429 = false;
  let saw403AfterFails = false;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const failed = await rawRequest('POST', '/api/pair', {
      Host: '127.0.0.1',
      'Content-Type': 'application/json',
    }, JSON.stringify({ code: '999999' }));
    if (failed.status === 429) {
      saw429 = true;
      assert.equal(failed.json.error.code, 'RATE_LIMITED');
      assert.ok(Number(failed.json.error.retryAfter) > 0, '429 应带 retryAfter');
      break;
    }
    assert.equal(failed.status, 403);
    assert.equal(failed.json.error.code, 'PAIRING_CODE_INVALID');
    saw403AfterFails = true;
  }
  assert.ok(saw403AfterFails, '锁定前应返回 403 PAIRING_CODE_INVALID');
  assert.ok(saw429, '同源连续失败 20 次应触发 429 锁定');
  pass('/api/pair 防爆破（同源连错 20 次 → 429 RATE_LIMITED）');

  // 22) v3.1 §9.5：会话权限模式
  ctx.__services.__liveSessions.set(SESSION_A, {
    id: SESSION_A,
    append(type, data) {
      ctx.__services.__appended.push({ id: this.id, type, data });
    },
  });
  const permission = await request(port, 'GET', `/api/sessions/${SESSION_A}/permission`, { token });
  assert.equal(permission.status, 200);
  assert.equal(permission.json.mode, 'workspace-write', '无旋钮事件时应折算部署默认');
  assert.equal(permission.json.approval, 'every-step');
  pass('GET /api/sessions/:id/permission（默认档 + approval 映射）');

  const putFull = await request(port, 'PUT', `/api/sessions/${SESSION_A}/permission`, {
    token,
    body: { mode: 'full-access' },
  });
  assert.equal(putFull.status, 200);
  assert.equal(putFull.json.mode, 'full-access');
  const presetSwitch = ctx.__services.__appended.find((item) => item.type === 'permission/preset');
  assert.ok(presetSwitch !== undefined, 'full-access 应走 permissionPresets.set（官方预设写路径）');
  assert.equal(presetSwitch.data.preset, 'danger-full-access');
  const afterFull = await request(port, 'GET', `/api/sessions/${SESSION_A}/permission`, { token });
  assert.equal(afterFull.json.mode, 'full-access');
  assert.equal(afterFull.json.approval, 'auto');
  pass('PUT 权限模式 full-access（permissionPresets.set 官方写路径）');

  const putReadOnly = await request(port, 'PUT', `/api/sessions/${SESSION_A}/permission`, {
    token,
    body: { mode: 'read-only' },
  });
  assert.equal(putReadOnly.status, 200);
  assert.equal(putReadOnly.json.mode, 'read-only');
  const sandboxSwitch = ctx.__services.__appended.find((item) => item.type === 'sandbox/mode' && item.data.mode === 'read-only');
  assert.ok(sandboxSwitch !== undefined, 'read-only（默认预设表没有）应直写 sandbox/mode 事件');
  assert.equal(sandboxSwitch.data.mode, 'read-only');
  const afterReadOnly = await request(port, 'GET', `/api/sessions/${SESSION_A}/permission`, { token });
  assert.equal(afterReadOnly.json.mode, 'read-only', '下一次 GET 应读到最后一条 sandbox/mode 旋钮');
  pass('PUT 权限模式 read-only（sandbox/mode 事件直写 + GET 折叠生效）');

  const putBogus = await request(port, 'PUT', `/api/sessions/${SESSION_A}/permission`, {
    token,
    body: { mode: 'bogus' },
  });
  assert.equal(putBogus.status, 400);
  assert.equal(putBogus.json.error.code, 'INVALID_PARAM');
  const permissionMissing = await request(port, 'GET', '/api/sessions/session-nope/permission', { token });
  assert.equal(permissionMissing.status, 404);
  assert.equal(permissionMissing.json.error.code, 'SESSION_NOT_FOUND');
  pass('权限模式参数校验（非法 mode 400 / 会话不存在 404）');

  // 22b) v3.4 §9.6：审批策略可写（approval 单独写 / 组合 patch / 回读一致 / 无效值拒绝）
  const approvalOnly = await request(port, 'PUT', `/api/sessions/${SESSION_A}/permission`, {
    token,
    body: { approval: 'every-step' },
  });
  assert.equal(approvalOnly.status, 200);
  assert.equal(approvalOnly.json.approval, 'every-step');
  assert.equal(approvalOnly.json.mode, undefined, '只传 approval 不应返回/改动 mode');
  const approvalOnlyPolicy = [...ctx.__services.__appended]
    .reverse()
    .find((item) => item.type === 'approval/policy' && item.id === SESSION_A);
  assert.ok(approvalOnlyPolicy !== undefined, 'approval 应以官方 approval/policy 事件落盘');
  assert.equal(approvalOnlyPolicy.data.policy, 'ask', 'every-step ↔ ask');
  const afterApprovalOnly = await request(port, 'GET', `/api/sessions/${SESSION_A}/permission`, { token });
  assert.equal(afterApprovalOnly.json.approval, 'every-step', 'GET 必须回读一致');
  assert.equal(afterApprovalOnly.json.mode, 'read-only', '只写 approval 不动 mode');
  pass('PUT approval 单独写（ask 事件落盘 + mode 不受影响 + GET 回读一致）');

  const comboPatch = await request(port, 'PUT', `/api/sessions/${SESSION_A}/permission`, {
    token,
    body: { mode: 'full-access', approval: 'auto' },
  });
  assert.equal(comboPatch.status, 200);
  assert.equal(comboPatch.json.mode, 'full-access');
  assert.equal(comboPatch.json.approval, 'auto');
  const afterCombo = await request(port, 'GET', `/api/sessions/${SESSION_A}/permission`, { token });
  assert.equal(afterCombo.json.mode, 'full-access');
  assert.equal(afterCombo.json.approval, 'auto');
  pass('PUT mode+approval 组合 patch（两者同时生效）');

  // 组合冲突覆盖：预设自带的 approval 被显式 approval 覆盖（fold 最后一条生效）
  const comboConflict = await request(port, 'PUT', `/api/sessions/${SESSION_A}/permission`, {
    token,
    body: { mode: 'workspace-write', approval: 'auto' },
  });
  assert.equal(comboConflict.status, 200);
  const afterConflict = await request(port, 'GET', `/api/sessions/${SESSION_A}/permission`, { token });
  assert.equal(afterConflict.json.mode, 'workspace-write', '沙盒切到 workspace-write');
  assert.equal(afterConflict.json.approval, 'auto', '预设默认 ask 被显式 auto 覆盖（最后一条 approval/policy 生效）');
  pass('PUT 组合冲突覆盖（预设 approval 被显式 approval 覆盖）');

  const badApproval = await request(port, 'PUT', `/api/sessions/${SESSION_A}/permission`, {
    token,
    body: { approval: 'sometimes' },
  });
  assert.equal(badApproval.status, 400);
  assert.equal(badApproval.json.error.code, 'INVALID_PARAM');
  assert.ok(badApproval.json.error.message.includes('approval'), '错误信息应指向 approval');
  const emptyPermissionPut = await request(port, 'PUT', `/api/sessions/${SESSION_A}/permission`, { token, body: {} });
  assert.equal(emptyPermissionPut.status, 400);
  assert.ok(emptyPermissionPut.json.error.message.includes('至少一项'));
  const missingSessionApproval = await request(port, 'PUT', '/api/sessions/session-nope/permission', {
    token,
    body: { approval: 'auto' },
  });
  assert.equal(missingSessionApproval.status, 404);
  pass('approval 无效值 / 空 body / 会话不存在全部拒绝');


  // 23) /pair 页面（本机可打开）
  const pairPage = await request(port, 'GET', '/pair');
  assert.equal(pairPage.status, 200);
  assert.ok(pairPage.text.includes('配对码'));
  pass('GET /pair 配对页');

  // 24) v3.2 §10 frp：frpc.toml 配置生成 + token 不落日志
  const frpToken = 'vps-secret-token-3.2';
  const frpLogs = [];
  const frpLog = (msg) => frpLogs.push(msg);
  const { toml, proxyName } = buildFrpcConfig({
    serverAddr: '203.0.113.10',
    serverPort: 7000,
    token: frpToken,
    remotePort: 34567,
    useTls: true,
    localPort: 8787,
  });
  assert.equal(proxyName, 'dsh-phone-bridge');
  assert.ok(toml.includes('serverAddr = "203.0.113.10"'));
  assert.ok(toml.includes('serverPort = 7000'));
  assert.ok(toml.includes('auth.method = "token"'));
  assert.ok(toml.includes(`auth.token = "${frpToken}"`), 'token 必须写进 frpc.toml');
  assert.ok(toml.includes('transport.tls.enable = true'));
  assert.ok(toml.includes('localIP = "127.0.0.1"'));
  assert.ok(toml.includes('localPort = 8787'));
  assert.ok(toml.includes('remotePort = 34567'));
  assert.ok(toml.includes('[[proxies]]'));
  const noRemote = buildFrpcConfig({ serverAddr: '203.0.113.10', serverPort: 7000, token: frpToken, remotePort: 0, useTls: false, localPort: 8787 }).toml;
  assert.ok(!noRemote.includes('remotePort'), 'remotePort=0 应省略该键（由 frps 分配）');
  assert.ok(!noRemote.includes('transport.tls.enable = true'));
  frpLog('生成配置示例');
  const logBlob = frpLogs.join('\n');
  assert.ok(!logBlob.includes(frpToken), 'token 绝不进日志');
  const frpcDirA = join(tmpDir, 'phone-bridge', 'frpc-a');
  const writtenPath = writeFrpcConfig(frpcDirA, toml);
  assert.ok(existsSync(writtenPath), 'frpc.toml 应写入 frpc 目录');
  assert.equal(writtenPath, join(frpcDirA, 'frpc.toml'));
  pass('frp 配置生成（官方 TOML 键 + remotePort=0 省略 + token 不落日志）');

  // 25) v3.2 §10 frp：下载产物 size/sha256 双校验（拒绝篡改）
  const frpcPayload = Buffer.from('MOCK-FRPC-EXE-3.2.0-PAYLOAD', 'utf8');
  const releaseZip = makeZip([
    { name: `frp_${frpReleaseInfo().tag}_windows_amd64/frpc.exe`, data: frpcPayload },
  ]);
  const expected = { size: releaseZip.length, sha256: crypto.createHash('sha256').update(releaseZip).digest('hex') };
  verifyReleaseAsset(releaseZip, expected); // 合法：不抛
  let tampered = Buffer.from(releaseZip);
  tampered[100] = (tampered[100] + 1) % 256;
  assert.throws(() => verifyReleaseAsset(tampered, expected), /sha256 不符/, '篡改产物必须被 sha256 拒绝');
  assert.throws(() => verifyReleaseAsset(releaseZip, { size: expected.size + 1, sha256: expected.sha256 }), /字节数不符/, '尺寸不符必须被拒绝');
  assert.throws(() => verifyReleaseAsset(releaseZip, { size: expected.size, sha256: '' }), /sha256 元数据/, '缺 sha256 元数据必须拒绝落盘');
  pass('frp 下载产物 size/sha256 双校验（篡改 / 尺寸不符 / 缺元数据全部拒绝）');

  // 25b) ensureFrpcBinary 端到端：合法 zip 抽出 frpc.exe 落盘；篡改时拒绝落盘
  const frpcDirB = join(tmpDir, 'phone-bridge', 'frpc-b');
  const installed = await ensureFrpcBinary({
    frpcDir: frpcDirB,
    log: frpLog,
    fetchJson: async () => ({
      assets: [{
        name: frpReleaseInfo().asset,
        size: releaseZip.length,
        digest: `sha256:${expected.sha256}`,
        browser_download_url: 'https://example.invalid/frp.zip',
      }],
    }),
    fetchBuffer: async () => releaseZip,
  });
  assert.equal(installed.source, 'managed');
  assert.equal(readFileSync(installed.exePath).toString(), frpcPayload.toString(), 'zip 内 frpc.exe 应被抽出落盘');
  const frpcDirC = join(tmpDir, 'phone-bridge', 'frpc-c');
  await assert.rejects(
    () => ensureFrpcBinary({
      frpcDir: frpcDirC,
      fetchJson: async () => ({ assets: [{ name: frpReleaseInfo().asset, size: releaseZip.length, digest: `sha256:${expected.sha256}`, browser_download_url: 'x' }] }),
      fetchBuffer: async () => tampered,
    }),
    /sha256 不符/,
  );
  assert.ok(!existsSync(join(frpcDirC, 'frpc.exe')), '校验不过绝不落盘');
  // 用户手放优先：目录里已有 frpc.exe 时直接使用，不触发下载
  const frpcDirD = join(tmpDir, 'phone-bridge', 'frpc-d');
  mkdirSync(frpcDirD, { recursive: true });
  writeFileSync(join(frpcDirD, 'frpc.exe'), 'USER-FRPC');
  const userPlaced = await ensureFrpcBinary({
    frpcDir: frpcDirD,
    fetchJson: async () => { throw new Error('不应触发下载'); },
    fetchBuffer: async () => { throw new Error('不应触发下载'); },
  });
  assert.equal(userPlaced.source, 'user');
  assert.equal(readFileSync(userPlaced.exePath).toString(), 'USER-FRPC', '用户手放的 frpc 不被覆盖');
  pass('frpc 自动引导（合法落盘 / 篡改拒绝落盘 / 用户手放优先）');

  // 26) v3.2 §10 frp：frpc 崩溃重启策略（指数退避，最多 5 次）
  const frpcHomeE = mkdtempSync(join(tmpdir(), 'dsh-bridge-frp-e-'));
  mkdirSync(join(frpcHomeE, 'phone-bridge', 'frpc'), { recursive: true });
  writeFileSync(join(frpcHomeE, 'phone-bridge', 'frpc', 'frpc.exe'), 'USER-FRPC');
  const crashSpawner = makeFrpcSpawner({
    lines: ['2026/11/14 10:00:00 [I] [proxy] login to server success', '2026/11/14 10:00:00 [I] [proxy] [dsh-phone-bridge] start proxy success'],
    exitAfterMs: 30,
  });
  const transportE = new TransportManager({
    config: normalizeTransportConfig({
      tunnelMode: 'frp',
      frp: { serverAddr: '203.0.113.10', serverPort: 7000, token: frpToken, remotePort: 0, useTls: false },
    }),
    home: frpcHomeE,
    log: frpLog,
    spawnImpl: crashSpawner.spawnImpl,
    backoffBaseMs: 20,
  });
  await transportE.start({ localPort: 8787 });
  const crashedStatus = await waitForCondition(
    () => transportE.status(),
    (value) => value.tunnelStatus === 'error' && value.tunnelError.includes('已停止重试'),
    8000,
    'frpc 连续崩溃 5 次后停止重试',
  );
  assert.ok(crashSpawner.spawns.length === 6, `初始 1 次 + 重启 5 次（实际 spawn ${crashSpawner.spawns.length} 次）`);
  assert.equal(crashedStatus.channels.frp.restarts, 5);
  await transportE.stop();
  pass('frpc 崩溃重启策略（指数退避最多 5 次，超过降级局域网）');

  // 26b) 正常 frpc：代理成功 → running，remotePort=0 时从 frps 分配结果回填 publicUrl
  const okSpawner = makeFrpcSpawner({
    lines: [
      '2026/11/14 10:00:00 [I] [sub/root] login to server success',
      '2026/11/14 10:00:00 [I] [proxy] [dsh-phone-bridge] start proxy success remoteAddr=203.0.113.10:34567',
    ],
    exitAfterMs: -1, // 常驻
  });
  const transportF = new TransportManager({
    config: normalizeTransportConfig({
      tunnelMode: 'frp',
      frp: { serverAddr: '203.0.113.10', serverPort: 7000, token: frpToken, remotePort: 0, useTls: false },
    }),
    home: frpcHomeE,
    log: frpLog,
    spawnImpl: okSpawner.spawnImpl,
    backoffBaseMs: 20,
  });
  await transportF.start({ localPort: 8787 });
  const runningStatus = await waitForCondition(
    () => transportF.status(),
    (value) => value.tunnelStatus === 'running',
    4000,
    'frp 通道 running',
  );
  assert.equal(runningStatus.tunnelUrl, 'http://203.0.113.10:34567', 'remotePort=0 时应从 frps 分配结果回填 publicUrl');
  assert.ok(!JSON.stringify(runningStatus).includes(frpToken), '状态快照不携带 token');
  assert.ok(!frpLogs.join('\n').includes(frpToken), 'frpc 托管全程日志不含 token');
  await transportF.stop();
  assert.ok(okSpawner.spawns.every((item) => item.command.endsWith('frpc.exe') || item.command.includes('frpc')), 'spawn 的是 frpc 二进制');
  assert.ok(okSpawner.spawns[0].args.includes('-c'), 'frpc 启动参数带 -c 配置路径');
  pass('frp 通道运行态（frps 分配端口回填 publicUrl + token 不入状态/日志）');

  // 27) v3.2 §10：通道统一状态机切换（停旧起新 + 持久化 + 失败降级）
  let quickStopped = 0;
  const quickStarter = async () => {
    return {
      url: 'https://demo.trycloudflare.com',
      stop: () => {
        quickStopped += 1;
      },
    };
  };
  const transportG = new TransportManager({
    config: normalizeTransportConfig({
      tunnelMode: 'quick',
      publicUrl: 'https://dsh.example.com',
      frp: { serverAddr: '203.0.113.10', serverPort: 7000, token: frpToken, remotePort: 34567, useTls: false },
    }),
    home: frpcHomeE,
    log: frpLog,
    quickStarter,
    probeEndpoint: async () => ({ ok: true, status: 200, latencyMs: 1 }),
    spawnImpl: makeFrpcSpawner({
      lines: ['2026/11/14 10:00:00 [I] [proxy] [dsh-phone-bridge] start proxy success remotePort=34567'],
      exitAfterMs: -1,
    }).spawnImpl,
  });
  await transportG.start({ localPort: 8787 });
  await waitForCondition(() => transportG.status(), (value) => value.tunnelStatus === 'running' && value.tunnelUrl === 'https://demo.trycloudflare.com', 3000, 'quick 通道');
  const switchNamed = await transportG.switchMode('named', { persistFile: join(frpcHomeE, 'phone-bridge', 'transport.json') });
  assert.equal(quickStopped, 1, '停旧：旧通道（quick）应被 stop');
  assert.equal(switchNamed.tunnelMode, 'named');
  assert.equal(switchNamed.tunnelUrl, 'https://dsh.example.com');
  const persisted = JSON.parse(readFileSync(join(frpcHomeE, 'phone-bridge', 'transport.json'), 'utf8'));
  assert.equal(persisted.tunnelMode, 'named', '切换选择应持久化到 transport.json');
  const switchFrp = await transportG.switchMode('frp');
  assert.equal(switchFrp.tunnelMode, 'frp');
  assert.equal(switchFrp.tunnelUrl, 'http://203.0.113.10:34567', 'frp 固定 remotePort 时直接回填');
  assert.equal(Object.keys(switchFrp.channels).length, 6, '六通道卡片状态齐全（§10.1 含 custom/ngrok）');
  const switchOff = await transportG.switchMode('off');
  assert.equal(switchOff.tunnelStatus, 'off');
  assert.ok(!JSON.stringify(switchOff.channels).includes(frpToken), '通道卡片不携带 token');
  await assert.rejects(() => transportG.switchMode('bogus'), /tunnelMode 必须是/);
  assert.equal(normalizeTransportConfig({ tunnelMode: 'bogus' }).tunnelMode, 'off', '非法 mode 归一化为 off');
  await transportG.stop();
  pass('通道统一状态机（quick→named→frp→off 停旧起新 + 持久化 + 非法 mode 拒绝）');

  // 27b) named 模式缺 publicUrl → 通道报错降级 LAN
  const transportH = new TransportManager({
    config: normalizeTransportConfig({ tunnelMode: 'named', publicUrl: '' }),
    home: frpcHomeE,
    log: frpLog,
    probeEndpoint: async () => ({ ok: true, status: 200, latencyMs: 1 }),
  });
  await transportH.start({ localPort: 8787 });
  const namedError = transportH.status();
  assert.equal(namedError.tunnelStatus, 'error');
  assert.ok(namedError.tunnelError.includes('publicUrl'), '缺 publicUrl 应给出可读错误');
  assert.equal(namedError.channels.frp.status, 'off', '其它通道不受影响');
  await transportH.stop();
  // relay 占位
  const transportI = new TransportManager({
    config: normalizeTransportConfig({ tunnelMode: 'relay', relay: { endpoint: '' } }),
    home: frpcHomeE,
    log: frpLog,
  });
  await transportI.start({ localPort: 8787 });
  assert.equal(transportI.status().tunnelStatus, 'reserved', 'relay 本期仅占位展示');
  await transportI.stop();
  pass('named 缺 publicUrl 报错降级 / relay 占位展示');

  // 28) v3.2 §10：HTTP 通道路由（GET /api/transport + POST /api/transport/mode）
  const transportGet = await request(port, 'GET', '/api/transport', { token });
  assert.equal(transportGet.status, 200);
  assert.equal(transportGet.json.tunnelMode, 'off');
  assert.ok(transportGet.json.channels !== undefined && transportGet.json.channels.quick !== undefined, '四通道卡片进响应');
  const transportSwitch = await request(port, 'POST', '/api/transport/mode', { token, body: { mode: 'off' } });
  assert.equal(transportSwitch.status, 200);
  assert.equal(transportSwitch.json.tunnelMode, 'off');
  const persistedFile = join(tmpDir, 'transport.json');
  assert.ok(existsSync(persistedFile), '切换选择应持久化 transport.json');
  const badMode = await request(port, 'POST', '/api/transport/mode', { token, body: { mode: 'bogus' } });
  assert.equal(badMode.status, 400, '非法 mode → 400 INVALID_PARAM');
  const loopbackOnlySwitch = await request(port, 'POST', '/api/transport/mode', { token });
  assert.equal(loopbackOnlySwitch.status, 400, '缺 mode → 400 INVALID_PARAM');
  pass('HTTP 通道路由（状态查询 / 一键切换 / 持久化 / 非法参数）');

  // 29) v3.3 §10.1：custom 模式（粘贴任意公网地址，不托管进程）
  const transportCustom = new TransportManager({
    config: normalizeTransportConfig({ tunnelMode: 'custom', publicUrl: 'https://my-abc.oophz.com:12345/' }),
    home: frpcHomeE,
    log: frpLog,
    probeEndpoint: async () => ({ ok: true, status: 200, latencyMs: 1 }),
  });
  await transportCustom.start({ localPort: 8787 });
  const customStatus = transportCustom.status();
  assert.equal(customCustom(customStatus), 'https://my-abc.oophz.com:12345');
  await transportCustom.stop();
  function customCustom(status) {
    return status.channels.custom.url;
  }

  const transportCustomBad = new TransportManager({
    config: normalizeTransportConfig({ tunnelMode: 'custom', publicUrl: 'ftp://不是http' }),
    home: frpcHomeE,
    log: frpLog,
  });
  await transportCustomBad.start({ localPort: 8787 });
  assert.equal(transportCustomBad.status().tunnelStatus, 'error', '非 http/https 地址应报错');
  assert.ok(transportCustomBad.status().channels.custom.error.includes('格式无效'), '错误应说明格式问题');
  await transportCustomBad.stop();

  const transportCustomEmpty = new TransportManager({
    config: normalizeTransportConfig({ tunnelMode: 'custom', publicUrl: '' }),
    home: frpcHomeE,
    log: frpLog,
  });
  await transportCustomEmpty.start({ localPort: 8787 });
  assert.equal(transportCustomEmpty.status().tunnelStatus, 'error', 'custom 缺地址应报错降级');
  assert.ok(transportCustomEmpty.status().channels.custom.error.includes('公网地址'), '错误应提示先填地址');
  await transportCustomEmpty.stop();
  pass('custom 模式（合法地址 running / 非 http 格式拒绝 / 缺地址降级）');

  // 30) v3.3 §10.1：探活接口 probePublicUrl + POST /api/transport/probe
  const probeOk = await probePublicUrl('http://127.0.0.1:' + port, { timeoutMs: 3000 });
  assert.equal(probeOk.ok, true, '探活本桥 /api/health 应可达');
  assert.equal(probeOk.status, 200);
  assert.ok(Number.isFinite(probeOk.latencyMs) && probeOk.latencyMs >= 0);
  assert.equal(probeOk.contractVersion, 3);
  assert.equal(probeOk.bridgeVersion, BRIDGE_VERSION);
  const probeDead = await probePublicUrl('http://127.0.0.1:9', { timeoutMs: 1000 });
  assert.equal(probeDead.ok, false);
  assert.ok(typeof probeDead.error === 'string' && probeDead.error.length > 0, '不可达应有 error 说明');
  const probeBad = await probePublicUrl('不是地址', { timeoutMs: 1000 });
  assert.equal(probeBad.ok, false);
  assert.ok(probeBad.error.includes('格式无效'));
  const probeHttp = await request(port, 'POST', '/api/transport/probe', {
    token,
    body: { url: 'http://127.0.0.1:' + port },
  });
  assert.equal(probeHttp.status, 200);
  assert.equal(probeHttp.json.ok, true);
  assert.equal(probeHttp.json.status, 200);
  const probeHttpBad = await request(port, 'POST', '/api/transport/probe', { token, body: { url: ' nonsense ' } });
  assert.equal(probeHttpBad.status, 200);
  assert.equal(probeHttpBad.json.ok, false);
  assert.ok(probeHttpBad.json.error.includes('格式无效'));
  const probeNoAuth = await request(port, 'POST', '/api/transport/probe', { body: { url: 'http://127.0.0.1:' + port } });
  assert.equal(probeNoAuth.status, 401, '探活接口需要令牌');
  pass('POST /api/transport/probe 探活（本桥 200 / 死端口 error / 非法地址 / 鉴权）');

  // 31) v3.3 §10.1：ngrok 托管（mock 进程：add-authtoken → http --domain → JSON 日志）
  const ngrokHomeG = mkdtempSync(join(tmpdir(), 'dsh-bridge-ngrok-'));
  mkdirSync(join(ngrokHomeG, 'phone-bridge', 'ngrok'), { recursive: true });
  writeFileSync(join(ngrokHomeG, 'phone-bridge', 'ngrok', 'ngrok.exe'), 'USER-NGROK');
  const ngrokSpawner = makeFrpcSpawner({
    lines: [
      '{"lvl":"inf","msg":"starting web service","obj":"web","addr":"127.0.0.1:4040"}',
      '{"lvl":"inf","msg":"started tunnel","obj":"tunnels","name":"command_line","url":"https://my-bridge.ngrok.app"}',
    ],
    exitAfterMs: -1,
  });
  const ngrokLogs = [];
  const transportNgrok = new TransportManager({
    config: normalizeTransportConfig({
      tunnelMode: 'ngrok',
      ngrok: { authtoken: 'ngrok-secret-token-331', staticDomain: 'my-bridge.ngrok.app' },
    }),
    home: ngrokHomeG,
    log: (msg) => { ngrokLogs.push(msg); },
    spawnImpl: ngrokSpawner.spawnImpl,
    backoffBaseMs: 20,
  });
  await transportNgrok.start({ localPort: 8787 });
  const ngrokRunning = await waitForCondition(
    () => transportNgrok.status(),
    (value) => value.tunnelStatus === 'running',
    4000,
    'ngrok 通道 running',
  );
  assert.equal(ngrokRunning.tunnelUrl, 'https://my-bridge.ngrok.app');
  assert.equal(ngrokSpawner.spawns.length, 2, '应先 add-authtoken 再起 http 隧道');
  assert.deepEqual(ngrokSpawner.spawns[0].args, ['config', 'add-authtoken', 'ngrok-secret-token-331'], '第一条命令按官方 CLI 落 authtoken');
  assert.deepEqual(ngrokSpawner.spawns[1].args.slice(0, 3), ['http', '8787', '--domain=my-bridge.ngrok.app'], '隧道命令按官方 CLI http --domain');
  assert.ok(ngrokSpawner.spawns[1].args.includes('--log=stdout'), '日志走 stdout 便于桥解析');
  const ngrokJson = JSON.stringify(ngrokRunning);
  assert.ok(!ngrokJson.includes('ngrok-secret-token-331'), 'authtoken 不进状态');
  assert.ok(!ngrokLogs.join('\n').includes('ngrok-secret-token-331'), 'authtoken 不进日志');
  await transportNgrok.stop();
  pass('ngrok 托管（官方 CLI 序列 + started tunnel 解析 + authtoken 不落日志/状态）');

  // 31b) ngrok 崩溃重启（指数退避最多 5 次）+ 缺 authtoken 降级
  const crashNgrok = makeFrpcSpawner({
    lines: ['{"lvl":"inf","msg":"started tunnel","obj":"tunnels","url":"https://x.ngrok.app"}'],
    exitAfterMs: 30,
  });
  const transportNgrokCrash = new TransportManager({
    config: normalizeTransportConfig({
      tunnelMode: 'ngrok',
      ngrok: { authtoken: 'tok', staticDomain: 'x.ngrok.app' },
    }),
    home: ngrokHomeG,
    log: (msg) => { ngrokLogs.push(msg); },
    spawnImpl: crashNgrok.spawnImpl,
    backoffBaseMs: 20,
  });
  await transportNgrokCrash.start({ localPort: 8787 });
  await waitForCondition(
    () => transportNgrokCrash.status(),
    (value) => value.tunnelStatus === 'error' && value.tunnelError.includes('已停止重试'),
    8000,
    'ngrok 连续崩溃停止重试',
  );
  // 1 次 add-authtoken + 1 次初始 http + 5 次重启
  assert.equal(crashNgrok.spawns.length, 7, '崩溃重启序列 spawn 次数应为 1+1+5');
  await transportNgrokCrash.stop();

  const transportNgrokNoAuth = new TransportManager({
    config: normalizeTransportConfig({ tunnelMode: 'ngrok', ngrok: { authtoken: '', staticDomain: 'x.ngrok.app' } }),
    home: ngrokHomeG,
    log: (msg) => { ngrokLogs.push(msg); },
    spawnImpl: makeFrpcSpawner({ lines: [], exitAfterMs: -1 }).spawnImpl,
  });
  await transportNgrokNoAuth.start({ localPort: 8787 });
  const ngrokNoAuthStatus = transportNgrokNoAuth.status();
  assert.equal(ngrokNoAuthStatus.tunnelStatus, 'error');
  assert.ok(ngrokNoAuthStatus.channels.ngrok.error.includes('authtoken'), '缺 authtoken 应给出可读错误');
  await transportNgrokNoAuth.stop();
  pass('ngrok 崩溃重启策略 + 缺 authtoken 降级');

  // 31c) ngrok 下载双校验与 zip 抽取（与 frp 同构的最小 ZIP）
  const ngrokPayload = Buffer.from('MOCK-NGROK-EXE-3.3.0', 'utf8');
  const ngrokZip = makeZip([{ name: 'ngrok.exe', data: ngrokPayload }]);
  const ngrokExpected = { size: ngrokZip.length, sha256: crypto.createHash('sha256').update(ngrokZip).digest('hex') };
  assert.equal(verifyNgrokAsset(ngrokZip, ngrokExpected), 'sha256');
  const tamperedNgrok = Buffer.from(ngrokZip);
  tamperedNgrok[50] = (tamperedNgrok[50] + 1) % 256;
  assert.throws(() => verifyNgrokAsset(tamperedNgrok, ngrokExpected), /sha256 不符/, '篡改必须被拒绝');
  assert.equal(verifyNgrokAsset(ngrokZip, { size: ngrokZip.length, sha256: '' }), 'size', '无 sha256 摘要时按 size 校验（ngrok stable 无官方 checksums 清单）');
  const extractedNgrok = extractNgrokFromZip(ngrokZip);
  assert.equal(extractedNgrok.data.toString(), ngrokPayload.toString());
  const ngrokDirE = join(tmpDir, 'phone-bridge', 'ngrok-e');
  const ngrokInstall = await ensureNgrokBinary({
    ngrokDir: ngrokDirE,
    fetchMeta: async () => ({ size: ngrokZip.length, sha256: ngrokExpected.sha256 }),
    fetchBuffer: async () => ngrokZip,
  });
  assert.equal(ngrokInstall.source, 'managed');
  assert.equal(readFileSync(ngrokInstall.exePath).toString(), ngrokPayload.toString());
  assert.equal(parseNgrokLine('{"lvl":"err","msg":"_authentication failed"}').event, 'error', '认证失败行应解析为 error');
  assert.equal(parseNgrokLine('{"lvl":"inf","msg":"started tunnel","obj":"tunnels","url":"https://a.ngrok.app"}').url, 'https://a.ngrok.app');
  pass('ngrok 下载双校验 + zip 抽取 + 日志行解析');

  // 32) v3.3 §10.1：frp 服务商预设模板数据完整性（配对页展示层）
  assert.equal(FRP_PROVIDERS.length, 1);
  assert.deepEqual(FRP_PROVIDERS.map((provider) => provider.id), ['self']);
  for (const provider of FRP_PROVIDERS) {
    assert.ok(provider.name.length > 0 && provider.docs.startsWith('https://'), '每个预设要有名称与官方文档 URL');
    assert.ok(provider.fields.includes('remotePort'), '字段说明应覆盖 remotePort');
    assert.ok(provider.notes.length > 0, '每个预设要有注意事项');
  }
  assert.equal(TUNNEL_PROVIDERS.find((provider) => provider.id === 'openfrp').mode, 'custom');
  const providerRender = pairHtml({
    lanUrl: 'ws://192.168.1.5:8787',
    channels: {
      frp: { label: 'frp', desc: '', status: 'off', url: '', error: '' },
      custom: { label: '自定义地址', desc: '', status: 'off', url: '', error: '' },
    },
    currentChannel: 'off',
    port: 8787, clients: 0, code: '123456', expiresAt: Date.now() + 60000,
    bridgeVersion: '3.3.0', contractVersion: 3,
  });
  assert.ok(providerRender.includes('服务商预设'), 'frp 卡片应渲染预设折叠区');
  assert.ok(providerRender.includes('OpenFrp'), '预设区应列出 OpenFrp');
  assert.ok(providerRender.includes('frp-server-addr'), 'frp 卡片应有 serverAddr 输入框');
  assert.ok(providerRender.includes('frp-server-port'), 'frp 卡片应有 serverPort 输入框');
  assert.ok(providerRender.includes('frp-remote-port'), 'frp 卡片应有 remotePort 输入框');
  assert.ok(providerRender.includes('frp-token'), 'frp 卡片应有 token 输入框');
  assert.ok(providerRender.includes('data-frp="1"'), 'frp 卡片应有带参数的保存按钮');
  assert.ok(providerRender.includes('custom-url'), 'custom 卡片应有地址输入框');
  assert.ok(providerRender.includes('/api/transport/probe'), 'custom 卡片应有探活按钮');
  assert.ok(providerRender.includes('ngrok-authtoken'), 'ngrok 卡片应有 authtoken 输入框');
  // 回显：地址与端口来自 frpFormValues()，token 只回「是否已保存」
  const frpEchoRender = pairHtml({
    lanUrl: 'ws://192.168.1.5:8787',
    channels: { frp: { label: 'frp', desc: '', status: 'running', url: 'http://1.2.3.4:27000', error: '' } },
    frp: { serverAddr: '1.2.3.4', serverPort: 7000, remotePort: 27000, useTls: true, hasToken: true },
    currentChannel: 'frp',
    port: 8787, clients: 0, code: '123456', expiresAt: Date.now() + 60000,
    bridgeVersion: BRIDGE_VERSION, contractVersion: 3,
  });
  assert.ok(frpEchoRender.includes('value="1.2.3.4"'), 'frp 表单应回显已保存的 serverAddr');
  assert.ok(frpEchoRender.includes('value="27000"'), 'frp 表单应回显已保存的 remotePort');
  assert.ok(frpEchoRender.includes('token 已保存，留空则不修改'), '已有 token 时只提示，不回显密钥');
  assert.ok(!frpEchoRender.includes('vps-secret-token'), '配对页绝不回显 frp token');
  pass('frp 服务商预设模板 + 配对页卡片渲染（frp/custom/ngrok 表单齐全 + 参数回显不含密钥）');

  // 33) v3.3 §10.1：HTTP 切换带参数持久化（token/authtoken 只落盘不回显）
  mkdirSync(join(tmpDir, 'phone-bridge', 'ngrok'), { recursive: true });
  writeFileSync(join(tmpDir, 'phone-bridge', 'ngrok', 'ngrok.exe'), 'USER-NGROK');
  const ngrokSwitch = await request(port, 'POST', '/api/transport/mode', {
    token,
    body: { tunnelMode: 'ngrok', ngrok: { authtoken: 'http-token-331', staticDomain: 'http-test.ngrok.app' } },
  });
  assert.equal(ngrokSwitch.status, 200);
  assert.equal(ngrokSwitch.json.tunnelMode, 'ngrok');
  assert.ok(!JSON.stringify(ngrokSwitch.json).includes('http-token-331'), 'authtoken 不回显');
  const persistedTransport = JSON.parse(readFileSync(join(tmpDir, 'transport.json'), 'utf8'));
  assert.equal(persistedTransport.tunnelMode, 'ngrok');
  assert.equal(persistedTransport.ngrok.authtoken, 'http-token-331', 'authtoken 只落 transport.json（600）');
  assert.equal(persistedTransport.ngrok.staticDomain, 'http-test.ngrok.app');
  const ngrokHttpStatus = await request(port, 'GET', '/api/transport', { token });
  assert.ok(!JSON.stringify(ngrokHttpStatus.json).includes('http-token-331'), '通道状态接口不回显 authtoken');
  const customSwitch = await request(port, 'POST', '/api/transport/mode', {
    token,
    body: { tunnelMode: 'custom', publicUrl: `tcp://127.0.0.1:${port}` },
  });
  assert.equal(customSwitch.status, 200);
  assert.equal(customSwitch.json.channels.custom.status, 'running');
  assert.equal(customSwitch.json.channels.custom.url, `http://127.0.0.1:${port}`);
  const savedCustom = JSON.parse(readFileSync(join(tmpDir, 'transport.json'), 'utf8'));
  assert.equal(savedCustom.publicUrl, `http://127.0.0.1:${port}`);
  const emptyCustomSwitch = await request(port, 'POST', '/api/transport/mode', {
    token,
    body: { tunnelMode: 'custom', publicUrl: '' },
  });
  assert.equal(emptyCustomSwitch.status, 400);
  const unchangedCustom = await request(port, 'GET', '/api/transport', { token });
  assert.equal(unchangedCustom.json.tunnelMode, 'custom');
  assert.equal(unchangedCustom.json.tunnelStatus, 'running');
  assert.equal(unchangedCustom.json.tunnelUrl, `http://127.0.0.1:${port}`);
  // frp 带参数切换（配对页表单）：参数落盘、token 不回显、留空 token 保持原值
  mkdirSync(join(tmpDir, 'phone-bridge', 'frpc'), { recursive: true });
  writeFileSync(join(tmpDir, 'phone-bridge', 'frpc', 'frpc.exe'), 'USER-FRPC');
  const frpSwitch = await request(port, 'POST', '/api/transport/mode', {
    token,
    body: {
      tunnelMode: 'frp',
      frp: { serverAddr: '198.51.100.7', serverPort: 7001, token: 'frp-http-token-33', remotePort: 27001 },
    },
  });
  assert.equal(frpSwitch.status, 200);
  assert.equal(frpSwitch.json.tunnelMode, 'frp');
  assert.ok(!JSON.stringify(frpSwitch.json).includes('frp-http-token-33'), 'frp token 不回显');
  const persistedFrp = JSON.parse(readFileSync(join(tmpDir, 'transport.json'), 'utf8'));
  assert.equal(persistedFrp.frp.serverAddr, '198.51.100.7');
  assert.equal(persistedFrp.frp.serverPort, 7001);
  assert.equal(persistedFrp.frp.remotePort, 27001);
  assert.equal(persistedFrp.frp.token, 'frp-http-token-33', 'frp token 只落 transport.json（600）');
  // 表单留空 token（页面不回显）→ 沿用已保存的 token，不清空
  const frpSwitchNoToken = await request(port, 'POST', '/api/transport/mode', {
    token,
    body: { tunnelMode: 'frp', frp: { serverAddr: '198.51.100.7', serverPort: 7001, token: '', remotePort: 27002 } },
  });
  assert.equal(frpSwitchNoToken.status, 200);
  const persistedFrp2 = JSON.parse(readFileSync(join(tmpDir, 'transport.json'), 'utf8'));
  assert.equal(persistedFrp2.frp.token, 'frp-http-token-33', '留空 token 应保留原值而不是清空');
  assert.equal(persistedFrp2.frp.remotePort, 27002, '其它字段仍按表单更新');
  const controlPage = await request(port, 'GET', '/pair');
  assert.equal(controlPage.status, 200);
  const controlTokenMatch = controlPage.text.match(/'X-DSH-Local-Control-Token':\s*"([A-Za-z0-9_-]+)"/);
  assert.ok(controlTokenMatch, '本机配对页必须提供当前进程的通道控制凭据');
  const localControlHeaders = { 'X-DSH-Local-Control-Token': controlTokenMatch[1] };
  const pageSwitch = await request(port, 'POST', '/api/transport/mode', {
    headers: localControlHeaders,
    body: { tunnelMode: 'off' },
  });
  assert.equal(pageSwitch.status, 200, '配对页无需先给手机配对即可配置公网通道');
  assert.equal(pageSwitch.json.tunnelMode, 'off');
  const noControlSwitch = await request(port, 'POST', '/api/transport/mode', { body: { tunnelMode: 'off' } });
  assert.equal(noControlSwitch.status, 401, '本机控制接口仍需有效凭据');
  const badControlSwitch = await request(port, 'POST', '/api/transport/mode', {
    headers: { 'X-DSH-Local-Control-Token': 'invalid' }, body: { tunnelMode: 'off' },
  });
  assert.equal(badControlSwitch.status, 401);
  const controlSessions = await request(port, 'GET', '/api/sessions', { headers: localControlHeaders });
  assert.equal(controlSessions.status, 401, '页面控制凭据不能访问用户会话');
  const tunneledControl = await rawRequest('POST', '/api/transport/mode', {
    ...localControlHeaders, Host: 'dsh-phone-bridge-tunnel', 'Content-Type': 'application/json',
  }, JSON.stringify({ tunnelMode: 'off' }));
  assert.equal(tunneledControl.status, 403, '页面控制凭据不能绕过公网来源限制');
  const remoteHostControl = await rawRequest('POST', '/api/transport/mode', {
    ...localControlHeaders, Host: 'public.example.com', 'Content-Type': 'application/json',
  }, JSON.stringify({ tunnelMode: 'off' }));
  assert.equal(remoteHostControl.status, 403);
  const pageProbe = await request(port, 'POST', '/api/transport/probe', {
    headers: localControlHeaders, body: { url: `http://127.0.0.1:${port}` },
  });
  assert.equal(pageProbe.status, 200);
  assert.ok(!JSON.stringify(pageSwitch.json).includes(controlTokenMatch[1]));
  assert.ok(!JSON.stringify(health.json).includes(controlTokenMatch[1]));
  pass('配对页本机通道控制（无手机令牌可配置 / 错误凭据拒绝 / 远端拒绝 / 会话隔离）');
  const hackerMode = await request(port, 'POST', '/api/transport/mode', { token, body: { tunnelMode: 'hacker' } });
  assert.equal(hackerMode.status, 400);
  await request(port, 'POST', '/api/transport/mode', { token, body: { tunnelMode: 'off' } });
  const offStatus = await request(port, 'GET', '/api/transport', { token });
  assert.equal(offStatus.json.tunnelMode, 'off');
  pass('HTTP 切换带参数持久化（authtoken/token 只落盘不回显 / 留空保留密钥 / custom 降级 / 非法值拒绝）');

  // 34) v3.5 §3.1：预览纯函数（60 字截断 / 占位符 / 单行化 / lastChatMessage）
  {
    const cut = toPreviewText('很'.repeat(100));
    assert.equal(Array.from(cut).length, 60, '超长预览应按码点截到 60 字');
    assert.ok(cut.endsWith('…'), '截断预览应以省略号结尾');
    assert.equal(
      toPreviewText('第一行\n第二行\t制表符   多空格'),
      '第一行 第二行 制表符 多空格',
      '预览应单行化（连续空白折叠成空格）',
    );
    assert.equal(toPreviewText('   \n\t '), '', '纯空白预览应为空串');
    assert.equal(
      previewOfBlocks([
        { type: 'text', text: '看这张图和视频' },
        { type: 'image', attachmentId: 'sha256:aa' },
        { type: 'video', attachmentId: 'media:v.mp4' },
        { type: 'file', attachmentId: 'sha256:bb', name: 'x.pdf' },
        { type: 'toolCall', id: 't1', name: 'read_file', arguments: '{}' },
        { type: 'reasoning', text: '思考过程不应进预览' },
      ]),
      '看这张图和视频 [图片] [视频] [文件] [工具调用]',
      '占位符规则：image/video/file/toolCall 块各得一个占位，reasoning 不进预览',
    );
    assert.equal(previewOfBlocks([{ type: 'image', attachmentId: 'x' }]), '[图片]', '纯图片消息 → 占位符');
    assert.equal(previewOfBlocks([]), '', '无块 → 空串');
    const last = lastChatMessage([
      { role: 'tool', text: '工具结果' },
      { seq: 12, role: 'assistant', text: '最终回答' },
      { seq: 13, role: 'system', text: '系统消息' },
    ]);
    assert.ok(last !== undefined && last.seq === 12, 'lastChatMessage 应跳过 tool/system 取最后一条 assistant');
    assert.equal(lastChatMessage([{ role: 'tool' }]), undefined, '只有 tool 消息 → undefined');
  }
  pass('预览纯函数（60 字截断 / 占位符 / 单行化 / lastChatMessage）');

  console.log(`\n✅ 冒烟测试全部通过（${passed} 项）`);
  cleanup();
  // 关掉监听后主动退出，避免 keep-alive 句柄挂住进程
  setTimeout(() => process.exit(0), 100);
}

let passed = 0;
function pass(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function cleanup() {
  for (const disposer of globalThis.__disposers ?? []) {
    try {
      disposer();
    } catch (error) {
      // 忽略
    }
  }
}
main().catch((error) => {
  console.error('\n❌ 冒烟测试失败:', error);
  try {
    cleanup();
  } catch (cleanupError) {
    // 忽略
  }
  setTimeout(() => process.exit(1), 100);
});
