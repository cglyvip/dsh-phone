import { DshAdapter } from '../adapter/dsh.js';

function makeCtx(mode) {
  const calls = [];
  const ctx = {
    get(name) {
      if (name === 'sessionTitle') return { async rename(session, title) {
        if (session === undefined || session === null) throw new Error('session "x" is not live in this store');
        calls.push(['title', session.id, title]);
      } };
      if (name === 'sessions') return {
        get(id) { return mode === 'live' ? { id } : undefined; },
      };
      if (name === 'sessionController') return {
        async rename(req) { calls.push(['controller', req.sessionId, req.title]); return { title: req.title, seq: 1 }; },
      };
      if (name === 'sessionQuery') return { async readSession() { return { session: { id: 'hdr' } }; } };
      return undefined;
    },
  };
  return { ctx, calls };
}

for (const mode of ['live', 'notlive']) {
  const { ctx, calls } = makeCtx(mode);
  const adapter = new DshAdapter(ctx, { log: () => {} });
  const out = await adapter.renameSession('s1', '  新标题  ');
  console.log(mode, '=>', JSON.stringify(out), 'calls=', JSON.stringify(calls));
}
