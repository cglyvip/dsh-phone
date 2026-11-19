# DSH 中转服务（relay）· 部署与实现规格

> 交给服务器 AI 执行。本文是**唯一规格来源**，照做即可。
> 读者：负责在 Linux 服务器上架设中转服务的一方。
> 编写日期：2026-11-19

---

## 0. 这份服务要干什么（先读这一段）

现有架构里，用户手机要连上自己电脑上的 DSH 桥，必须二选一：
给电脑搞一条公网通道（frp / Cloudflare Tunnel / ngrok…），或者手机和电脑同一个 WiFi。

**商业软件不能要求用户去买 VPS、配 frps、填端口。** 所以需要一个由我们自己提供的中转服务：

```
用户电脑（NAT 后面）──出站 WSS──▶ relay.域名 ◀──WSS── 用户手机
```

- 电脑主动拨出长连接，不需要公网 IP、不需要端口映射、不需要用户做任何网络配置
- 手机也主动拨出，两端靠「配对码」在服务端会合，由服务端按连接 ID 转发字节
- 服务端**只转发，不解析业务内容**（消息体后续在客户端做端到端加密）

**这个服务不是 frp，也不是 rathole/bore。** 那些是按「端口映射」设计的，
做不到「用户零配置 + 按配对码动态路由」。必须自己写。

---

## 1. 一句话验收标准

在任意一台能上网的 Windows 电脑上：

1. 装好桥插件，配对页把通道选成「官方中转」，填上配对码
2. 手机 App 输入同一个配对码
3. **不加任何端口映射、不动路由器、不买 VPS**，手机就能正常连上电脑

达到这个就算成功。

---

## 2. 服务器要求

| 项 | 要求 |
|---|---|
| 系统 | Linux（Debian 12 / Ubuntu 22.04+ 最佳） |
| 配置 | 1 核 1G 起（纯文字流量，非常轻） |
| 带宽 | 1Mbps 起，建议 5Mbps+（视频很少，见 §9） |
| 软件 | Node.js 20+，Nginx（或 Caddy）做 TLS 终止，systemd |
| 端口 | 只需开放 **443**（手机/电脑都走它）；可选开放 80 做证书续期 |

**不需要**开放大量端口。这是本方案相对 frp 的核心优势：一个 443 端口，
服务任意多个用户（frp 是每个用户占一个端口）。

### 域名

| 项 | 值 |
|---|---|
| 域名 | 你已有的域名，建议用子域名，例如 `relay.example.com` |
| DNS | 一条 A 记录指向服务器公网 IP（如果你用 IPv6，再加一条 AAAA） |
| 证书 | Let's Encrypt，用 certbot 自动续期 |

TLS 是**必须**的：手机 App 只接受 `https://` / `wss://`，明文会被系统拦掉。

---

## 3. 架构

```
                  ┌──────────────────────────────┐
                  │   relay.example.com (443)    │
                  │   Nginx: TLS 终止 + 反代      │
                  └──────────────┬───────────────┘
                                 │ 127.0.0.1:8080 (明文 HTTP/WS)
                  ┌──────────────▼───────────────┐
                  │   relay 服务 (Node.js)        │
                  │                              │
                  │   连接表 room → { bridge, phone } │
                  │   配对码 → roomId 映射          │
                  └───────┬──────────────┬───────┘
                          │              │
              ┌───────────▼───┐   ┌──────▼─────────┐
              │  /bridge 端点  │   │  /public 端点   │
              │  电脑拨入      │   │  手机拨入       │
              └───────────────┘   └────────────────┘
```

**三个端点：**

| 端点 | 谁连 | 用途 |
|---|---|---|
| `wss://relay.example.com/bridge` | 电脑桥插件 | 电脑出站长连接，注册自己的配对码 |
| `wss://relay.example.com/public/<pairCode>/...` | 手机 App | 手机按配对码连进来，服务端把它和电脑配成一对 |
| `https://relay.example.com/api/health` | 运维探活 | 健康检查，返回 `{status:'ok'}` |

**关键设计：手机端不需要改协议。**
手机现在是这样拼地址的（`dsh-harmony/entry/src/main/ets/net/ApiClient.ets:93`）：

```ts
baseUrl() + '/api/sessions'      → https://host/api/sessions
wsUrl()  → wss://host/ws?token=xxx
```

只要让**手机上填的地址**变成 `https://relay.example.com/p/<pairCode>`，
它就会自动拼出 `https://relay.example.com/p/<pairCode>/api/sessions` 和
`wss://relay.example.com/p/<pairCode>/ws?token=xxx`。
服务端把这些路径原样转发给对应的电脑即可 —— **手机 App 一行代码都不用改**。

---

## 4. 协议规格（这是实现的核心）

