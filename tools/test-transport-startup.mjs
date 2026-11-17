import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { apply } from '../index.js';
import { TransportManager } from '../bridge/transport.js';

async function waitForStartup(startups) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (startups.length > 0 && startups[0].manager.channel !== null
      && startups[0].manager.status().tunnelStatus !== 'starting') {
      return startups[0];
    }
    await delay(20);
  }
  throw new Error('Bridge did not initialize transport after listening');
}

async function startPublicFixture() {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', plugin: 'dsh-phone-bridge', protocol: 'dsh-phone-bridge', contractVersion: 3 }));
      return;
    }
    if (request.url === '/api/pairing-code') {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'ROUTE_LOCAL_ONLY' } }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function makeContext(disposers) {
  const services = {
    sessionController: { list: async () => ({ items: [] }) },
  };
  const context = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (callback) => {
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
      return () => {};
    },
    inject: (_names, callback) => callback(context),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return context;
}

await test('bridge initializes the effective persisted transport after binding its port', async (testContext) => {
  const originalStart = TransportManager.prototype.start;
  const previousHome = process.env.DSH_HOME;
  let startups = [];
  TransportManager.prototype.start = async function(options) {
    startups.push({ manager: this, localPort: options.localPort, mode: this.cfg.tunnelMode });
    return originalStart.call(this, options);
  };
  try {
    for (const mode of ['off', 'named', 'custom']) {
      await testContext.test(mode, async () => {
        const testHome = mkdtempSync(join(tmpdir(), 'dsh-transport-startup-'));
        const bridgeHome = join(testHome, 'phone-bridge');
        mkdirSync(bridgeHome);
        const tokenFile = join(bridgeHome, 'tokens.json');
        const fixture = mode === 'off' ? null : await startPublicFixture();
        const publicUrl = fixture === null ? '' : fixture.url;
        if (mode !== 'off') {
          writeFileSync(join(bridgeHome, 'transport.json'), JSON.stringify({ tunnelMode: mode, publicUrl }));
        }
        process.env.DSH_HOME = testHome;
        startups = [];
        const disposers = [];
        try {
          apply(makeContext(disposers), {
            port: 0,
            host: '127.0.0.1',
            logLevel: 'silent',
            tunnelMode: 'off',
            tokenFile,
          });
          const startup = await waitForStartup(startups);
          const runtime = JSON.parse(readFileSync(join(bridgeHome, 'runtime.json'), 'utf8'));
          assert.equal(startups.length, 1);
          assert.ok(startup.localPort > 0);
          assert.equal(startup.localPort, runtime.port);
          assert.equal(startup.manager.localPort, runtime.port);
          assert.equal(startup.mode, mode);
          const response = await fetch(`http://127.0.0.1:${runtime.port}/api/health`, {
            headers: { Connection: 'close' },
          });
          assert.equal(response.status, 200);
          const health = await response.json();
          assert.equal(health.tunnelMode, mode);
          assert.equal(health.tunnelStatus, mode === 'off' ? 'off' : 'running');
          assert.equal(health.tunnelUrl, mode === 'off' ? '' : publicUrl);
          if (fixture !== null) {
            const publicHealth = await fetch(`${publicUrl}/api/health`);
            assert.equal(publicHealth.status, 200);
            assert.equal((await publicHealth.json()).plugin, 'dsh-phone-bridge');
            const pairingResponse = await fetch(`${publicUrl}/api/pairing-code`);
            assert.equal(pairingResponse.status, 403);
          }
        } finally {
          for (const disposer of disposers.reverse()) disposer();
          if (fixture !== null) fixture.server.close();
        }
      });
    }
  } finally {
    TransportManager.prototype.start = originalStart;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});
