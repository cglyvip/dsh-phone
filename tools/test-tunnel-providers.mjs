import assert from 'node:assert/strict';
import test from 'node:test';
import { TUNNEL_PROVIDERS, FRP_PROVIDERS, getTunnelProvider, providerCommands } from '../shared/tunnel-providers.js';
import { parsePublicUrl, probePublicUrl } from '../bridge/public-endpoint.js';

const validHealth = { status: 'ok', plugin: 'dsh-phone-bridge', contractVersion: 3, bridgeVersion: '3.5.2' };

test('provider registry keeps distinct official-client and standard frp integrations', () => {
  assert.equal(new Set(TUNNEL_PROVIDERS.map(provider => provider.id)).size, TUNNEL_PROVIDERS.length);
  for (const provider of TUNNEL_PROVIDERS) {
    assert.ok(provider.name.length && provider.freePlan.length && provider.requirements.length && provider.steps.length);
    assert.ok(['quick', 'named', 'frp', 'ngrok', 'custom'].includes(provider.mode));
    assert.equal(new URL(provider.homepage).protocol, 'https:');
    assert.equal(new URL(provider.docs).protocol, 'https:');
    assert.equal(provider.supports.http, true);
    assert.equal(provider.supports.websocket, true);
    assert.equal(typeof provider.managed, 'boolean');
    for (const command of provider.commands) {
      assert.ok(!command.includes('\n'));
      assert.ok(!/\{(?!port\})/.test(command));
    }
  }
  assert.deepEqual(FRP_PROVIDERS.map(provider => provider.id), ['self']);
  assert.ok(FRP_PROVIDERS[0].fields.includes('remotePort'));
  assert.ok(FRP_PROVIDERS[0].notes.includes('auth.token'));
  for (const providerId of ['openfrp', 'natfrp', 'sunny-ngrok', 'chmlfrp']) {
    assert.equal(getTunnelProvider(providerId).mode, 'custom');
    assert.equal(getTunnelProvider(providerId).managed, false);
  }
  assert.throws(() => getTunnelProvider('not-a-provider'), /未知穿透服务/);
});

test('commands only substitute a validated local port', () => {
  assert.deepEqual(providerCommands('localtunnel', 8787), ['npx localtunnel --port 8787']);
  assert.deepEqual(providerCommands('localhost-run', 9000), ['ssh -R 80:localhost:9000 localhost.run']);
  assert.deepEqual(providerCommands('tailscale-funnel', 9000), ['tailscale funnel 9000']);
  assert.deepEqual(providerCommands('cloudflare-quick', 9000), []);
  assert.deepEqual(providerCommands('zrok', 9000), []);
  for (const port of [0, -1, 65536, 1.5, '8787;cmd', undefined]) {
    assert.throws(() => providerCommands('localtunnel', port), /端口/);
  }
});

test('public addresses preserve the bridge origin and normalize TCP tunnel endpoints', () => {
  assert.equal(parsePublicUrl(' https://demo.example.com/ '), 'https://demo.example.com');
  assert.equal(parsePublicUrl('tcp://node.example.com:25000'), 'http://node.example.com:25000');
  assert.equal(parsePublicUrl('tcp://[::1]:25000'), 'http://[::1]:25000');
  for (const address of [
    'tcp://node.example.com', 'http://node.example.com:0', 'file:///tmp/example', 'javascript:alert(1)',
    'http://user:password@node.example.com', 'https://node.example.com/api', 'https://node.example.com?token=secret',
    'https://node.example.com#secret', 'https://node.example.com?', 'https://node.example.com\\api', '/relative', '', null,
    'https:node.example.com', 'https://node.example.com/..', 'https://node.example.com/%2e/',
    'https://@node.example.com', 'https://node.exa\nmple.com',
  ]) {
    assert.equal(parsePublicUrl(address), null, String(address));
  }
});

