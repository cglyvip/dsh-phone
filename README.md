# dsh-phone-bridge v3

DeepSeek Harness 的手机端桥接插件。跑在 DSH 桌面客户端进程内，把 DSH 的会话能力
暴露成手机 App 可用的 **HTTP 控制面 + WebSocket 数据面**。

- 局域网直连（手机与电脑同一 Wi-Fi），可选 Cloudflare 快速隧道走公网
- 会话全量管理：列表 / 详情 / 新建 / 改名 / 归档 / 置顶 / 搜索
- 历史消息按 turn 分页拉取
- 实时推送：用户消息、助手消息、思考过程（reasoning）、工具调用与结果、turn 边界
- 模型目录与默认模型读写
- 令牌鉴权（Bearer / `?token=`）+ 一次性配对码

> **核心红线**：发消息只走 `sessionController.prompt()`，进入 DSH 的 Agent 循环。
> 插件从不直连模型 API，也不会绕过 harness 的工具/审批机制。

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
pair.js                  局域网地址探测 + 配对页（二维码 + 6 位配对码）
cloudflare.js            Cloudflare 快速隧道
directories.js           只读目录浏览（旧能力，保留）
qr.cjs                   二维码生成（纯本地）
shared/version.js        版本常量
```

协议契约见 `E:\HuaWei_xiangmu\DSH\shared\contract\contract.md` 与 `types.ts`。

---

## 安装（本机）

1. 把整个 `dsh-phone-bridge` 目录复制到
   `C:\Users\CGLY\.dsh\profiles\desktop\node_modules\dsh-phone-bridge\`
2. 确认 profile 的 `package.json` 里：
   - `dependencies` 含 `"dsh-phone-bridge": "3.0.0"`
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
| `cloudflareTunnel` | `off` | `off` / `pair` / `startup` |
| `cloudflaredPath` | `cloudflared` | cloudflared 可执行文件 |
| `logLevel` | `info` | `info` / `silent` |

令牌文件：`$DSH_HOME/phone-bridge/tokens.json`（默认 `C:\Users\CGLY\.dsh\phone-bridge\tokens.json`）。

---

## 配对

1. 插件启动后，在电脑浏览器打开 `http://127.0.0.1:9000/pair`
   （仅本机可访问），页面上有二维码与 6 位配对码。
2. 或在 DSH 对话里执行 `/pair`，会直接输出地址与配对码。
3. 手机 App 扫码，或手填 `ws://<局域网IP>:9000` + 配对码。

---

## 开发与自测

```powershell
cd E:\HuaWei_xiangmu\DSH\DSH-CHAJIAN\dsh-phone-bridge
node smoke-test.mjs
```

`smoke-test.mjs` 用一个假 cordis ctx 把插件跑起来，端到端验证 23 项
（REST 全部路由 + 鉴权 + 配对码一次性 + 按 turn 分页 + WS 握手/推送/过滤/增量/补拉）。

---

## 版本

- v2.0.0：原型，只有聊天，直连模型
- v3.0.0：重写，接入 `sessionController` 全量会话能力（见 `CHANGELOG.md`）
