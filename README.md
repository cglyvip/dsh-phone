# dsh-phone-bridge v3

DeepSeek Harness 的手机端桥接插件。跑在 DSH 桌面客户端进程内，把 DSH 的会话能力
暴露成手机 App 可用的 **HTTP 控制面 + WebSocket 数据面**。

- 局域网直连（手机与电脑同一 Wi-Fi），可选六种公网通道：Cloudflare 快速隧道 /
  固定域名 / frp（自建 VPS）/ 任意工具（custom）/ ngrok
- 会话全量管理：列表 / 详情 / 新建 / 改名 / 归档 / 置顶 / 搜索
- 历史消息按 turn 分页拉取
- 实时推送：用户消息、助手消息、思考过程（reasoning）、工具调用与结果、turn 边界
- 模型目录与默认模型读写
- 令牌鉴权（Bearer / `?token=`）+ 一次性配对码

> **核心红线**：发消息只走 `sessionController.prompt()`，进入 DSH 的 Agent 循环。
> 插件从不直连模型 API，也不会绕过 harness 的工具/审批机制。

配套的手机端（两个客户端仓库目前未公开，仅作项目结构说明）：

| 仓库 | 平台 |
|---|---|
| `dsh-harmony` | 鸿蒙（ArkTS / ArkUI） |
| `dsh-android` | 安卓（Kotlin / Compose） |

---

## 架构

```
index.js                 入口：配置归一化、effect 生命周期、HTTP 服务、/pair 命令
bridge/
  errors.js              统一错误码 + BridgeError + HTTP 小工具
  auth.js                TokenStore（令牌落盘）+ PairingCode（一次性配对码）
  http.js                REST 控制面路由
  ws.js                  WebSocket 数据面（hello / 事件推送 / send / stop / sync）
  eventhub.js            订阅 DSH 事件 → 规范化信封 → 缓冲 + 分发
adapter/
  dsh.js                 唯一与 DSH 服务交互的层（服务缺失返回 NOT_SUPPORTED）
  project.js             DSH 事件 → 手机线消息/事件投影（含按 turn 分页）
pair.js                  局域网地址探测 + 配对页（二维码 + 6 位配对码 + 通道切换表单）
cloudflare.js            Cloudflare 快速隧道
bridge/transport.js      公网通道管理（quick/named/frp/custom/ngrok/relay/off）
bridge/frpc.js           frpc 托管：生成 TOML、下载二进制、崩溃退避重启
bridge/ngrok.js          ngrok 托管
directories.js           只读目录浏览（旧能力，保留）
qr.cjs                   二维码生成（纯本地）
shared/version.js        版本常量
```

协议契约见 [`contract/contract.md`](contract/contract.md) 与 [`contract/types.ts`](contract/types.ts)。

---

## 安装到新 Windows 电脑

先安装 DSH 桌面端、Git 和 Node.js 20 或以上版本。启动 DSH 一次以创建 desktop profile，
确认电脑端可以正常对话，然后从托盘完全退出 DSH。

```powershell
git clone https://github.com/cglyvip/dsh-phone-bridge.git
Set-Location .\dsh-phone-bridge
.\tools\install-local.ps1
```

也可以不先 clone，直接从 GitHub 安装（脚本会浅克隆到临时目录，装完即删）：

```powershell
# GitHub 简写
.\tools\install-local.ps1 -Source cglyvip/dsh-phone-bridge

# 完整 Git 地址 + 指定分支或 tag
.\tools\install-local.ps1 -Source https://github.com/cglyvip/dsh-phone-bridge.git -Ref main

# 私有仓库（走 SSH）
.\tools\install-local.ps1 -Source git@github.com:cglyvip/dsh-phone-bridge.git
```

`-Source` 的判断顺序是「先看本地是否存在同名目录，不存在才当 Git 地址」，
所以传相对路径不会误触远程克隆。远程安装需要电脑已装 Git；临时克隆目录在安装结束
（无论成功失败）后自动删除，不会改动任何本地仓库。

下载代码不等于已经安装插件，必须执行安装脚本。脚本使用 `npm pack` 的发布文件白名单打包，
在独立临时目录用 `npm install` 安装运行依赖，再只替换 `node_modules/dsh-phone-bridge`。
依赖保留在插件自己的 `node_modules` 中，不在整个 desktop profile 上运行 npm，
不改动 DSH 自带组件或其他插件目录。