test('health probe verifies bridge identity and protocol rather than any HTTP 200', async () => {
  const seenRequests = [];
  const result = await probePublicUrl('tcp://tunnel.example.com:25000', {
    fetchImpl: async (address, options) => {
      seenRequests.push({ address, options });
      return address.endsWith('/api/health')
        ? Response.json(validHealth)
        : new Response('local only', { status: 403 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.contractVersion, 3);
  assert.equal(result.bridgeVersion, '3.5.2');
  assert.equal(seenRequests[0].address, 'http://tunnel.example.com:25000/api/health');
  assert.equal(seenRequests[0].options.redirect, 'manual');
  assert.equal(seenRequests[0].options.headers['ngrok-skip-browser-warning'], '1');
  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[1].address, 'http://tunnel.example.com:25000/api/pairing-code');
  assert.equal(seenRequests[1].options.headers['ngrok-skip-browser-warning'], '1');
  for (const payload of [
    '<html>provider password page</html>', { status: 'ok', contractVersion: 3 },
    { status: 'ok', plugin: 'other-app', contractVersion: 3 },
    { status: 'error', plugin: 'dsh-phone-bridge', contractVersion: 3 },
    { status: 'ok', plugin: 'dsh-phone-bridge', contractVersion: 2 },
    { status: 'ok', plugin: 'dsh-phone-bridge' },
  ]) {
    const response = typeof payload === 'string' ? new Response(payload) : Response.json(payload);
    const probe = await probePublicUrl('https://tunnel.example.com', { fetchImpl: async () => response });
    assert.equal(probe.ok, false);
    assert.equal(probe.status, 200);
    assert.ok(probe.error.length > 0);
  }
  const protocolIdentity = await probePublicUrl('https://tunnel.example.com', {
    fetchImpl: async (address) => address.endsWith('/api/health')
      ? Response.json({ status: 'ok', protocol: 'dsh-phone-bridge', contractVersion: 3 })
      : new Response('local only', { status: 403 }),
  });
  assert.equal(protocolIdentity.ok, true);
});

test('public probe verifies the remote pairing-code gate without exposing it', async () => {
  const calls = [];
  const result = await probePublicUrl('https://tunnel.example.com', {
    fetchImpl: async (address, options) => {
      calls.push({ address, options });
      if (address.endsWith('/api/health')) return Response.json(validHealth);
      return new Response(JSON.stringify({ error: { code: 'ROUTE_LOCAL_ONLY' } }), { status: 403 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].address, 'https://tunnel.example.com/api/health');
  assert.equal(calls[1].address, 'https://tunnel.example.com/api/pairing-code');
  assert.equal(calls[1].options.headers['ngrok-skip-browser-warning'], '1');
  assert.equal(calls[1].options.redirect, 'manual');
  const exposed = await probePublicUrl('https://tunnel.example.com', {
    fetchImpl: async (address) => address.endsWith('/api/health')
      ? Response.json(validHealth)
      : Response.json({ code: '123456' }),
  });
  assert.equal(exposed.ok, false);
  assert.match(exposed.error, /配对码/);
  for (const privateStatus of [200, 401, 302]) {
    const wrongStatus = await probePublicUrl('https://tunnel.example.com', {
      fetchImpl: async (address) => address.endsWith('/api/health')
        ? Response.json(validHealth)
        : new Response('not isolated', { status: privateStatus }),
    });
    assert.equal(wrongStatus.ok, false);
    assert.match(wrongStatus.error, /配对码/);
  }
});

test('local origins do not require a remote pairing-code probe', async () => {
  const addresses = [];
  const result = await probePublicUrl('http://127.0.0.1:8787', {
    fetchImpl: async (address) => {
      addresses.push(address);
      return Response.json(validHealth);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(addresses, ['http://127.0.0.1:8787/api/health']);
});

test('probe refuses redirects, HTTP errors, oversized bodies, timeouts and network errors', async () => {
  for (const status of [301, 302, 401, 403, 500]) {
    const result = await probePublicUrl('https://tunnel.example.com', {
      fetchImpl: async () => new Response('unavailable', { status }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
  }
  const contentLength = await probePublicUrl('https://tunnel.example.com', {
    fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
  });
  assert.equal(contentLength.ok, false);
  assert.match(contentLength.error, /超过 1 MiB/);
  const chunkedBody = await probePublicUrl('https://tunnel.example.com', {
    fetchImpl: async () => new Response(new Uint8Array(1024 * 1024 + 1)),
  });
  assert.equal(chunkedBody.ok, false);
  assert.match(chunkedBody.error, /超过 1 MiB/);
  const timeout = await probePublicUrl('https://tunnel.example.com', {
    timeoutMs: 15,
    fetchImpl: async () => { throw new DOMException('expired', 'TimeoutError'); },
  });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /15ms/);
  const networkError = await probePublicUrl('https://tunnel.example.com', {
    fetchImpl: async () => { throw new Error('DNS lookup failed'); },
  });
  assert.equal(networkError.ok, false);
  assert.equal(networkError.error, 'DNS lookup failed');
  let fetchCalled = false;
  const invalidAddress = await probePublicUrl('https://tunnel.example.com/api', {
    fetchImpl: async () => { fetchCalled = true; return Response.json(validHealth); },
  });
  assert.equal(invalidAddress.ok, false);
  assert.equal(fetchCalled, false);
});
