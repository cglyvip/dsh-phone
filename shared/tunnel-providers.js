export const TUNNEL_PROVIDERS = [
  {
    id: 'self', name: '标准 frp / 自建 frps', mode: 'frp', managed: true,
    homepage: 'https://github.com/fatedier/frp', docs: 'https://gofrp.org/zh-cn/docs/',
    freePlan: 'frp 开源免费；公网服务器、带宽与域名费用另计。',
    fields: 'serverAddr=VPS 地址；serverPort=frps bindPort；token=frps auth.token；remotePort=映射端口。',
    notes: '仅标准 frps 的配置与认证参数适用。服务商专用启动密钥不可填入 auth.token；两台电脑不可占用同一映射端口。',
    requirements: ['可连接的标准 frps 服务器', '服务器地址、bindPort、auth.token 与可用映射端口'],
    steps: ['在服务器配置 frps 并放行控制端口与映射端口。', '在下方标准 frp 表单填写服务器参数。', '两台电脑不可同时占用同一个映射端口。'],
    commands: [], supports: { http: true, websocket: true },
  },
  {
    id: 'cloudflare-quick', name: 'Cloudflare 快速隧道', mode: 'quick', managed: true,
    homepage: 'https://developers.cloudflare.com/tunnel/',
    docs: 'https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/',
    freePlan: '无需账号的临时测试隧道；域名会变化，受官方使用限制约束。',
    requirements: ['安装 Cloudflare 官方 cloudflared', '电脑可以访问 Cloudflare 边缘网络'],
    steps: ['安装官方 cloudflared 并确认可执行。', '选择 Cloudflare 快速隧道，等待连接注册成功。', '扫码使用本次生成的 HTTPS 地址。'],
    commands: [], supports: { http: true, websocket: true },
  },
  {
    id: 'cloudflare-named', name: 'Cloudflare 固定域名隧道', mode: 'named', managed: false,
    homepage: 'https://www.cloudflare.com/',
    docs: 'https://developers.cloudflare.com/tunnel/',
    freePlan: 'Cloudflare Tunnel 提供免费接入；需自有域名，域名费用另计。',
    requirements: ['Cloudflare 账号与已接入的域名', '通过官方面板部署并运行 cloudflared'],
    steps: ['在 Cloudflare 面板创建隧道并部署官方客户端。', '将公开主机名映射到 http://127.0.0.1:{port}。', '在固定域名通道填写 HTTPS 域名并验证桥服务。'],
    commands: [], supports: { http: true, websocket: true },
  },
  {
    id: 'ngrok', name: 'ngrok', mode: 'ngrok', managed: true,
    homepage: 'https://ngrok.com/', docs: 'https://ngrok.com/docs/pricing-limits/free-plan-limits',
    freePlan: '官方提供免费计划；域名、请求及流量额度以账号面板为准。',
    requirements: ['ngrok 账号与 authtoken', '使用账号自动分配的免费开发域名；静态域名字段选填'],
    steps: ['在 ngrok 官方控制台取得 authtoken。', '在 ngrok 表单填写密钥，域名留空时使用账号获分配的开发域名。', '探活必须返回手机桥 JSON，验证页不能作为连接成功。'],
    commands: ['ngrok http {port}'], supports: { http: true, websocket: true },
  },
  {
    id: 'openfrp', name: 'OpenFrp', mode: 'custom', managed: false,
    homepage: 'https://www.openfrp.net/', docs: 'https://docs.openfrp.net/use/',
    freePlan: '提供免费服务；节点、账号及可用额度以官方面板为准。',
    requirements: ['OpenFrp 账号', 'OpenFrp 官方启动器或专用客户端'],
    steps: ['在官方面板创建 HTTP 或 TCP 隧道。', '本机目标填写 127.0.0.1:{port}，使用官方客户端启动。', '复制面板给出的公网地址，在此验证后保存。', '启动访问密钥不能当作标准 frps 的 auth.token。'],
    commands: [], supports: { http: true, websocket: true },
  },
  {
    id: 'natfrp', name: '樱花 Frp', mode: 'custom', managed: false,
    homepage: 'https://www.natfrp.com/', docs: 'https://doc.natfrp.com/',
    freePlan: '提供免费接入选项；实名、签到、节点及流量条件以官方面板为准。',
    requirements: ['樱花 Frp 账号', '樱花 Frp 官方启动器或专用 frpc'],
    steps: ['在官方面板创建 HTTP 或 TCP 隧道。', '本机目标填写 127.0.0.1:{port}，按官方文档启动。', '复制运行中的公网地址，验证后保存。', '官方启动访问密钥不等于标准 frps 的 auth.token。'],
    commands: [], supports: { http: true, websocket: true },
  },
  {
    id: 'natapp', name: 'NATAPP', mode: 'custom', managed: false,
    homepage: 'https://natapp.cn/', docs: 'https://natapp.cn/article',
    freePlan: '提供有额度限制的免费 HTTP/TCP 隧道；免费服务不含 HTTPS，具体限制以官方面板为准。',
    requirements: ['NATAPP 账号与隧道 authtoken', 'NATAPP 官方客户端'],
    steps: ['在官方面板申请合适的 HTTP 或 TCP 隧道。', '将隧道本地端口设为 {port}。', '运行官方客户端后复制公网地址，验证后保存。'],
    commands: [], supports: { http: true, websocket: true },
  },
  {
    id: 'cpolar', name: 'cpolar', mode: 'custom', managed: false,
    homepage: 'https://www.cpolar.com/', docs: 'https://www.cpolar.com/docs',
    freePlan: '提供免费计划；地址有效期、带宽与并发条件以官方说明为准。',
    requirements: ['cpolar 账号与已登录的官方客户端'],
    steps: ['安装并登录 cpolar 官方客户端。', '创建本机端口为 {port} 的 HTTP 隧道。', '复制公网 HTTP(S) 地址，验证后保存。'],
    commands: ['cpolar http {port}'], supports: { http: true, websocket: true },
  },
  {
    id: 'sunny-ngrok', name: 'Sunny-Ngrok', mode: 'custom', managed: false,
    homepage: 'https://www.ngrok.cc/', docs: 'https://www.ngrok.cc/docs',
    freePlan: '官方提供有带宽、流量与隧道数量限制的免费体验服务，实际额度以当前面板为准。',
    requirements: ['Sunny-Ngrok 账号与已开通隧道', '服务商官方客户端'],
    steps: ['按官方面板申请支持 HTTP 或 TCP 的隧道。', '本机目标设为 127.0.0.1:{port}。', '用官方客户端启动，复制公网地址验证后保存。', '此服务与 ngrok 官方 authtoken、标准 frps token 不通用。'],
    commands: [], supports: { http: true, websocket: true },
  },
  {
    id: 'localtunnel', name: 'LocalTunnel', mode: 'custom', managed: false,
    homepage: 'https://localtunnel.github.io/www/', docs: 'https://github.com/localtunnel/localtunnel',
    freePlan: '开源客户端与公共测试服务；公共节点可要求验证且不保证可用性。',
    requirements: ['Node.js 与 npm', '公网端点没有阻挡手机桥的验证页'],
    steps: ['使用官方 npm 客户端映射本机端口。', '复制打印的 HTTPS 地址。', '若探活收到验证页面，先按官方说明完成处理，不能当作手机桥在线。'],
    commands: ['npx localtunnel --port {port}'], supports: { http: true, websocket: true },
  },
  {
    id: 'localhost-run', name: 'localhost.run', mode: 'custom', managed: false,
    homepage: 'https://localhost.run/', docs: 'https://localhost.run/docs/',
    freePlan: '提供免费 SSH 临时隧道；地址与可用性限制以官方当前说明为准。',
    requirements: ['系统 OpenSSH 客户端', '允许出站 SSH 连接'],
    steps: ['用 SSH 反向隧道连接官方服务。', '保持 SSH 进程运行并复制生成的 HTTPS 地址。', '在此验证公网手机桥后保存。'],
    commands: ['ssh -R 80:localhost:{port} localhost.run'], supports: { http: true, websocket: true },
  },
  {
    id: 'zrok', name: 'zrok', mode: 'custom', managed: false,
    homepage: 'https://zrok.io/', docs: 'https://netfoundry.io/docs/zrok/get-started/',
    freePlan: '开源工具及托管服务免费选项；注册与服务限制以官方当前说明为准。',
    requirements: ['安装与服务端相符的官方客户端；当前主线为 zrok2', '账号或自建 zrok 服务'],
    steps: ['按当前官方文档启用客户端环境；zrok 0.x 与 zrok2 命令不可混用。', '在客户端公开共享本机 http://127.0.0.1:{port}。', '复制公开分享地址，验证手机桥后保存。'],
    commands: [], supports: { http: true, websocket: true },
  },
  {
    id: 'tailscale-funnel', name: 'Tailscale Funnel', mode: 'custom', managed: false,
    homepage: 'https://tailscale.com/', docs: 'https://tailscale.com/docs/features/tailscale-funnel',
    freePlan: '各计划可使用测试阶段的 Funnel，受账号策略与官方端口等限制约束。',
    requirements: ['Tailscale 账号与官方客户端；Windows 上以管理员权限操作', '按官方要求启用 MagicDNS、HTTPS 与 Funnel 策略'],
    steps: ['在新电脑安装并登录 Tailscale。', '确认账号策略允许 Funnel 后，公开本机桥端口。', '复制 HTTPS 的 ts.net 地址，验证后保存；手机无需加入私有 tailnet。'],
    commands: ['tailscale funnel {port}'], supports: { http: true, websocket: true },
  },
  {
    id: 'chmlfrp', name: 'ChmlFrp', mode: 'custom', managed: false,
    homepage: 'https://www.chmlfrp.net/', docs: 'https://docs.chmlfrp.net/',
    freePlan: '服务商提供的免费节点与使用条件需以官方当前面板为准。',
    requirements: ['ChmlFrp 账号', '按官方指引安装客户端并创建隧道'],
    steps: ['在官方面板创建支持 HTTP 或 TCP 的隧道。', '将本地目标设为 127.0.0.1:{port}，运行对应官方客户端。', '复制实际公网地址，验证手机桥后保存。'],
    commands: [], supports: { http: true, websocket: true },
  },
];

export const FRP_PROVIDERS = TUNNEL_PROVIDERS.filter(provider => provider.mode === 'frp');

export function getTunnelProvider(id) {
  const provider = TUNNEL_PROVIDERS.find(candidate => candidate.id === id);
  if (provider === undefined) throw new Error(`未知穿透服务：${id}`);
  return provider;
}

export function providerCommands(providerId, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('本机桥端口必须是 1 到 65535 的整数');
  }
  return getTunnelProvider(providerId).commands.map(command => command.replaceAll('{port}', String(port)));
}