默认 desktop profile 位于 `$env:DSH_HOME\profiles\desktop`；没有设置 `DSH_HOME` 时使用
`$env:USERPROFILE\.dsh\profiles\desktop`。如果 DSH 使用自定义目录，显式指定：

```powershell
.\tools\install-local.ps1 -Source 'D:\Projects\dsh-phone-bridge' -ProfileRoot 'D:\DSHData\profiles\desktop'
```

安装前会在 profile 目录备份现有 `package.json` 和 `package-lock.json`，旧桥插件移动到
`.dsh-plugin-backups/` 保留。本地安装归档保存在 profile 的 `.dsh-local-packages/`，只合并
桥插件的依赖登记和 bundle，其他配置保留；后续安装不依赖源码目录是否仍在原位置。
独立临时安装目录也会保留，便于排查。发现目录是 junction 或符号链接时脚本会停止，请先核对
实际 profile 路径；不会跟随链接覆盖其他目录。脚本不删除电脑会话、配对令牌或公网配置，
也不会自动重启 DSH。安装失败时先处理具体报错，不要直接启动 DSH 继续使用半安装状态。

安装后重新启动 DSH，在**这台电脑的浏览器**打开：

```text
http://127.0.0.1:9000/api/health
http://127.0.0.1:9000/pair
```

健康接口需要返回插件版本，配对页需要显示二维码与 6 位配对码。随包配置端口为 9000，宿主
只覆盖部分配置时可能使用代码缺省端口 8787；端口被占用时还会尝试后续端口。请以启动日志、
`/pair` 输出或 `$DSH_HOME/phone-bridge/runtime.json` 的 `port` 为准，不要只认 9000。
profile 的 `cordis.patch.yml` 只放按 `id: phone-bridge` 的配置覆盖，**不要再次 `insert`**。

---

## 配置

见 `cordis.patch.yml`，字段说明：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `host` | `0.0.0.0` | 监听地址（改 `127.0.0.1` 则只有本机能连） |
| `port` | `9000` | 端口，被占用自动 +1 重试（最多 10 次） |
| `authMode` | `token` | `token` / `none`（`none` 禁止用于发布） |
| `tokenTtlDays` | `7` | 令牌有效期 |
| `pairingMode` | `lan` | `lan` / `disabled` |
| `allowOrigins` | `[]` | CORS 白名单 |
| `publicUrl` | `''` | 公网地址（填了优先用它生成配对二维码） |
| `tunnelMode` | 按 `cloudflareTunnel` 推断 | `off` / `quick` / `named` / `frp` / `custom` / `ngrok` / `relay` |
| `frp.serverAddr` | `''` | frps 的地址或域名 |
| `frp.serverPort` | `7000` | frps 的 bindPort |
| `frp.token` | `''` | frps 的 `auth.token`，公网暴露必须填 |
| `frp.remotePort` | `0` | 映射到公网的端口，`0` 表示由 frps 随机分配 |
| `frp.useTls` | `false` | frps 开了 `transport.tls` 才置 `true` |
| `ngrok.authtoken` | `''` | ngrok 的 authtoken |
| `ngrok.staticDomain` | `''` | ngrok 固定域名（有付费域名时填） |
| `cloudflareTunnel` | `off` | `off` / `pair` / `startup` |
| `cloudflaredPath` | `cloudflared` | cloudflared 可执行文件 |
| `cloudflaredProtocol` | `auto` | Cloudflare 连接协议：`auto` / `http2` / `quic` |
| `cloudflaredDnsResolvers` | `[]` | 仅为 cloudflared 子进程指定 DNS，格式为 `address:port` 数组，不改系统 DNS |
| `logLevel` | `info` | `info` / `silent` |

令牌文件：`$DSH_HOME/phone-bridge/tokens.json`（默认 `$env:USERPROFILE\.dsh\phone-bridge\tokens.json`）。

通道参数文件：`$DSH_HOME/phone-bridge/transport.json`（chmod 600，**优先级高于插件配置**）。
在配对页点「保存并切换」写入的就是它；换电脑时只改这一处，不用动 YAML。

