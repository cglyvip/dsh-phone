import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { pairHtml } from '../pair.js';
import { FRP_PROVIDERS, TUNNEL_PROVIDERS, providerCommands } from '../shared/tunnel-providers.js';

function element(attributes = {}) {
  const listeners = new Map();
  return {
    value: attributes.value ?? '',
    hidden: attributes.hidden ?? false,
    textContent: '',
    style: {},
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    async trigger(name, event = {}) {
      const listener = listeners.get(name);
      if (listener !== undefined) return listener(event);
      return undefined;
    },
  };
}

function htmlFor(publicUrl = 'https://public.example.test:443') {
  return pairHtml({
    lanUrl: 'ws://192.168.0.105:8787',
    publicUrl,
    tunnelUrl: '',
    channels: {
      quick: { label: 'Quick', desc: '', status: 'off', url: '', error: '' },
      named: { label: 'Named', desc: '', status: 'off', url: '', error: '' },
      frp: { label: 'frp', desc: '', status: 'off', url: '', error: '' },
      custom: { label: 'Custom', desc: '', status: 'off', url: publicUrl, error: '' },
      ngrok: { label: 'ngrok', desc: '', status: 'off', url: '', error: '' },
      relay: { label: 'Relay', desc: '', status: 'reserved', url: '', error: '' },
    },
    currentChannel: 'custom',
    transportApiPath: '/api/transport/mode',
    localControlToken: 'control_test_token',
    port: 8787,
    clients: 0,
    code: '123456',
    expiresAt: Date.now() + 600000,
    bridgeVersion: '3.5.2',
    contractVersion: 3,
  });
}

function harness(html) {
  const selector = element({ id: 'provider-select' });
  const copyButton = element({ id: 'copy' });
  const customInput = element({ id: 'custom-url', value: 'https://keep-this.example.test' });
  const liveDot = element();
  const liveText = element();
  const clientCount = element();
  const guides = TUNNEL_PROVIDERS.map(provider => element({ 'data-provider-guide': provider.id, value: provider.id, hidden: true }));
  const channels = ['quick', 'named', 'frp', 'custom', 'ngrok', 'relay']
    .map(mode => element({ 'data-channel': mode, value: mode }));
  const commandButtons = [];
  for (const provider of TUNNEL_PROVIDERS) {
    for (let commandIndex = 0; commandIndex < providerCommands(provider.id, 8787).length; commandIndex += 1) {
      commandButtons.push(element({
        'data-provider-command': provider.id,
        'data-command-index': String(commandIndex),
      }));
    }
  }
  const modeButtons = [];
  let fetchCount = 0;
  const copied = [];
  const document = {
    getElementById(id) {
      const known = { 'provider-select': selector, copy: copyButton, 'custom-url': customInput, liveText, clientCount };
      return known[id] ?? null;
    },
    querySelector(selectorText) {
      if (selectorText === '.dot') return liveDot;
      return null;
    },
    querySelectorAll(selectorText) {
      if (selectorText === '[data-provider-guide]') return guides;
      if (selectorText === '[data-channel]') return channels;
      if (selectorText === '[data-provider-command]') return commandButtons;
      if (selectorText === '.ch-btn[data-mode]') return modeButtons;
      return [];
    },
  };
  const context = {
    document,
    navigator: { clipboard: { writeText: async text => copied.push(text) } },
    window: { location: { reload() { throw new Error('selector must not reload'); } }, prompt() {} },
    fetch: async () => {
      fetchCount += 1;
      return { ok: true, status: 200, async json() { return { status: 'ok', clients: 0 }; } };
    },
    setTimeout() { return 1; },
    setInterval() { return 1; },
    clearTimeout() {},
    console,
  };
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, '配对页必须包含内联脚本');
  new vm.Script(scriptMatch[1], { filename: 'pair-page.js' }).runInNewContext(context);
  return { selector, customInput, guides, channels, commandButtons, copied, get fetchCount() { return fetchCount; }, get injected() { return context.injected; } };
}

test('pair page embeds valid scripts and all provider commands use the real bridge port', () => {
  const html = htmlFor();
  assert.doesNotThrow(() => new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
  assert.equal(TUNNEL_PROVIDERS.length, 14);
  assert.deepEqual(FRP_PROVIDERS.map(provider => provider.id), ['self']);
  assert.ok(html.includes('127.0.0.1:8787'));
  assert.ok(html.includes('provider-select'));
  for (const provider of TUNNEL_PROVIDERS) {
    for (const command of providerCommands(provider.id, 8787)) {
      assert.ok(command.includes('8787'));
      assert.ok(!command.includes('{port}'));
    }
  }
});

test('provider selector only filters the real channel and never fetches or overwrites custom input', async () => {
  const harnessState = harness(htmlFor());
  const initialFetchCount = harnessState.fetchCount;
  harnessState.customInput.value = 'tcp://keep-this.example.test:28000';
  harnessState.selector.value = 'openfrp';
  await harnessState.selector.trigger('change');
  assert.deepEqual(harnessState.channels.filter(channel => !channel.hidden).map(channel => channel.value), ['custom']);
  assert.equal(harnessState.customInput.value, 'tcp://keep-this.example.test:28000');
  assert.equal(harnessState.fetchCount, initialFetchCount);
  harnessState.selector.value = '';
  await harnessState.selector.trigger('change');
  assert.equal(harnessState.channels.filter(channel => !channel.hidden).length, 6);
});

test('provider copy action copies only catalog commands', async () => {
  const harnessState = harness(htmlFor());
  const cpolarCommand = providerCommands('cpolar', 8787)[0];
  const cpolarButton = harnessState.commandButtons.find(button => button.getAttribute('data-provider-command') === 'cpolar');
  assert.ok(cpolarButton);
  await cpolarButton.trigger('click');
  assert.deepEqual(harnessState.copied, [cpolarCommand]);
  assert.equal(cpolarCommand, 'cpolar http 8787');
});

test('pair page escapes user URLs and keeps the local control token scoped to local HTML', () => {
  const maliciousUrl = '</script><script>globalThis.injected=true</script>';
  const html = htmlFor(maliciousUrl);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1, '用户地址不能注入第二个 script 闭合标签');
  assert.ok(html.includes('&lt;/script&gt;'));
  assert.ok(html.includes('X-DSH-Local-Control-Token'));
  assert.ok(html.includes('control_test_token'));
  assert.ok(!html.includes(maliciousUrl));
  const context = harness(html);
  assert.equal(context.injected, undefined, '用户地址中的脚本不能执行');
  assert.equal(context.fetchCount >= 1, true, '页面健康轮询应使用同源 fetch');
});
