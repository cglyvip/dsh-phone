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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { apply, normalize } from './index.js';
import { projectEvents } from './adapter/project.js';

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
        return {
          session: { version: 4, id: sessionId, createdAt: 1000, cwd: 'E:\\work', isSeeded: false, agentPreset: 'cordis' },
          inheritedEventCount: 0,
          events: fakeEvents,
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
      async archiveSession() {
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
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'magpie', model: 'x/y', reasoningEffort: 'high' };
      },
      async saveSelection() {
        return undefined;
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
  assert.equal(health.json.bridgeVersion, '3.0.1');
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
  assert.equal(hello.payload.bridgeVersion, '3.0.1');
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
  const missingImage = await request(port, 'GET', `/api/attachments/sha256:${'0'.repeat(64)}`, { token: paired.json.token });
  assert.equal(missingImage.json.error.code, 'NOT_SUPPORTED', '不存在的附件应报 NOT_SUPPORTED');
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
  assert.equal(missingMedia.json.error.code, 'NOT_SUPPORTED', '不存在的媒体应报 NOT_SUPPORTED');
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
  assert.equal(missingFile.json.error.code, 'NOT_SUPPORTED', '不存在的文件应报 NOT_SUPPORTED');
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

  // 18) /pair 页面（本机可打开）
  const pairPage = await request(port, 'GET', '/pair');
  assert.equal(pairPage.status, 200);
  assert.ok(pairPage.text.includes('配对码'));
  pass('GET /pair 配对页');

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
