import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TransportManager } from '../bridge/transport.js';

test('invalid provider configuration preserves the active channel and saved settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-channel-validation-'));
  const persistFile = join(home, 'transport.json');
  await writeFile(persistFile, '{"tunnelMode":"quick"}\n');
  let stopped = 0;
  const manager = new TransportManager({
    home,
    config: { tunnelMode: 'quick' },
    quickStarter: async () => ({ url: 'https://active.trycloudflare.com', stop: () => { stopped += 1; } }),
    probeEndpoint: async () => ({ ok: false, status: 200, latencyMs: 1, error: 'provider validation page' }),
  });
  try {
    await manager.start({ localPort: 8787 });
    await new Promise(resolve => setImmediate(resolve));
    const current = manager.status();
    await assert.rejects(manager.switchMode('custom', {
      persistFile, params: { publicUrl: 'https://other.example.com' },
    }), /provider validation page/);
    await assert.rejects(manager.switchMode('frp', {
      persistFile, params: { frp: { serverAddr: 'frps.example.com', serverPort: 7000, remotePort: 27000 } },
    }), /token/);
    await assert.rejects(manager.switchMode('ngrok', { persistFile, params: { ngrok: { authtoken: '' } } }), /authtoken/);
    await assert.rejects(manager.switchMode('custom', {
      persistFile, params: { publicUrl: current.tunnelUrl },
    }), /切换会关闭/);
    assert.equal(manager.status().tunnelMode, 'quick');
    assert.equal(manager.status().tunnelStatus, 'running');
    assert.equal(manager.status().tunnelUrl, current.tunnelUrl);
    assert.equal(stopped, 0);
    assert.equal(await readFile(persistFile, 'utf8'), '{"tunnelMode":"quick"}\n');
  } finally {
    await manager.stop();
  }
});

test('TCP provider addresses are normalized and persisted only after bridge validation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-endpoint-validation-'));
  const persistFile = join(home, 'transport.json');
  const inspected = [];
  const manager = new TransportManager({
    home,
    config: { tunnelMode: 'off' },
    probeEndpoint: async address => { inspected.push(address); return { ok: true, status: 200, latencyMs: 1 }; },
  });
  try {
    await manager.start({ localPort: 8787 });
    const status = await manager.switchMode('custom', {
      persistFile, params: { publicUrl: 'tcp://service.example.com:23456' },
    });
    assert.deepEqual(inspected, ['http://service.example.com:23456']);
    assert.equal(status.tunnelStatus, 'running');
    assert.equal(status.tunnelUrl, 'http://service.example.com:23456');
    const persisted = JSON.parse(await readFile(persistFile, 'utf8'));
    assert.equal(persisted.publicUrl, 'http://service.example.com:23456');
    assert.equal(persisted.tunnelMode, 'custom');
  } finally {
    await manager.stop();
  }
});

test('pending validation refuses overlapping switches and releases its lock after failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-switch-conflict-'));
  let finishProbe;
  const pendingProbe = new Promise(resolve => { finishProbe = resolve; });
  const manager = new TransportManager({
    home,
    config: { tunnelMode: 'off' },
    probeEndpoint: async () => pendingProbe,
  });
  await manager.start({ localPort: 8787 });
  const firstSwitch = manager.switchMode('custom', { params: { publicUrl: 'https://pending.example.com' } });
  const failedSwitch = assert.rejects(firstSwitch, /验证失败/);
  await assert.rejects(manager.switchMode('off'), error => error.code === 'CONFLICT');
  assert.equal(manager.status().tunnelMode, 'off');
  finishProbe({ ok: false, status: 200, latencyMs: 1, error: '验证失败' });
  await failedSwitch;
  const retried = await manager.switchMode('off');
  assert.equal(retried.tunnelMode, 'off');
  assert.equal(manager.switching, false);
  await manager.stop();
});
