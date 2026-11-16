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

配套的手机端：

| 仓库 | 平台 |
|---|---|
| [dsh-harmony](https://github.com/cglyvip/dsh-harmony) | 鸿蒙（ArkTS / ArkUI） |
| [dsh-android](https://github.com/cglyvip/dsh-android) | 安卓（Kotlin / Compose） |

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

## 安装（本机）

1. 把整个 `dsh-phone-bridge` 目录复制到
   `C:\Users\CGLY\.dsh\profiles\desktop\node_modules\dsh-phone-bridge\`
2. 确认 profile 的 `package.json` 里：
   - `dependencies` 含 `"dsh-phone-bridge": "3.5.1"`
   - `dsh.profile.bundles` 数组含 `"dsh-phone-bridge"`
3. profile 的 `cordis.patch.yml` **只放按 id 的配置覆盖**（不要再 `insert`，否则会加载两次）
4. **完全退出 DSH（托盘右键退出）再启动**

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
| `logLevel` | `info` | `info` / `silent` |

令牌文件：`$DSH_HOME/phone-bridge/tokens.json`（默认 `C:\Users\CGLY\.dsh\phone-bridge\tokens.json`）。

通道参数文件：`$DSH_HOME/phone-bridge/transport.json`（chmod 600，**优先级高于插件配置**）。
在配对页点「保存并切换」写入的就是它；换电脑时只改这一处，不用动 YAML。

---

## 公网通道

`tunnelMode` 决定手机从哪条路连进来，六种任选其一：

| 模式 | 需要准备 | 说明 |
|---|---|---|
| `off` | 无 | 只走局域网，手机和电脑同一 Wi-Fi |
| `quick` | 无 | Cloudflare 快速隧道，地址每次重启都变 |
| `named` | CF 账号 + 域名 | Cloudflare 固定域名隧道 |
| `frp` | 一台公网 VPS + frps | 自建，端口可控，推荐长期用 |
| `custom` | 任意内网穿透工具 | 自己起进程，只把公网地址填进 `publicUrl` |
| `ngrok` | ngrok 账号 | 需要 authtoken |

### 换到另一台电脑：frp 怎么填

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
`<公网IP>:<remotePort>`。填完的参数落在 `transport.json`，**重启 DSH 也不会丢**。

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

`smoke-test.mjs` 用一个假 cordis ctx 把插件跑起来，端到端验证 70 项
（REST 全部路由 + 鉴权 + 配对码一次性 + 按 turn 分页 + WS 握手/推送/过滤/增量/补拉
+ 六种公网通道切换与参数落盘）。

---

## 版本

- v2.0.0：原型，只有聊天，直连模型
- v3.0.0：重写，接入 `sessionController` 全量会话能力（见 `CHANGELOG.md`）
- v3.5.0：六种公网通道 + 配对页可视化切换
- v3.5.1：配对页补齐 frp 参数表单，换电脑不必手改 YAML
