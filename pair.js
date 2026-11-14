/**
 * dsh-phone-bridge · 局域网地址探测与配对页
 *
 * - 选一个最可能被手机访问到的局域网 IPv4
 * - 生成配对二维码（内联 SVG，零外部资源）
 * - /pair 配对页（只允许本机打开；页面上大字显示 6 位配对码）
 *
 * 证据等级：[推断] 不依赖 DSH 内部 API，纯本机实现。
 */
import os from 'node:os';
import qrcode from './qr.cjs';

/** 选一个最可能被手机访问到的局域网 IPv4（优先 192.168 / 10 / 172.16-31）。 */
export function lanAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      candidates.push({ address: info.address, name });
    }
  }
  const isPrivate = (ip) =>
    ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  candidates.sort((a, b) => (isPrivate(b.address) ? 1 : 0) - (isPrivate(a.address) ? 1 : 0));
  return candidates.length > 0 ? candidates[0].address : '';
}

/** 生成二维码 SVG（内联到页面里，无需外部资源）。 */
export function qrSvg(text, options = {}) {
  const cellSize = Number.isFinite(options.cellSize) ? options.cellSize : 6;
  const margin = Number.isFinite(options.margin) ? options.margin : 4;
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 生成配对页 HTML。
 * @param {{
 *   lanUrl: string, publicUrl?: string, tunnelUrl?: string,
 *   channels?: Record<string, {label: string, desc: string, status: string, url: string, error: string}>,
 *   currentChannel?: string, transportApiPath?: string,
 *   port: number, clients: number, code: string, expiresAt: number,
 *   bridgeVersion: string, contractVersion: number,
 * }} info
 */
export function pairHtml(info) {
  const lanUrl = typeof info.lanUrl === 'string' ? info.lanUrl : '';
  const publicUrl = typeof info.publicUrl === 'string' ? info.publicUrl : '';
  const tunnelUrl = typeof info.tunnelUrl === 'string' ? info.tunnelUrl : '';
  const channels = info.channels !== null && typeof info.channels === 'object' ? info.channels : {};
  const currentChannel = typeof info.currentChannel === 'string' ? info.currentChannel : 'off';
  const transportApiPath = typeof info.transportApiPath === 'string' ? info.transportApiPath : '/api/transport/mode';
  const code = typeof info.code === 'string' ? info.code : '';
  const expiresAt = Number.isFinite(info.expiresAt) ? info.expiresAt : 0;
  const clients = Number.isFinite(info.clients) ? info.clients : 0;
  const bridgeVersion = typeof info.bridgeVersion === 'string' ? info.bridgeVersion : '';
  const contractVersion = Number.isFinite(info.contractVersion) ? info.contractVersion : 0;

  const primaryUrl = publicUrl.length > 0 && (currentChannel === 'named' || currentChannel === 'relay')
    ? publicUrl
    : (tunnelUrl.length > 0 ? tunnelUrl : (publicUrl.length > 0 ? publicUrl : lanUrl));
  // 二维码里放一条完整的配对指令，App 扫到即可直接建连
  const qrPayload = `dsh-phone://pair?url=${encodeURIComponent(primaryUrl)}&code=${encodeURIComponent(code)}`;
  const svg = qrSvg(qrPayload, { cellSize: 5, margin: 3 });

  const remainingMinutes = expiresAt > 0 ? Math.max(0, Math.round((expiresAt - Date.now()) / 60000)) : 0;

  // 公网通道选择区块（仅本机可见）：4 个通道卡片 = 当前态 + 一键切换 + 每通道错误原因
  const STATUS_TEXT = {
    running: ['运行中', 'ok'],
    starting: ['连接中', 'wait'],
    error: ['出错', 'err'],
    stopped: ['已停止', 'idle'],
    off: ['未启用', 'idle'],
    reserved: ['未开放', 'idle'],
  };
  const channelOrder = ['quick', 'named', 'frp', 'relay'];
  const channelCards = channelOrder.map((id) => {
    const channel = channels[id] !== null && typeof channels[id] === 'object'
      ? channels[id]
      : { label: id, desc: '', status: 'off', url: '', error: '' };
    const [statusText, statusKind] = STATUS_TEXT[channel.status] ?? [channel.status, 'idle'];
    const active = id === currentChannel;
    const stateLine = channel.url.length > 0
      ? `<div class="ch-url">${escapeHtml(channel.url)}</div>`
      : (channel.error.length > 0 ? `<div class="ch-err">${escapeHtml(channel.error)}</div>` : '');
    return `
    <div class="ch${active ? ' ch-active' : ''}" id="ch-${id}">
      <div class="ch-head">
        <span class="ch-name">${escapeHtml(channel.label ?? id)}</span>
        <span class="st st-${statusKind}">${statusText}${active ? ' · 当前' : ''}</span>
      </div>
      <div class="ch-desc">${escapeHtml(channel.desc ?? '')}</div>
      ${stateLine}
      ${active ? '' : `<button class="ch-btn" data-mode="${id}"${channel.status === 'reserved' ? ' disabled' : ''}>切换到此通道</button>`}
    </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness · 手机配对</title>
<style>
  :root {
    --brand: #4D6BFE;
    --brand-soft: #E4E9FF;
    --brand-deep: #2E4098;
    --text: #1A1A1A;
    --text-2: #6B7280;
    --line: #EEF0F4;
    --bg: #F7F8FC;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px 56px;
    background: var(--bg); color: var(--text);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    display: flex; flex-direction: column; align-items: center;
  }
  .card {
    width: 100%; max-width: 460px; background: #fff; border-radius: 18px;
    padding: 26px 24px; box-shadow: 0 8px 30px rgba(46, 64, 152, .08);
    margin-bottom: 16px;
  }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: .2px; }
  .sub { color: var(--text-2); font-size: 13px; margin-bottom: 20px; }
  .qr { display: flex; justify-content: center; margin: 8px 0 18px; }
  .qr svg { width: 100%; max-width: 236px; height: auto; }
  .code-label { text-align: center; color: var(--text-2); font-size: 13px; }
  .code {
    text-align: center; font-size: 40px; font-weight: 700; letter-spacing: 10px;
    color: var(--brand-deep); margin: 6px 0 4px; font-variant-numeric: tabular-nums;
  }
  .code-expire { text-align: center; color: var(--text-2); font-size: 12px; margin-bottom: 18px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }
  .row:first-of-type { border-top: none; }
  .row .k { color: var(--text-2); font-size: 13px; flex: 0 0 auto; }
  .row .v { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; text-align: right; word-break: break-all; }
  .badge { display: inline-flex; align-items: center; gap: 6px; background: var(--brand-soft); color: var(--brand-deep); border-radius: 999px; padding: 4px 12px; font-size: 12px; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); }
  ol { margin: 8px 0 0; padding-left: 20px; color: var(--text-2); font-size: 13px; }
  ol li { margin: 4px 0; }
  .foot { color: var(--text-2); font-size: 12px; text-align: center; }
  button {
    width: 100%; margin-top: 14px; padding: 12px; border: none; border-radius: 12px;
    background: var(--brand); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  button:active { background: var(--brand-deep); }
  .ch { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
  .ch-active { border-color: var(--brand); background: var(--brand-soft); }
  .ch-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ch-name { font-weight: 600; font-size: 14px; }
  .ch-desc { color: var(--text-2); font-size: 12px; margin-top: 2px; }
  .ch-url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin-top: 6px; word-break: break-all; }
  .ch-err { color: #DC2626; font-size: 12px; margin-top: 6px; word-break: break-all; }
  .st { border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; flex: 0 0 auto; }
  .st-ok { background: #DCFCE7; color: #15803D; }
  .st-wait { background: var(--brand-soft); color: var(--brand-deep); }
  .st-err { background: #FEE2E2; color: #B91C1C; }
  .st-idle { background: var(--line); color: var(--text-2); }
  .ch-btn {
    margin-top: 8px; padding: 7px 10px; width: 100%; font-size: 13px;
    border: none; border-radius: 9px; background: var(--brand); color: #fff; cursor: pointer;
  }
  .ch-btn:disabled { background: var(--line); color: var(--text-2); cursor: default; }
</style>
</head>
<body>
  <div class="card">
    <h1>连接手机</h1>
    <div class="sub">用 DeepSeek Harness 手机端扫描下方二维码，或手动填写地址与配对码。</div>
    <div class="qr">${svg}</div>
    <div class="code-label">配对码</div>
    <div class="code">${escapeHtml(code)}</div>
    <div class="code-expire">${remainingMinutes} 分钟后失效 · 一次性使用</div>
    <button id="copy">复制服务器地址</button>
  </div>

  <div class="card">
    <div class="row"><span class="k">状态</span><span class="v"><span class="badge"><span class="dot"></span><span id="liveText">在线</span></span></span></div>
    <div class="row"><span class="k">局域网地址</span><span class="v">${escapeHtml(lanUrl || '—')}</span></div>
    ${publicUrl ? `<div class="row"><span class="k">公网地址</span><span class="v">${escapeHtml(publicUrl)}</span></div>` : ''}
    ${tunnelUrl ? `<div class="row"><span class="k">隧道地址</span><span class="v">${escapeHtml(tunnelUrl)}</span></div>` : ''}
    <div class="row"><span class="k">已连接手机</span><span class="v" id="clientCount">${clients}</span></div>
    <div class="row"><span class="k">桥版本</span><span class="v">v${escapeHtml(bridgeVersion)} · 契约 v${contractVersion}</span></div>
  </div>

  <div class="card">
    <div class="sub" style="margin-bottom:10px">公网通道（手机在外网也能连；任选其一，随时切换。建议：国内 VPS 用 frp 延迟最低，Named Tunnel 免维护，Quick 免费试用）</div>
    ${channelCards}
  </div>

  <div class="card">
    <div class="sub" style="margin-bottom:8px">手机端操作步骤</div>
    <ol>
      <li>手机与电脑连同一个 Wi-Fi（或使用上面的公网/隧道地址）。</li>
      <li>打开 App → 连接页 → 扫描二维码。</li>
      <li>若扫码失败，手动填地址，再输入上面的 6 位配对码。</li>
    </ol>
  </div>

  <div class="foot">DeepSeek Harness 手机桥 · 仅本机可打开此页面</div>

<script>
  const primary = ${JSON.stringify(primaryUrl)};
  const copyBtn = document.getElementById('copy');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(primary);
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => { copyBtn.textContent = '复制服务器地址'; }, 1500);
    } catch (e) {
      window.prompt('复制下面的地址：', primary);
    }
  });
  // 公网通道一键切换（仅本机）：POST /api/transport/mode → 停旧起新 → 刷新页面
  document.querySelectorAll('.ch-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.getAttribute('data-mode');
      btn.disabled = true;
      btn.textContent = '切换中…';
      try {
        const res = await fetch(${JSON.stringify(transportApiPath)}, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          btn.textContent = (data && data.error && data.error.message) ? data.error.message.slice(0, 60) : '切换失败';
          btn.disabled = false;
          return;
        }
        window.location.reload();
      } catch (e) {
        btn.textContent = '切换失败（网络错误）';
        btn.disabled = false;
      }
    });
  });
  async function poll() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const data = await res.json();
      const dot = document.querySelector('.dot');
      const text = document.getElementById('liveText');
      const count = document.getElementById('clientCount');
      if (data && data.status === 'ok') {
        dot.style.background = '#22C55E';
        text.textContent = '在线';
      }
      if (data && typeof data.clients === 'number') count.textContent = String(data.clients);
    } catch (e) {
      document.querySelector('.dot').style.background = '#EF4444';
      document.getElementById('liveText').textContent = '离线';
    }
  }
  poll();
  setInterval(poll, 3000);
</script>
</body>
</html>`;
}