### 4.1 电脑端 → relay：出站注册

电脑桥插件（Windows 侧）会主动连：

```
wss://relay.example.com/bridge
Header: Authorization: Bearer <relayToken>
```

其中 `relayToken` 是用户在配对页填的「中转密钥」（可以就是配对码，见 §4.4）。

连上后电脑发第一帧 JSON：

```json
{ "type": "register", "pairCode": "a1b2c3d4", "bridgeVersion": "3.7.3", "contractVersion": 3 }
```

`pairCode` 由电脑生成（8 位小写字母+数字），**同时显示在电脑配对页和二维码里**，
用户把它抄到手机上一次即可，之后手机记住。

服务端校验后回：

```json
{ "type": "registered", "pairCode": "a1b2c3d4" }
```

此后这条连接就是该 `pairCode` 的**上行通道**。

### 4.2 手机端 → relay：按配对码拨入

手机把地址填成 `https://relay.example.com/p/a1b2c3d4`，于是所有请求都带上前缀：

```
GET  /p/a1b2c3d4/api/sessions
POST /p/a1b2c3d4/api/pair
WS   /p/a1b2c3d4/ws?token=xxx
```

服务端处理：

1. 从路径里取出 `a1b2c3d4`
2. 查连接表，找到这台电脑的上行通道
3. **剥掉 `/p/a1b2c3d4` 前缀**，把剩下的 `/api/sessions`（或 `/ws?token=xxx`）转发给电脑
4. 把电脑的响应原样回给手机

WebSocket 也一样：服务端建立两条独立的 WS，然后把字节双向对拷。

### 4.3 HTTP 转发：必须逐字节保真

不能只转发「状态码 + JSON」，下面这些必须原样透传，否则手机端的媒体、上传、断点补拉全会坏：

**请求方向（手机 → 电脑）要透传：**
- `Authorization` 头（手机带 `Bearer dsb_xxx`）
- `Content-Type`、`Content-Length`
- `Range`（视频拖动进度条要用）
- 请求体原始字节（上传附件）

**响应方向（电脑 → 手机）要透传：**
- 状态码
- `Content-Type`、`Content-Length`、`Content-Range`、`Accept-Ranges`
- `Cache-Control`、`ETag`
- 响应体原始字节（**不能当成文本解码再编码**，图片/视频会损坏）

**明确不要做的：**
- 不要加 `Transfer-Encoding: chunked` 破坏 Content-Length
- 不要把 `Content-Encoding` 解压后重发
- 不要改写 JSON 内容

### 4.4 配对码的生成与生命周期

| 项 | 规则 |
|---|---|
| 生成方 | **电脑端生成**（桥插件），服务端只做登记 |
| 格式 | 8 位，`[a-z0-9]`，例如 `a1b2c3d4` |
| 唯一性 | 服务端登记时若已被占用，回 `{type:'error', code:'CODE_TAKEN'}`，电脑重新生成 |
| 有效期 | 不主动过期（是长期配对码，不是临时验证码）；电脑离线后从连接表移除 |
| 更换 | 用户在电脑配对页点「重置中转配对码」时重新生成，旧码立即失效 |

> 注意区分：桥自己的 6 位**配对码**（10 分钟一次性，用来换 Bearer 令牌）
> 和中转的 8 位**长期配对码**是两回事。后者只是「找到那台电脑」的地址，
> 不是身份凭证 —— 真正的身份验证仍由桥的 Bearer 令牌负责，服务端不参与。

### 4.5 电脑离线时怎么办

手机请求进来但对应 `pairCode` 没有在线电脑时，返回：

```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/json

{ "error": { "code": "BRIDGE_OFFLINE", "message": "电脑端未连接中转服务" } }
```

`BRIDGE_OFFLINE` 是桥协议里已有的错误码（见 `bridge/errors.js`），手机端已认识它。
如果连接正好在转发中途断开，返回 504 更合适。

### 4.6 心跳与断线检测

| 方向 | 规则 |
|---|---|
| 电脑 → relay | 每 20 秒发一次 WS `ping`（或文本帧 `{"type":"ping"}`），40 秒没收到任何帧判定离线 |
| 手机 ↔ relay | 手机 App 自己的 `ping`/`pong` 是桥协议层的，服务端原样转发，不拦截 |
| 断线重连 | 电脑侧断线后自动重连（指数退避 1s/2s/4s/8s/16s，最多 5 次），服务端重新登记即可 |
| 重复登记 | 同一电脑重连时，新连接顶掉旧连接（旧连接关掉），避免残留占用 |

---

## 5. 安全要求（必须做到）

### 5.1 TLS
- 必须 HTTPS/WSS，用 Let's Encrypt 证书，自动续期
- 禁止 HTTP 明文对外（80 端口只做 301 跳 443，或只留给 certbot）

