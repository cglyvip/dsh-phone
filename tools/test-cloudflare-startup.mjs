import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startQuickTunnel, TUNNEL_HOST_HEADER } from '../cloudflare.js';
import { normalize } from '../index.js';
import { normalizeTransportConfig, TransportManager } from '../bridge/transport.js';

function makeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0);
    return true;
  };
  return child;
}

function makeTunnel(options = {}) {
  const child = makeChildProcess();
  let invocation;
  const promise = startQuickTunnel({
    bridgePort: 8787,
    timeoutMs: 4000,
    ...options,
    spawnImpl(command, args, settings) {
      invocation = { command, args, settings };
      return child;
    },
  });
  return { child, promise, invocation };
}

test('a generated URL cannot mark the tunnel ready before registration', async () => {
  const tunnel = makeTunnel();
  let resolved = false;
  tunnel.promise.then(() => { resolved = true; });
  tunnel.child.stderr.emit('data', Buffer.from('https://url-only.trycloudflare.com\n'));
  await delay(1600);
  assert.equal(resolved, false);
  tunnel.child.stderr.emit('data', Buffer.from('Registered tunnel connection connIndex=0\n'));
  const connection = await tunnel.promise;
  assert.equal(connection.url, 'https://url-only.trycloudflare.com');
  connection.stop();
  assert.equal(tunnel.child.killed, true);
});

test('registration before the URL is also recognized', async () => {
  const tunnel = makeTunnel();
  tunnel.child.stdout.emit('data', Buffer.from('Registered tunnel connection\n'));
  tunnel.child.stdout.emit('data', Buffer.from('https://registered-first.trycloudflare.com\n'));
  const connection = await tunnel.promise;
  assert.equal(connection.target, 'http://127.0.0.1:8787');
  assert.equal(connection.url, 'https://registered-first.trycloudflare.com');
  connection.stop();
});

test('DNS failure after URL issuance rejects with diagnostic output', async () => {
  const tunnel = makeTunnel();
  const rejected = assert.rejects(tunnel.promise, /完成公网连接注册前退出.*\n.*Bad DNS packet/s);
  tunnel.child.stderr.emit('data', Buffer.from('https://not-connected.trycloudflare.com\n'));
  tunnel.child.stderr.emit('data', Buffer.from('lookup argotunnel.com: dnsquery: Bad DNS packet.\n'));
  tunnel.child.exitCode = 1;
  tunnel.child.emit('exit', 1);
  await rejected;
});

test('registration timeout terminates the child and exposes its last error', async () => {
  const tunnel = makeTunnel({ timeoutMs: 25 });
  const rejected = assert.rejects(tunnel.promise, /公网连接注册超时.*\n.*DNS lookup failed/s);
  tunnel.child.stderr.emit('data', Buffer.from('DNS lookup failed\n'));
  await rejected;
  assert.equal(tunnel.child.killed, true);
});

test('configured protocol and DNS resolvers reach only the child process', async () => {
  const previousResolvers = process.env.TUNNEL_DNS_RESOLVER_ADDRS;
  const tunnel = makeTunnel({ protocol: ' http2 ', dnsResolvers: [' 1.1.1.1:53 ', '', '8.8.8.8:53'] });
  assert.deepEqual(tunnel.invocation.args, [
    'tunnel', '--protocol', 'http2', '--http-host-header', TUNNEL_HOST_HEADER,
    '--url', 'http://127.0.0.1:8787',
  ]);
  assert.equal(tunnel.invocation.settings.env.TUNNEL_DNS_RESOLVER_ADDRS, '1.1.1.1:53,8.8.8.8:53');
  assert.equal(process.env.TUNNEL_DNS_RESOLVER_ADDRS, previousResolvers);
  assert.equal(tunnel.invocation.settings.windowsHide, true);
  tunnel.child.stdout.emit('data', Buffer.from('https://configured.trycloudflare.com\nRegistered tunnel connection\n'));
  const connection = await tunnel.promise;
  connection.stop();
});

test('normalization keeps explicit settings and defaults without a DNS override', () => {
  assert.equal(normalize({}).cloudflaredProtocol, 'auto');
  assert.deepEqual(normalize({}).cloudflaredDnsResolvers, []);
  const config = normalize({ cloudflaredProtocol: 'quic', cloudflaredDnsResolvers: [' 1.1.1.1:53 '] });
  const transportConfig = normalizeTransportConfig(config);
  assert.equal(transportConfig.cloudflaredProtocol, 'quic');
  assert.deepEqual(transportConfig.cloudflaredDnsResolvers, ['1.1.1.1:53']);
  assert.throws(() => normalize({ cloudflaredProtocol: 'invalid' }), /cloudflaredProtocol/);
  assert.throws(() => normalizeTransportConfig({ cloudflaredDnsResolvers: '1.1.1.1:53' }), /cloudflaredDnsResolvers/);
});

test('transport forwards Cloudflare settings to its starter', async () => {
  let requested;
  const manager = new TransportManager({
    home: '.',
    config: { tunnelMode: 'quick', cloudflaredProtocol: 'http2', cloudflaredDnsResolvers: ['1.1.1.1:53'] },
    quickStarter: async options => {
      requested = options;
      return { url: 'https://transport.trycloudflare.com', stop() {} };
    },
  });
  await manager.start({ localPort: 8787 });
  await delay(0);
  assert.equal(requested.protocol, 'http2');
  assert.deepEqual(requested.dnsResolvers, ['1.1.1.1:53']);
  assert.equal(requested.bridgePort, 8787);
  assert.equal(manager.status().tunnelStatus, 'running');
  requested.onExit(1, 'resolver failed');
  assert.match(manager.status().tunnelError, /resolver failed/);
  await manager.stop();
});
