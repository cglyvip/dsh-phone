/**
 * 中转服务端联调探针（本地自测用，不参与打包）。
 *
 * 用法：
 *   RELAY_TOKEN=<服务器上的 RELAY_TOKEN> node relay-probe.mjs [wss://relay.域名]
 *
 * 它会模拟「一台电脑」向中转服务注册，然后模拟「一台手机」连进来，
 * 最后打印双向帧，确认中转链路通了。密钥只从环境变量读，绝不写死在代码里。
 */
import { WebSocket } from 'ws';

const TOKEN = typeof process.env.RELAY_TOKEN === 'string' ? process.env.RELAY_TOKEN.trim() : '';
const BASE = (process.argv[2] ?? process.env.RELAY_BASE ?? 'wss://relay.cgly.eu.org').replace(/\/+$/, '');

if (TOKEN.length === 0) {
  console.error('缺少 RELAY_TOKEN 环境变量。');
  console.error('用法：RELAY_TOKEN=<中转密钥> node relay-probe.mjs [wss://relay.域名]');
  process.exit(2);
}

const code = 'm' + Math.random().toString(36).slice(2, 9);
const stamp = () => new Date().toISOString().slice(11, 19);

const ws = new WebSocket(`${BASE}/bridge`, { headers: { Authorization: `Bearer ${TOKEN}` } });
ws.on('open', () => {
  console.log('桥 WS 打开');
  ws.send(JSON.stringify({ type: 'register', role: 'bridge', pairCode: code }));
});
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  console.log(`[${stamp()}] 【桥←】`, JSON.stringify(m).slice(0, 200));
  if (m.type === 'ws-open') {
    const hello = JSON.stringify({ type: 'hello', probe: 'test' });
    ws.send(JSON.stringify({ type: 'ws-out', connId: m.connId, payload: Buffer.from(hello).toString('base64'), binary: false }));
    console.log('【桥→】已发 ws-out');
  }
});
ws.on('close', (c, r) => console.log(`[${stamp()}] 桥连接关闭:`, c, r.toString().slice(0, 80)));
ws.on('error', (e) => console.log('桥错误:', e.message));

// 每 5 秒发心跳
const hb = setInterval(() => {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'ping' }));
    console.log(`[${stamp()}] 【桥→】ping`);
  }
}, 5000);

setTimeout(() => {
  console.log(`[${stamp()}] --- 手机连 ---`);
  const p = new WebSocket(`${BASE}/p/${code}/ws?token=t`);
  p.on('open', () => console.log('✅ 手机 WS 开'));
  p.on('message', (d) => console.log('【手机←】', d.toString().slice(0, 200)));
  p.on('error', (e) => console.log('手机错误:', e.message));
}, 2000);

setTimeout(() => {
  clearInterval(hb);
  console.log('--- 结束 ---');
  process.exit(0);
}, 16000);