### 5.2 中转密钥
- 电脑连 `/bridge` 时带的 `Authorization: Bearer <relayToken>`
- 这个 token 由你们（服务运营方）签发，可以很简单：一个环境变量里的共享密钥，
  或者以后做成每个用户一个。**第一版用一个全局共享密钥即可**
- 校验失败直接 401 拒绝，不建立连接

### 5.3 路径与配额限制
- 请求体大小上限：**20MB**（够上传图片，挡住恶意大包）
- 单个 `pairCode` 的并发连接数上限：电脑 1 条，手机 4 条
- 未登记的 `pairCode` 一律 404，不做任何提示（防枚举）
- 每个 IP 每秒请求数上限：50（防刷）

### 5.4 不落业务数据
- **不要**把转发的请求体/响应体写进日志
- **不要**落盘任何业务内容
- 日志只记：连接建立/断开、pairCode（可打码）、状态码、字节数、耗时
- 这是商业软件，用户是开发者，代码是敏感数据 —— 这条要在隐私政策里写清楚

### 5.5 后续（第二阶段，现在不用做）
端到端加密会在**客户端之间**做（X25519 + AES-GCM），服务端看到的只是密文。
现在服务端不需要实现任何加密逻辑，只要保证不记录内容即可。

---

## 6. 技术实现建议

### 6.1 语言与依赖

**用 Node.js 20+，和桥插件同栈**，方便以后复用类型和测试。

```json
{
  "name": "dsh-relay",
  "type": "module",
  "dependencies": {
    "ws": "^8.18.0"
  }
}
```

就这一个依赖。不要引入 Express/Koa —— 需要精细控制字节转发，原生 `http` 模块更好。

### 6.2 核心数据结构

```
rooms: Map<pairCode, {
  bridge: WebSocket | null,        // 电脑那条上行
  bridgeSince: number,             // 登记时间
  lastSeen: number,                // 最后收到帧的时间（心跳用）
  pending: Map<requestId, {         // 等待电脑响应的 HTTP 请求
    res: ServerResponse,
    timer: NodeJS.Timeout,
  }>,
}>
```

### 6.3 HTTP 转发的具体做法

不要用「把 HTTP 请求塞进 WS」的复杂方案。用**一条 WS 上跑多路复用**：

手机 HTTP 请求进来时：

1. 生成 `requestId`（自增整数或 UUID）
2. 向电脑的 WS 发一帧：
   ```json
   {
     "type": "req", "requestId": "r1", "method": "GET",
     "path": "/api/sessions", "headers": { ... }, "bodyLength": 0
   }
   ```
   如果请求有 body，紧跟一帧二进制（`Buffer`），电脑按 `bodyLength` 读满
3. 电脑处理后回：
   ```json
   { "type": "res", "requestId": "r1", "status": 200, "headers": {...}, "bodyLength": 1234 }
   ```
   紧跟一帧二进制 body（可分多帧，末帧带 `end: true`）
4. 服务端把这些原样写回手机的 `ServerResponse`

**为什么这样做：** 手机看到的就是一个普通 HTTP 响应，无需改 App；电脑侧复用桥现有的 HTTP 处理逻辑，只是把「监听 socket」换成「从 WS 读请求」。

### 6.4 WebSocket 转发的具体做法

```
手机 WSS ──▶ relay ──▶ 电脑 WSS
```

- 手机连 `/p/<code>/ws?token=xxx`
- relay 向电脑发一帧：`{"type":"ws-open", "connId":"w1", "path":"/ws", "query":"token=xxx"}`
- 电脑用同参数建一条到本机桥的 WS
- 此后两边字节双向转发，每帧带 `connId` 区分多条手机连接
- 任一端关闭，另一端也关

**注意**：手机 WS 的路径前缀 `/p/<code>` 要剥掉，电脑侧收到的是原始 `/ws?token=xxx`，
这样桥的鉴权逻辑完全不用改。

---

## 7. 部署步骤（照做）

### 7.1 装 Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # 应 >= 20
```

### 7.2 放代码

```bash
sudo mkdir -p /opt/dsh-relay
sudo chown $USER:$USER /opt/dsh-relay
cd /opt/dsh-relay
# 把 relay 服务代码放这里（package.json + server.js）
npm install --omit=dev
```

### 7.3 配置环境变量

```bash
sudo tee /etc/dsh-relay.env >/dev/null <<'EOF'
RELAY_PORT=8080
RELAY_TOKEN=换成一段随机长字符串
RELAY_MAX_BODY_BYTES=20971520
EOF
sudo chmod 600 /etc/dsh-relay.env
```

`RELAY_TOKEN` 生成方法：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 7.4 systemd 托管

```ini
# /etc/systemd/system/dsh-relay.service
[Unit]
Description=DSH relay
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/dsh-relay
EnvironmentFile=/etc/dsh-relay.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-relay
sudo systemctl status dsh-relay
```

### 7.5 Nginx 反代 + 证书

```nginx
# /etc/nginx/sites-available/dsh-relay
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    # 上传附件可达 20MB
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # WS 长连接不能超时
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}

