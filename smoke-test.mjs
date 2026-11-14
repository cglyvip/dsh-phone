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
import { projectEvents } from './adapter/project.js';
import { buildFrpcConfig, ensureFrpcBinary, extractFrpcFromZip, frpReleaseInfo, verifyReleaseAsset, writeFrpcConfig } from './bridge/frpc.js';
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
  assert.equal(health.json.bridgeVersion, '3.2.0');
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
  assert.equal(sessions.json.items.length, 2);
  const sessionA = sessions.json.items.find((item) => item.sessionId === SESSION_A);
  assert.ok(sessionA !== undefined);
  assert.equal(sessionA.title, '打招呼');
  pass('GET /api/sessions（标题已补全）');

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
  assert.equal(hello.payload.bridgeVersion, '3.2.0');
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
  assert.ok(toml.includes('transport.tls.enabled = true'));
  assert.ok(toml.includes('localIP = "127.0.0.1"'));
  assert.ok(toml.includes('localPort = 8787'));
  assert.ok(toml.includes('remotePort = 34567'));
  assert.ok(toml.includes('[[proxies]]'));
  const noRemote = buildFrpcConfig({ serverAddr: '203.0.113.10', serverPort: 7000, token: frpToken, remotePort: 0, useTls: false, localPort: 8787 }).toml;
  assert.ok(!noRemote.includes('remotePort'), 'remotePort=0 应省略该键（由 frps 分配）');
  assert.ok(!noRemote.includes('transport.tls.enabled = true'));
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
  assert.equal(Object.keys(switchFrp.channels).length, 4, '四通道卡片状态齐全');
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
