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
import { TUNNEL_PROVIDERS, FRP_PROVIDERS, providerCommands } from './shared/tunnel-providers.js';

export { FRP_PROVIDERS } from './shared/tunnel-providers.js';

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

function scriptJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
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
  // frp 通道参数（回显 serverAddr/serverPort/remotePort 便于换机修改；token 只回「是否已保存」）
  const frpConfig = info.frp !== null && typeof info.frp === 'object' ? info.frp : {};
  const currentChannel = typeof info.currentChannel === 'string' ? info.currentChannel : 'off';
  const transportApiPath = typeof info.transportApiPath === 'string' ? info.transportApiPath : '/api/transport/mode';
  const localControlToken = typeof info.localControlToken === 'string' ? info.localControlToken : '';
  const code = typeof info.code === 'string' ? info.code : '';
  const expiresAt = Number.isFinite(info.expiresAt) ? info.expiresAt : 0;
  const clients = Number.isFinite(info.clients) ? info.clients : 0;
  const bridgeVersion = typeof info.bridgeVersion === 'string' ? info.bridgeVersion : '';
  const contractVersion = Number.isFinite(info.contractVersion) ? info.contractVersion : 0;
  const providerCatalog = TUNNEL_PROVIDERS.map(provider => ({
    ...provider,
    requirements: provider.requirements.map(requirement => requirement.replaceAll('{port}', String(info.port))),
    steps: provider.steps.map(step => step.replaceAll('{port}', String(info.port))),
    resolvedCommands: providerCommands(provider.id, info.port),
  }));
  const providerOptions = providerCatalog.map(provider =>
    `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join('');
  const providerGuides = providerCatalog.map(provider => `
    <section class="provider-guide" data-provider-guide="${escapeHtml(provider.id)}" hidden>
      <div class="provider-title">${escapeHtml(provider.name)}<span class="provider-kind">${provider.managed ? '桥托管官方客户端' : '官方客户端接入'}</span></div>
      <p class="provider-free">${escapeHtml(provider.freePlan)}</p>
      <div class="provider-links"><a href="${escapeHtml(provider.homepage)}" target="_blank" rel="noopener noreferrer">官方网站 ↗</a><a href="${escapeHtml(provider.docs)}" target="_blank" rel="noopener noreferrer">接入文档 ↗</a></div>
      <div class="provider-target">本机目标：<code>http://127.0.0.1:${escapeHtml(String(info.port))}</code></div>
      <div class="provider-label">开始前准备</div>
      <ul>${provider.requirements.map(requirement => `<li>${escapeHtml(requirement)}</li>`).join('')}</ul>
      <div class="provider-label">接入步骤</div>
      <ol>${provider.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      ${provider.resolvedCommands.map((command, commandIndex) => `
      <div class="provider-command"><pre>${escapeHtml(command)}</pre><button type="button" class="provider-copy" data-provider-command="${escapeHtml(provider.id)}" data-command-index="${commandIndex}">复制命令</button></div>`).join('')}
      ${provider.mode === 'custom' ? '<p class="provider-note">先用服务商官方客户端建立隧道，再把它给出的 HTTP / HTTPS 或 TCP 公网地址粘贴到下方。服务商启动密钥不要填进标准 frp 的 token 框。</p>' : ''}
      ${provider.mode === 'ngrok' ? '<p class="provider-note">免费方案可能有流量限制或浏览器提示页；保存前会验证地址是否直达手机桥，而不是广告或确认页面。</p>' : ''}
    </section>`).join('');

  const primaryUrl = publicUrl.length > 0 && (currentChannel === 'named' || currentChannel === 'relay')
    ? publicUrl
    : (tunnelUrl.length > 0 ? tunnelUrl : (publicUrl.length > 0 ? publicUrl : lanUrl));
  // 二维码里放一条完整的配对指令，App 扫到即可直接建连
  const qrPayload = `dsh-phone://pair?url=${encodeURIComponent(primaryUrl)}&code=${encodeURIComponent(code)}`;
  const svg = qrSvg(qrPayload, { cellSize: 5, margin: 3 });

  const remainingMinutes = expiresAt > 0 ? Math.max(0, Math.round((expiresAt - Date.now()) / 60000)) : 0;

  // 公网通道选择区块（仅本机可见）：通道卡片 = 色条+图标+当前态+一键切换+错误原因
  const STATUS_TEXT = {
    running: ['运行中', 'ok'],
    starting: ['连接中', 'wait'],
    error: ['出错', 'err'],
    stopped: ['已停止', 'idle'],
    off: ['未启用', 'idle'],
    reserved: ['未开放', 'idle'],
  };
  // 每通道：左侧色条颜色 + 内联 SVG 图标（不依赖外部图床）
  const CHANNEL_VISUAL = {
    quick: { color: '#F6821F', icon: '<path d="M4.5 11.5a3.5 3.5 0 0 1 .4-6.98A4.5 4.5 0 0 1 13 4.2a3.4 3.4 0 0 1 .5 6.8H5.5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' },
    named: { color: '#F6821F', icon: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 8h12M8 2c2.5 2.4 2.5 9.6 0 12M8 2c-2.5 2.4-2.5 9.6 0 12" fill="none" stroke="currentColor" stroke-width="1.2"/>' },
    frp: { color: '#2F80ED', icon: '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2.5" y="9" width="11" height="4.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="4.7" r="0.9" fill="currentColor"/><circle cx="5" cy="11.2" r="0.9" fill="currentColor"/>' },
    custom: { color: '#10B981', icon: '<path d="M8 2.5v3M5.5 5.5h5l1 4h-7l1-4zM8 9.5v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' },
    ngrok: { color: '#8B5CF6', icon: '<path d="M9 1.5 3.5 9h4l-1 5.5L12 7H8l1-5.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' },
    relay: { color: '#F59E0B', icon: '<circle cx="8" cy="8" r="1.6" fill="currentColor"/><path d="M4.5 4.5a5 5 0 0 0 0 7M11.5 4.5a5 5 0 0 1 0 7M2.6 2.6a7.6 7.6 0 0 0 0 10.8M13.4 2.6a7.6 7.6 0 0 1 0 10.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
  };
  const channelOrder = ['quick', 'named', 'frp', 'custom', 'ngrok', 'relay'];
  const channelCards = channelOrder.map((id) => {
    const channel = channels[id] !== null && typeof channels[id] === 'object'
      ? channels[id]
      : { label: id, desc: '', status: 'off', url: '', error: '' };
    const [statusText, statusKind] = STATUS_TEXT[channel.status] ?? [channel.status, 'idle'];
    const active = id === currentChannel;
    const visual = CHANNEL_VISUAL[id] ?? { color: '#4D6BFE', icon: '' };
    const stateLine = channel.url.length > 0
      ? `<div class="ch-url">${escapeHtml(channel.url)}</div>`
      : (channel.error.length > 0 ? `<div class="ch-err">${escapeHtml(channel.error)}</div>` : '');
    let extra = '';
    if (id === 'named') {
      extra = `
      <div class="ch-form">
        <input id="named-url" class="ch-input" type="text" placeholder="填写已配置到本机桥的 HTTPS 固定域名" autocomplete="off" value="${escapeHtml(publicUrl)}" aria-label="Cloudflare 固定域名">
        <button class="ch-btn" data-mode="named" data-url-input="named-url">验证并切换</button>
        <div class="ch-desc">需先在 Cloudflare 面板与官方客户端配置公开主机名，源站指向 http://127.0.0.1:${escapeHtml(String(info.port))}。填域名不会代替客户端建立隧道。</div>
      </div>`;
    }
    if (id === 'frp') {
      const providerRows = FRP_PROVIDERS.map((provider) => `
        <div class="pv">
          <div class="pv-head"><a class="pv-link" href="${escapeHtml(provider.docs)}" target="_blank" rel="noopener noreferrer">${escapeHtml(provider.name)} ↗</a></div>
          <div class="pv-fields">${provider.requirements.map(requirement => escapeHtml(requirement)).join(' · ')}</div>
          <div class="pv-notes">只接受标准 frps 的服务器参数与 auth.token。OpenFrp、樱花Frp等服务商的启动密钥请按上方服务商指引接入。</div>
        </div>`).join('\n');
      // frp 参数表单：换电脑时只改这一处即可，token 只落 transport.json（600）不回显
      const frpCfg = frpConfig !== null && typeof frpConfig === 'object' ? frpConfig : {};
      const frpAddr = typeof frpCfg.serverAddr === 'string' ? frpCfg.serverAddr : '';
      const frpPort = Number.isInteger(frpCfg.serverPort) ? frpCfg.serverPort : 7000;
      const frpRemote = Number.isInteger(frpCfg.remotePort) ? frpCfg.remotePort : 0;
      const frpHasToken = frpCfg.hasToken === true;
      extra = `
      <div class="ch-form">
        <input id="frp-server-addr" class="ch-input" type="text" placeholder="serverAddr：VPS 地址或域名，如 1.2.3.4" autocomplete="off" value="${escapeHtml(frpAddr)}">
        <div class="ch-form-row">
          <input id="frp-server-port" class="ch-input" type="number" inputmode="numeric" placeholder="serverPort（默认 7000）" autocomplete="off" value="${frpPort}">
          <input id="frp-remote-port" class="ch-input" type="number" inputmode="numeric" placeholder="remotePort（0=由 frps 分配）" autocomplete="off" value="${frpRemote}">
        </div>
        <input id="frp-token" class="ch-input" type="password" placeholder="${frpHasToken ? 'token 已保存，留空则不修改' : 'token：frps 的 auth.token（必填）'}" autocomplete="off">
        <label class="ch-check"><input id="frp-use-tls" type="checkbox"${frpCfg.useTls === true ? ' checked' : ''}> 启用 TLS（frps 开了 transport.tls 才勾）</label>
        <button class="ch-btn" data-mode="frp" data-frp="1">保存并切换</button>
        <div class="ch-desc">仅用于自建或明确支持原版 frpc 的标准 frps。切换后托管官方 frpc；token 只保存在本机。remotePort 填 0 时由 frps 分配。</div>
      </div>
      <details class="ch-extra">
        <summary>标准 frp 服务商预设与配置说明</summary>
        ${providerRows}
      </details>`;
    }
    if (id === 'custom') {
      extra = `
      <div class="ch-form">
        <input id="custom-url" class="ch-input" type="text" placeholder="公网地址：https://域名 或 tcp://域名:端口" autocomplete="off" value="${escapeHtml(publicUrl)}" aria-label="服务商分配的公网地址">
        <div class="ch-form-row">
          <button class="ch-btn ch-btn-secondary" id="custom-probe" data-probe="1">验证手机桥</button>
          <button class="ch-btn" data-mode="custom" data-url-input="custom-url">验证并切换</button>
        </div>
        <span class="probe-badge" id="custom-probe-result"></span>
        <div class="ch-desc">支持官方客户端输出的 HTTP、HTTPS、TCP 地址，需同时转发 HTTP 与 WebSocket。验证失败不会切走当前通道。</div>
      </div>`;
    }
    if (id === 'ngrok') {
      extra = `
      <div class="ch-form">
        <input id="ngrok-authtoken" class="ch-input" type="password" placeholder="authtoken（dashboard.ngrok.com 获取）" autocomplete="off">
        <input id="ngrok-domain" class="ch-input" type="text" placeholder="域名选填；留空使用账号的免费开发域名" autocomplete="off">
        <button class="ch-btn" data-mode="ngrok" data-ngrok="1">保存并切换</button>
        <div class="ch-desc">切换后桥自动下载托管 ngrok.exe（用户手放 ~/.dsh/phone-bridge/ngrok/ 优先）；authtoken 只落 transport.json，不回显。</div>
      </div>`;
    }
    // 带表单的卡片（frp/custom/ngrok）按钮由表单自己渲染，避免出现两个切换按钮
    const switchButton = (id === 'frp' || id === 'custom' || id === 'ngrok' || id === 'named')
      ? ''
      : `${active ? '' : `<button class="ch-btn" data-mode="${id}"${channel.status === 'reserved' ? ' disabled' : ''}>切换到此通道</button>`}`;
    return `
    <div class="ch${active ? ' ch-active' : ''}" id="ch-${id}" data-channel="${id}" style="--bar:${visual.color}">
      <div class="ch-head">
        <span class="ch-ico"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${visual.icon}</svg></span>
        <span class="ch-name">${escapeHtml(channel.label ?? id)}</span>
        <span class="st st-${statusKind}">${statusText}${active ? ' · 当前' : ''}</span>
      </div>
      <div class="ch-desc">${escapeHtml(channel.desc ?? '')}</div>
      ${stateLine}
      ${extra}
      ${switchButton}
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
  .ch {
    border: 1px solid var(--line); border-left: 4px solid var(--bar, var(--brand));
    border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; background: #fff;
    box-shadow: 0 1px 4px rgba(46, 64, 152, .05);
  }
  .ch-active {
    border-color: var(--brand); border-left-width: 4px;
    background: var(--brand-soft); box-shadow: 0 2px 10px rgba(77, 107, 254, .15);
  }
  .ch-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ch-ico { display: inline-flex; color: var(--bar, var(--brand)); flex: 0 0 auto; }
  .ch-name { font-weight: 600; font-size: 14px; flex: 1 1 auto; }
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
  .ch-btn-secondary { background: var(--brand-deep); }
  .ch-form { margin-top: 8px; }
  .ch-input {
    width: 100%; box-sizing: border-box; margin-top: 6px; padding: 8px 10px;
    border: 1px solid var(--line); border-radius: 9px; font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .ch-input:focus { outline: none; border-color: var(--brand); }
  .ch-form-row { display: flex; gap: 8px; }
  .ch-form-row .ch-btn { flex: 1; }
  .ch-check { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: var(--text-2); cursor: pointer; }
  .probe-badge { display: inline-block; margin-top: 6px; font-size: 12px; min-height: 16px; word-break: break-all; }
  .probe-ok { color: #15803D; font-weight: 600; }
  .probe-fail { color: #B91C1C; }
  .ch-extra { margin-top: 8px; }
  .ch-extra summary { cursor: pointer; color: var(--brand-deep); font-size: 12px; font-weight: 600; }
  .pv { border-top: 1px dashed var(--line); padding: 8px 0; }
  .pv-link { color: var(--brand); font-weight: 600; font-size: 12px; text-decoration: none; }
  .pv-fields { color: var(--text); font-size: 12px; margin-top: 4px; word-break: break-all; }
  .pv-notes { color: var(--text-2); font-size: 12px; margin-top: 2px; }
  [hidden] { display: none !important; }
  .provider-guide { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
  .provider-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
  .provider-kind { background: var(--brand-soft); color: var(--brand-deep); border-radius: 4px; font-size: 11px; padding: 2px 6px; }
  .provider-free, .provider-note { margin: 8px 0; color: var(--text-2); font-size: 12px; }
  .provider-note { border-left: 2px solid var(--brand); padding-left: 8px; }
  .provider-links { display: flex; gap: 16px; margin-bottom: 10px; font-size: 12px; }
  .provider-links a { color: var(--brand); }
  .provider-target { font-size: 12px; padding: 8px; background: var(--bg); border-radius: 6px; word-break: break-all; }
  .provider-label { font-size: 12px; font-weight: 600; color: var(--text); margin-top: 10px; }
  .provider-guide ul { margin: 5px 0 0; padding-left: 20px; color: var(--text-2); font-size: 12px; }
  .provider-guide li { margin: 4px 0; }
  .provider-command { margin-top: 8px; padding: 8px 10px; border-radius: 6px; background: var(--bg); }
  .provider-command pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
  .provider-copy { margin-top: 4px; width: auto; min-height: 40px; padding: 6px 10px; font-size: 12px; }
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
    <h1>选择穿透服务</h1>
    <p class="sub" style="margin-bottom:8px">先查看服务商条件与步骤，再配置下面的接入通道。选择服务商不会自动安装、运行命令或切换连接。</p>
    <select id="provider-select" class="ch-input" aria-label="选择内网穿透服务">
      <option value="">查看全部通道</option>
      ${providerOptions}
    </select>
    ${providerGuides}
  </div>

  <div class="card">
    <div class="sub" style="margin-bottom:10px">公网通道。标准 frps 用「标准 frp」；需要专用启动器的服务商用「自定义地址」，不要混用密钥。免费方案的额度、实名要求与可用节点以服务商当前说明为准。</div>
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
  const primary = ${scriptJson(primaryUrl)};
  const providerCatalog = ${scriptJson(providerCatalog.map(provider => ({ id: provider.id, mode: provider.mode, commands: provider.resolvedCommands })))};
  const localControlHeaders = {
    'Content-Type': 'application/json',
    'X-DSH-Local-Control-Token': ${JSON.stringify(localControlToken)},
  };
  const copyBtn = document.getElementById('copy');
  const providerSelect = document.getElementById('provider-select');
  providerSelect.addEventListener('change', () => {
    const selectedProvider = providerCatalog.find(provider => provider.id === providerSelect.value);
    document.querySelectorAll('[data-provider-guide]').forEach(guide => {
      guide.hidden = guide.getAttribute('data-provider-guide') !== providerSelect.value;
    });
    document.querySelectorAll('[data-channel]').forEach(channel => {
      channel.hidden = selectedProvider !== undefined && channel.getAttribute('data-channel') !== selectedProvider.mode;
    });
  });
  document.querySelectorAll('[data-provider-command]').forEach(button => {
    button.addEventListener('click', async () => {
      const provider = providerCatalog.find(candidate => candidate.id === button.getAttribute('data-provider-command'));
      const commandIndex = Number(button.getAttribute('data-command-index'));
      if (provider === undefined || !Number.isInteger(commandIndex) || commandIndex < 0 || commandIndex >= provider.commands.length) return;
      try {
        await navigator.clipboard.writeText(provider.commands[commandIndex]);
        button.textContent = '命令已复制';
      } catch (error) {
        button.textContent = '复制失败，请手动选择命令';
      }
    });
  });
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
  // §10.1：custom/ngrok 卡片在切换时带上表单参数（publicUrl / ngrok.authtoken 等）
  document.querySelectorAll('.ch-btn[data-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.getAttribute('data-mode');
      const payload = { tunnelMode: mode };
      const urlInputId = btn.getAttribute('data-url-input');
      if (urlInputId) {
        const input = document.getElementById(urlInputId);
        payload.publicUrl = input ? input.value.trim() : '';
      }
      if (btn.getAttribute('data-frp') === '1') {
        const addrInput = document.getElementById('frp-server-addr');
        const portInput = document.getElementById('frp-server-port');
        const remoteInput = document.getElementById('frp-remote-port');
        const tokenInput = document.getElementById('frp-token');
        const tlsInput = document.getElementById('frp-use-tls');
        const frpParams = {};
        if (addrInput) frpParams.serverAddr = addrInput.value.trim();
        const portNum = portInput ? parseInt(portInput.value, 10) : NaN;
        if (Number.isFinite(portNum) && portNum > 0) frpParams.serverPort = portNum;
        const remoteNum = remoteInput ? parseInt(remoteInput.value, 10) : NaN;
        if (Number.isFinite(remoteNum) && remoteNum >= 0) frpParams.remotePort = remoteNum;
        // 留空 = 沿用已保存的 token（页面不回显，避免密钥落在浏览器历史里）
        if (tokenInput && tokenInput.value.trim().length > 0) frpParams.token = tokenInput.value.trim();
        frpParams.useTls = tlsInput !== null && tlsInput.checked === true;
        payload.frp = frpParams;
      }
      if (btn.getAttribute('data-ngrok') === '1') {
        const authtokenInput = document.getElementById('ngrok-authtoken');
        const domainInput = document.getElementById('ngrok-domain');
        const ngrokParams = {};
        if (authtokenInput && authtokenInput.value.trim().length > 0) ngrokParams.authtoken = authtokenInput.value.trim();
        if (domainInput && domainInput.value.trim().length > 0) ngrokParams.staticDomain = domainInput.value.trim();
        payload.ngrok = ngrokParams;
      }
      btn.disabled = true;
      btn.textContent = '切换中…';
      try {
        const res = await fetch(${JSON.stringify(transportApiPath)}, {
          method: 'POST',
          headers: localControlHeaders,
          body: JSON.stringify(payload),
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
  // custom 卡片探活按钮（§10.1）：POST /api/transport/probe {url} → 结果徽标
  const probeBtn = document.getElementById('custom-probe');
  if (probeBtn !== null) {
    probeBtn.addEventListener('click', async () => {
      const input = document.getElementById('custom-url');
      const badge = document.getElementById('custom-probe-result');
      const url = input ? input.value.trim() : '';
      badge.className = 'probe-badge';
      badge.textContent = '探活中…';
      probeBtn.disabled = true;
      try {
        const res = await fetch('/api/transport/probe', {
          method: 'POST',
          headers: localControlHeaders,
          body: JSON.stringify({ url }),
        });
        const data = await res.json().catch(() => null);
        if (data === null) {
          badge.textContent = '探活失败（接口异常）';
          badge.classList.add('probe-fail');
          return;
        }
        if (data.ok === true) {
          badge.textContent = '已确认手机桥 ✓ HTTP ' + data.status + ' · ' + data.latencyMs + 'ms';
          badge.classList.add('probe-ok');
          return;
        }
        badge.textContent = data.error ? (data.error + ' · ' + data.latencyMs + 'ms') : '不可达';
        badge.classList.add('probe-fail');
      } catch (e) {
        badge.textContent = '探活失败（网络错误）';
        badge.classList.add('probe-fail');
      } finally {
        probeBtn.disabled = false;
      }
    });
  }
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