server {
    listen 80;
    server_name relay.example.com;
    return 301 https://$host$request_uri;
}
```

证书：

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d relay.example.com
```

### 7.6 验收命令

```bash
curl https://relay.example.com/api/health
# 期望：{"status":"ok","service":"dsh-relay"}
```

---

## 8. 服务端需要实现的完整清单

按顺序做，每项都能单独验证：

1. **HTTP 服务**：监听 `RELAY_PORT`，实现 `GET /api/health` → `{"status":"ok"}`
2. **`/bridge` WS 端点**：校验 `Authorization: Bearer $RELAY_TOKEN`，收 `register` 帧，
   把 `pairCode` 登记进 `rooms`，回 `registered`
3. **离线处理**：`/bridge` 断开时把 `rooms` 里对应项标记离线（保留 5 分钟以便重连）
4. **`/p/<code>/...` HTTP 转发**：剥前缀 → 找 room → 多路复用转发 → 原样回写响应
5. **`/p/<code>/ws` WebSocket 转发**：剥前缀 → 建双通道 → 字节双向对拷
6. **未登记 code** → 404；**已登记但电脑离线** → 502 `BRIDGE_OFFLINE`
7. **心跳**：40 秒无帧判定离线，清理 room
8. **限额**：body 20MB、每 code 手机 4 连接、每 IP 50 req/s
9. **日志**：只记连接事件与状态码，不记内容
10. **重连**：同一 `pairCode` 新连接顶掉旧连接

---

## 9. 容量与成本参考（用于选服务器规格）

流量特征：DSH 是**开发工具**，主要是文字对话，图片偶尔、视频极少。

| 项目 | 估算 |
|---|---|
| 一条对话消息 | 1-3 KB |
| 一次完整对话（20 轮） | 约 50 KB |
| 重度用户一天（8 小时） | 5-15 MB |
| 1000 个用户 / 月 | 约 300 GB |

**结论**：文字为主的话，1 核 1G 的服务器 + 5Mbps 带宽能撑几百个日活用户。
不需要 CDN，不需要集群。等用户量上来再考虑水平扩展。

---

## 10. 交付物

请交付：

1. `server.js`（或拆成几个文件）+ `package.json`
2. `README.md`：安装、配置、排障
3. `dsh-relay.service` systemd 单元文件
4. `nginx.conf` 示例
5. **一个本地自测脚本**：不依赖真实网络，用两个 WS 客户端模拟「电脑 + 手机」，
   验证注册、HTTP 转发、WS 转发、离线返回 502 —— 这个最关键，没有它无法保证质量

---

## 11. 与客户端对接时需要的产出

服务端做完后，请提供给桥插件开发者（我）这三样：

| 项 | 示例 |
|---|---|
| 中转服务地址 | `wss://relay.example.com` |
| 共享中转密钥 | `RELAY_TOKEN` 的值（**不要贴在公开文档里**） |
| 健康检查截图 | `curl https://relay.example.com/api/health` 的返回 |

拿到这三样，我就能把桥插件的 `relay` 通道接上去 —— 那边已经预留了占位
（`bridge/transport.js:446`），补上真实的 WS 客户端即可。

---

## 12. 常见坑（提前说，免得踩）

| 坑 | 说明 |
|---|---|
| Nginx 默认 60 秒断 WS | 必须配 `proxy_read_timeout 3600s`，否则长连接每分钟断一次 |
| `client_max_body_size` 默认 1MB | 上传图片会 413，必须调到 20m |
| 用 `ws` 库时忘了 `noServer` | 要自己处理 `upgrade` 事件，否则 `/bridge` 和 `/p/.../ws` 会打架 |
| 响应体被当字符串处理 | 图片/视频会损坏，必须全程 `Buffer` / `Uint8Array` |
| 转发时改了 Host 头 | 桥的「仅本机接口」判定依赖 Host，改动会误伤或误放行 |
| HTTP/2 下 WS 不工作 | Nginx 的 `http2` 对 WS 有兼容问题，WS 走 HTTP/1.1 更稳（`proxy_http_version 1.1`） |
| 忘记 `proxy_buffering off` | 流式输出会被缓冲，手机端看起来「卡住不动」 |

**最后一条特别重要**：DSH 的助手回复是**流式**的，
`assistant.stream` 帧要实时到手机。中间任何一层缓冲都会让用户觉得「打字机效果卡死」。