---

## 公网通道

### 免费服务适配目录

配对页的「选择穿透服务」包含 14 项接入方案。目录免费条件按 2026-11-17 官方页面核查，
不承诺第三方节点长期在线、无限流量或所有套餐都可用；以服务商当前账号、节点和条款为准。

| 服务 | 接入方式 | 免费条件 / 准备 |
|---|---|---|
| 标准 frp / 自建 frps | 桥托管官方 frpc | frp 开源免费；服务器与带宽另计，需 frps 地址和 `auth.token` |
| Cloudflare 快速隧道 | 桥托管 cloudflared | 无需账号的临时测试地址，不保证在线时间 |
| Cloudflare 固定域名 | 官方配置隧道后填域名 | 需要账号、自有域名和运行中的 cloudflared |
| ngrok | 桥托管官方客户端 | 需要账号与 authtoken，免费开发域名自动分配，受用量限制 |
| [OpenFrp](https://docs.openfrp.net/use/) | 官方启动器 → 公网地址接入 | 基础免费服务，按面板创建隧道 |
| [樱花 Frp](https://doc.natfrp.com/) | 官方启动器 → 公网地址接入 | 免费节点、流量及实名要求以官方为准 |
| [NATAPP](https://natapp.cn/article) | 官方客户端 → 公网地址接入 | 免费 HTTP/TCP 服务有额度限制，不含免费 HTTPS |
| [cpolar](https://www.cpolar.com/docs) | 官方客户端 → 公网地址接入 | 免费计划，临时地址及额度以官方为准 |
| [Sunny-Ngrok](https://www.ngrok.cc/docs) | 官方客户端 → 公网地址接入 | 有带宽、流量和隧道数量限制的免费体验 |
| [ChmlFrp](https://docs.chmlfrp.net/) | 官方客户端 → 公网地址接入 | 提供免费套餐，节点和条件以官方面板为准 |
| [LocalTunnel](https://github.com/localtunnel/localtunnel) | 官方 npm 客户端 → 公网地址接入 | 公共测试节点可能显示验证页，不保证可用性 |
| [localhost.run](https://localhost.run/docs/) | 系统 OpenSSH → 公网地址接入 | 临时免费域名，无需安装额外客户端 |
| [zrok](https://netfoundry.io/docs/zrok/get-started/) | 对应版本官方客户端 → 公网地址接入 | 开源与托管免费选项，zrok2 与旧版命令不能混用 |
| [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) | 官方客户端 → 公网地址接入 | 需要账号、HTTPS、MagicDNS 和 Funnel 策略授权 |

服务商客户端需将本机目标指向 `127.0.0.1:<实际桥端口>`，并转发 HTTP 与 WebSocket。
OpenFrp、樱花等专用启动密钥不是标准 frps 的 `auth.token`，不可填进标准 frp 表单。
未知服务只要提供直接 HTTP(S) 端点或 TCP 转发，也可使用公网地址接入；UDP-only 隧道不可用。

支持粘贴 `tcp://主机:端口` 并转换为 `http://主机:端口`。保存前会检查 `/api/health` 的桥身份
与协议版本，拒绝服务商登录页、验证页、广告页和重定向；公网配对码接口必须返回 403。
验证失败不会切走当前连接或覆盖已保存的配置。不要启用把公网 Host 改为 localhost 的选项。
这些验证不等于对每家服务的真实账号、节点、媒体下载和 WebSocket 全量回归。

### Cloudflare DNS 或网络协议报错

看到 `Bad DNS packet`、SRV 解析失败或 QUIC 不通时，可在插件配置里显式指定：

```yaml
- id: phone-bridge
  config:
    port: 8787
    cloudflaredPath: C:/实际路径/cloudflared.exe
    cloudflaredProtocol: http2
    cloudflaredDnsResolvers:
      - 1.1.1.1:53
      - 8.8.8.8:53
```

端口和路径必须使用本机实际值。DNS 配置仅传给子进程，不修改操作系统；若公司网络禁止访问
这些 DNS，请使用网络管理员提供的可用解析器。桥收到连接注册成功日志后才会标记隧道就绪。

`tunnelMode` 决定手机从哪条路连进来，六种任选其一：

| 模式 | 需要准备 | 说明 |
|---|---|---|
| `off` | 无 | 只走局域网，手机和电脑同一 Wi-Fi |
| `quick` | 已安装并可执行的 `cloudflared` | Cloudflare 快速隧道，地址每次重启都可能变化 |
| `named` | CF 账号 + 域名 | Cloudflare 固定域名隧道 |
| `frp` | 一台公网 VPS + frps | 自建，端口可控，推荐长期用 |
| `custom` | 任意内网穿透工具 | 自己起进程，只把公网地址填进 `publicUrl` |
| `ngrok` | ngrok 账号 | 需要 authtoken |

### 方案一：已有公网服务器，使用 frp

不用手改 YAML，插件装好后在**那台电脑**的浏览器打开：

```
http://127.0.0.1:9000/pair
```

页面里 `frp` 卡片自带表单，填五项：

1. `serverAddr` —— VPS 地址或域名，例如 `1.2.3.4`
2. `serverPort` —— frps 的 bindPort，默认 `7000`
3. `remotePort` —— 想映射到公网的端口；填 `0` 让 frps 随机分配
4. `token` —— frps 配置里的 `auth.token`
5. 勾 `启用 TLS` —— 仅当 frps 开了 `transport.tls`

点「保存并切换」，桥会自动下载托管 `frpc.exe` 并连上 VPS，二维码里的地址随即变成
`<公网IP>:<remotePort>`。以通道状态显示「运行中」及实际公网地址为准，成功保存的参数写入
`transport.json`，重启时读取。

**两台电脑不能同时占用同一个 VPS 的同一个 remotePort。** 如果新电脑要沿用旧电脑的公网
地址，先停止旧电脑上的该 frp 通道；如果两台电脑都要在线，就给新电脑换一个 remotePort。
VPS 防火墙/安全组需要放行 frps 的 bindPort 与映射端口，frps 如果设置了 `allowPorts`，
新端口还必须在允许范围内。出现 `port already used` 时先检查旧电脑是否仍占用该端口。

frps 上的代理名同样是全局唯一的，同一台 frps 上同一个代理名只能有一个连接占用。
v3.7.2 起代理名按本机唯一化，形如 `dsh-phone-bridge-<主机名>-<哈希8位>`：多台电脑连
同一台 frps 不会再互相撞名，同一台电脑重启后名字保持稳定，已配对的手机不受影响
（手机连的是 `公网IP:remotePort`，与代理名无关）。

如果本机 DSH 被强杀或崩溃，Windows 上已经启动的 `frpc.exe` 不会跟着退出，会继续占着
代理名和 `remotePort`。桥在每次启动 frpc 前会先清理这份遗留进程，所以正常退出重启
不必手动处理。万一仍报 `already exists`，先看任务管理器里有没有残留的 `frpc.exe`
并结束它，再重启 DSH。桥识别到这类冲突仍会按 30/60/90/120 秒自动退避重连，最多 4 次，
配对页显示「N 秒后自动重试」；4 次都没成，按提示清理遗留进程或换 `remotePort`。

`token` 留空只表示保留**这台电脑已保存的** frps 密钥；新电脑首次配置仍须输入服务器密钥。
它不会自动从旧电脑取回，也不能用手机的配对令牌替代。

### 方案二：没有 VPS，使用 Cloudflare 快速隧道

在新电脑先安装 Cloudflare 官方 `cloudflared`，并确认 PowerShell 中可以运行：

```powershell
cloudflared --version
```

可用系统已有的 winget 安装官方包：

```powershell
winget install --id Cloudflare.cloudflared --exact
```

安装后重新打开 DSH，让它继承更新后的 PATH。也可在插件配置中把 `cloudflaredPath` 指向
实际的 `cloudflared.exe` 完整路径。当前桥不会自动安装 `cloudflared`。

电脑浏览器打开 `/pair`，选择「Cloudflare 快速隧道」，等待状态变为「运行中」，获取本次
`https://...trycloudflare.com` 地址。此方案通常无需填写服务器地址或账号密钥；需要电脑能访问
Cloudflare。快速隧道重启后地址可能变化，手机必须更新地址并按需要重新配对。

### 手机连接新电脑

1. 在新电脑的本机配对页取得公网二维码和 6 位配对码。
2. 手机进入「电脑管理」→「扫码配对」；或「添加电脑」填写名称及**当前实际公网地址**。
3. frp 示例为 `http://你的VPS地址:映射端口`；Cloudflare 示例为
   `https://本次生成的域名.trycloudflare.com`。手机不填 `127.0.0.1` 或 `192.168.x.x`。
4. 输入新电脑刚生成的 6 位配对码，成功后再进入会话列表。
5. 手机关闭 Wi-Fi、使用移动数据重新连接，确认它确实通过公网访问。

新电脑与旧电脑有各自独立的配对令牌。即使公网域名和端口不变，旧电脑生成的码或手机存下的
旧令牌也不能直接用于新电脑；应在手机为新电脑重新配对。电脑需要一直运行 DSH 与公网通道。

### 公网连接失败时按顺序检查

1. 电脑本机 `http://127.0.0.1:实际端口/api/health` 打不开：先解决插件安装、DSH 启动或端口问题。
2. 配对页通道不是「运行中」：查看通道具体错误。frp 查服务器、密钥、端口占用；Cloudflare 查
   `cloudflared` 是否可执行和外网连通。
3. 电脑本机正常、手机公网不通：核对当前公网地址及服务器防火墙/端口映射。
4. 手机出现未授权：使用新电脑配对页重新生成的码完成配对。
5. 保存或切换失败时保留页面的具体错误信息，不要反复换地址或关闭令牌鉴权。

安全约定：

- `token` / `authtoken` 只写进 `transport.json`（chmod 600），**任何页面与接口都不回显**；
  页面只提示「已保存，留空则不修改」，留空保存即沿用原值。
- 配对页与配对码接口只对本机回环地址开放。走 frp 时 Host 头是 `VPS:remotePort`，
  非回环，公网侧无法自助取配对码；云端隧道用改写 Host 的方式同样被 403。
- 手机拿到公网地址后仍需配对码 + 令牌鉴权才能连。

---

## 配对

1. 插件启动后，在电脑浏览器打开 `http://127.0.0.1:9000/pair`
   （仅本机可访问），页面上有二维码与 6 位配对码。
2. 或在 DSH 对话里执行 `/pair`，会直接输出地址与配对码。
3. 手机 App 扫码，或手填 `ws://<局域网IP>:9000` + 配对码。

---

## 开发与自测

```powershell
cd dsh-phone-bridge
node smoke-test.mjs
```

`smoke-test.mjs` 用一个假 cordis ctx 把插件跑起来，端到端验证 77 项
（REST 全部路由 + 鉴权 + 配对码一次性 + 按 turn 分页 + WS 握手/推送/过滤/增量/补拉
+ 六种公网通道切换与参数落盘 + `/api/media` 会话内媒体转出）。

专项回归：

```powershell
node --test tools/test-cloudflare-startup.mjs tools/test-transport-startup.mjs tools/test-tunnel-providers.mjs tools/test-provider-page.mjs tools/test-transport-validation.mjs
```

---

## 版本

- v2.0.0：原型，只有聊天，直连模型
- v3.0.0：重写，接入 `sessionController` 全量会话能力（见 `CHANGELOG.md`）
- v3.5.0：六种公网通道 + 配对页可视化切换
- v3.5.1：配对页补齐 frp 参数表单，换电脑不必手改 YAML
- v3.6.0：14 项穿透服务目录、严格地址验证、本机通道控制和新电脑安装流程
- v3.7.0：会话内媒体转出，电脑端交付的视频手机能收到（`media:v1.` 绝对路径 + 白名单校验）
- v3.7.1：frp 代理名冲突可识别并自动退避重连（不再卡在「正在启动」）
- v3.7.2：frp 代理名按本机唯一化 + 启动前清理遗留 frpc，多台电脑连同一台 frps 不再撞名
- v3.7.3：安装脚本兼容 npm 在包内生成的自引用链接（新版本 npm 下安装不再被拦）
- v3.8.0：官方中转通道，用户不用买 VPS / 配 frps，填个配对码手机就能连上电脑

---

## 许可

[MIT](LICENSE)
