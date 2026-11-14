// 临时校验：listSessions 的归档 / 置顶过滤（不依赖运行中的 DSH）。
import { DshAdapter } from '../adapter/dsh.js';

const services = new Map();

const sessions = [
  { sessionId: 's-a', updatedAt: 100, running: false, blank: false },
  { sessionId: 's-b', updatedAt: 200, running: false, blank: false },
  { sessionId: 's-c', updatedAt: 300, running: true, blank: false },
];

services.set('sessionController', {
  async list() {
    return { items: sessions };
  },
  async state() {
    return { cursor: 0, active: false, running: false, queue: [], pendingInput: [] };
  },
});

services.set('sessionQuery', {
  async readTitleSnapshots(ids) {
    return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: { title: 'T-' + id } } }));
  },
});

// 让 follow 先发 baseline，然后挂住不结束
services.set('workspaceController', {
  async *follow(signal) {
    yield { type: 'baseline', value: { items: [], archivedSessionIds: ['s-b'], pinnedSessionIds: ['s-c'] } };
    await new Promise((resolve) => {
      if (typeof signal?.addEventListener === 'function') signal.addEventListener('abort', resolve, { once: true });
    });
  },
});

const ctx = { get: (name) => services.get(name) };
const adapter = new DshAdapter(ctx, { log: () => {} });
adapter.startWorkspaceWatch();
await new Promise((r) => setTimeout(r, 50));

const active = await adapter.listSessions(false);
const archived = await adapter.listSessions(true);
console.log('active :', active.map((x) => `${x.sessionId}(pin=${x.pinned},arch=${x.archived})`).join(', '));
console.log('archived:', archived.map((x) => `${x.sessionId}(arch=${x.archived})`).join(', '));
const ok = active.length === 2
  && active[0].sessionId === 's-c'
  && active.every((x) => x.archived === false)
  && archived.length === 1
  && archived[0].sessionId === 's-b';
console.log(ok ? '✅ 归档/置顶过滤正确' : '❌ 过滤不符合预期');
adapter.stopWorkspaceWatch();
process.exit(ok ? 0 : 1);
