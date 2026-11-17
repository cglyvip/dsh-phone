# CHANGELOG

## 3.7.1（2026-11-17）

### 修复（frp 一直连不上电脑）

现象：配对页 frp 通道长时间停在「正在启动」，最后报错也看不出原因；
手动跑 frpc 却只看到 `login to server success` 之后紧跟一行
`[dsh-phone-bridge] start error: proxy [dsh-phone-bridge] already exists`。

排查结论：frps（`144.24.55.61:7000`）可达、token 正确、`remotePort` 未被占用，
唯一失败点是**代理名 `dsh-phone-bridge` 在 frps 上仍被登记**——上一轮 frpc 的连接
没正常注销，frps 要等心跳超时（实测约 100 秒）才释放。代码侧有两个缺陷把这件事
藏了起来：

- **解析盲区**（`bridge/frpc.js`）：`parseFrpcLine()` 只认 `start proxy fail`。
  frpc 0.6x 起代理注册失败改吐 `start error: ...`，这一行被当成无关日志丢弃，
  状态机收不到任何失败信号，界面永远停在「正在启动」。
  现在单独识别 `start error`，并只取冒号后的内容作为原因
  （时间戳和 run id 会把界面上的关键信息挤掉）。
- **失败态没落地**（`bridge/transport.js`）：原 `proxy-fail` 分支只改 `error` 字段、
  `status` 仍是 `starting`；而 frpc 在代理注册失败时**进程不退出**（实测观察 25 秒仍在），
  不会触发崩溃重启。现在失败态直接落到 `error`。

### 新增（代理冲突自动重试）

代理名/端口冲突是可自愈的（frps 释放后重连即可），frpc 自己不会重试：

- 新增 `isConflictError()`，识别 `already exists` / `already used` / `proxy ... conflict`。
- 命中冲突时按 `30s / 60s / 90s / 120s` 线性退避自动重连，最多 4 次；
  退避期间界面显示原因与「N 秒后自动重试（n/4）」，不用手动反复点「保存并切换」。
- 重试次数用尽后报明确指引：通常是另一台电脑仍在跑同一份 frp 配置，
  先在那台电脑停掉通道，或把本机 `remotePort` 换成别的端口。
- 代理注册成功即清零冲突计数，避免一次长连接断开就顶到上限。
- 冲突重试与崩溃重启分开计数（`scheduleConflictRetry`），互不影响。
- `conflictRetryBaseMs` / `maxConflictRetries` 可注入，测试用毫秒级退避。

### 测试

- 冒烟测试增至 75 项，新增两组：代理名冲突时界面给出原因与自动重试（不卡在「正在启动」）、
  冲突自动重试用尽后提示「另一台电脑占用」。

### 修复（新电脑安装脚本在中文 Windows 上跑不通）

在中文 Windows（PowerShell 5.1，系统 ANSI 为 gb2312）上执行
`.\tools\install-local.ps1` 会连续失败两次，都不是用户操作问题：

- **JSON 读取乱码**：`Get-Content -Raw` 默认按系统 ANSI 解码，而仓库里的
  `package.json` 是无 BOM 的 UTF-8，中文描述变成乱码后 `ConvertFrom-Json`
  报「无效的 JSON 基元」。新增 `Read-JsonFile`，改用
  `[System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)` 显式按 UTF-8 读，
  5 处文件读取中 4 处替换（`npm pack` 的输出字符串仍按原样处理）。
- **tar 误判路径为远程主机**：PATH 里若有 Git 自带的 GNU tar，它会把
  `C:\Users\...` 当成 `主机:路径` 解析，报
  `Cannot connect to C: resolve failed`。改为优先使用系统自带的 bsdtar
  （`%SystemRoot%\System32\tar.exe`），找不到才回退 PATH 中的 `tar.exe`。

两处修完，本机 3.5.1 → 3.7.1 安装成功（旧插件与 profile 均有备份）。

## 3.7.0（2026-11-17）

### 修复（电脑端发的视频手机收不到）

现象：远程电脑在会话里交付的视频（例如 `D:\work\deliver\demo.mp4`），
手机端既没有视频块，点开也是 404。经排查是四处叠加导致，逐层修复：

- **投影层只认 JSON**（`adapter/project.js`）：`extractMediaBlocks()` 原本只解析
  工具输出的 `{"videos":[...]}` 结构。实际交付走的是 `present` 工具的
  `Presented D:\...\demo.mp4` 行和 markdown 表格里的
  `[demo](<deliver/demo.mp4>)`，两种都提取不到。现在三种形状全认，
  相对路径按会话 `cwd` 展开成绝对路径，非媒体扩展名不转块，按 `类型|id` 去重。
- **正文残留本机路径**（`stripLocalMediaPaths()`）：原来只清 `![alt](路径)`，
  `[文字](路径)` 原样留在气泡里。现在图片语法整段删除、链接降级为纯文字、
  `Presented <路径>` 行降级为文件名，并折叠多余空行。
- **取字节被硬限制在生图目录**（`adapter/dsh.js`）：`mediaFilePath()` 原来只接受
  `$DSH_HOME/dsh-imagegen/videos/files` 下的纯文件名，任意工作区路径必然 404。
  新增 ID 形态 `media:v1.<base64url(绝对路径)>`；服务端解码后要求路径绝对、
  扩展名属于图片/视频白名单、`realpath` 后仍落在白名单根内
  （`$DSH_HOME/dsh-imagegen` + 全部会话 cwd 含归档 + 全部工作区路径），
  否则一律 404，不区分「不存在」与「越权」。非媒体扩展名 400，相对路径 400。
  白名单缓存 60 秒。
- **媒体块挂在 tool 消息上**（手机端不渲染）：`promoteToAssistant()` 把工具结果里的
  媒体块复制到同一 turn 的助手消息，鸿蒙端无需改动即可显示。

### 兼容

- `media:` 前缀沿用旧约定，鸿蒙 `mediaSrcOf()` 剥前缀后的 `v1.<base64url>` 形态桥端同样接受，
  老版本 App 不用升级。
- `cwd` 现在随 `session/event`、`GET /api/sessions/:id`、历史分页一路透传，
  相对路径才有展开依据。
- 契约版本仍为 `3`，`CONTRACT_VERSION` / `MIN_CONTRACT_VERSION` 未变。

### 测试

- 冒烟测试增至 73 项，新增两组：
  - `/api/media` v1：工作区视频 200 + 字节一致、剥前缀形态、Range 206、
    白名单外 404、路径穿越 404、非媒体 400、相对路径 400、不存在 404。
  - 非 JSON 交付投影：`Presented` 行与 markdown 相对路径都抽出 `video` 块、
    助手消息同样带块、无 cwd 时不臆造、`http(s)` 外链不转块。

## 3.6.0（2026-11-17）

- 新增 14 项穿透服务接入目录，区分标准 frps、桥托管通道和服务商官方客户端，提供官方文档、免费条件及基于实际端口的步骤。
- 服务商公网地址支持 `tcp://主机:端口`，验证手机桥身份、协议和公网配对码隔离；拒绝广告、确认页、重定向和无效地址。
- 固定域名和外部客户端地址验证失败时保留当前连接，不写入错误配置。
- 修复电脑本机配对页切换公网通道时返回 `401 AUTH_REQUIRED`：使用每次启动生成的专用控制凭据，只允许配置本机通道，不能访问会话或绕过公网来源限制。
- 修复默认局域网配置下，保存的公网通道重启后不启动，以及切换 frp 时本机端口为 0 的问题。
- 新增新电脑安装脚本 `tools/install-local.ps1`，识别当前用户与 `DSH_HOME`，保留其他插件并备份 profile 配置。
- Cloudflare 快速隧道必须完成连接注册才标记就绪，启动失败会保留 DNS 诊断；支持显式配置连接协议与子进程 DNS 解析器。
- 补充新电脑使用 frp / Cloudflare、旧电脑端口占用和重新配对的说明。
- 冒烟测试增至 71 项，另有 25 项客户端接入、页面交互、桥启动与 Cloudflare 就绪回归测试。

## 3.5.1（2026-11-17）

### 修复（换电脑后无法填 frp 参数）

- **配对页 frp 卡片补表单**：原来只有「服务商预设」文字说明，没有任何输入框，
  导致新机器上只能手改 `cordis.patch.yml`。现在与 custom / ngrok 卡片一致：
  - `serverAddr`（VPS 地址或域名）
  - `serverPort`（frps bindPort，默认 7000）
  - `remotePort`（公网映射端口，0 = 由 frps 随机分配）
  - `token`（frps auth.token，密码框，页面不回显）
  - `useTls` 勾选框（frps 开了 `transport.tls` 才勾）
  - 「保存并切换」按钮带 `data-frp="1"`，前端收集后 POST `/api/transport/mode`
- **表单回显但不泄密**：`serverAddr/serverPort/remotePort/useTls` 从
  `TransportManager.frpFormValues()` 回显；token 只回 `hasToken` 布尔，
  页面显示「token 已保存，留空则不修改」，密钥永不出现在 HTML 里
- **留空即保留密钥**：`switchMode` 新增 `mergeSecretFields`，表单里 token /
  authtoken 留空时沿用已保存值（此前会把 token 清空导致 frp 通道拒绝启动）
- **重启不再丢参数**：`index.js` 启动时从 `transport.json` 读回的字段从
  只有 `tunnelMode` 扩展为 `tunnelMode + publicUrl + frp + ngrok`
  （与插件 config 浅合并，transport.json 优先）。此前在配对页填完 frp 参数
  并切换，重启 DSH 后会回落到 `cordis.patch.yml` 的旧值
- **随包默认配置补 frp / ngrok 段**：`cordis.patch.yml` 新增 `tunnelMode`、
  `frp`（5 个字段）、`ngrok`（2 个字段）的注释模板，新机器装上插件即可看到
  可填位置；不写 `tunnelMode` 时仍按旧 `cloudflareTunnel` 推断

### 测试

- 冒烟测试新增断言：frp 表单四个输入框 + `data-frp` 按钮存在、
  参数回显不含 token、「留空 token 保留原值」端到端校验
- 前端脚本实测：填 `10.0.0.9 / 7002 / 28000 / newtok / TLS` →
  请求体 `{"tunnelMode":"frp","frp":{"serverAddr":"10.0.0.9",...}}`；
  token 留空 → 请求体不带 `token` 字段

### 说明

- `CONTRACT_VERSION` 仍为 3（纯 UI 与配置持久化修复，无协议变更）
- 升级后需完全退出 DSH（托盘右键退出）再启动，插件才会重新加载

## 3.5.0（2026-11-15）

### 新增（contract §3.1：会话列表「最后一条消息预览」）

- **GET /api/sessions 的 items 每项新增两个字段**：
  - `preview`：最后一条 user/assistant 消息的单行摘要（连续空白折叠、
    按 Unicode 码点截 60 字、超长补 `…`；无消息为空串）
  - `lastRole`：该消息角色 `'user' | 'assistant'`（无消息为 `''`）
- **占位符规则**（preview 由内容块生成）：image/video/file/toolCall 块 →
  `[图片]` / `[视频]` / `[文件]` / `[工具调用]`；reasoning 块不进预览；
  tool/system/developer 消息不算（lastRole 契约只有两值）
- **原生能力核实结论**（app.asar，DSH 0.2.2-rc.1）：DSH 不带该数据——
  - `sessionController.list()`（dsh-api-session-controller/lib/index.js
    `summaryFor()`，:2824 附近）只回 sessionId/updatedAt/agentAvailable/
    formatStatus/running/blank/listFields/projections；
    `sessionProjections` 仅有 sessionListMetadata（blank/lastPromptAt）、
    imageLimits（summary:false）、conversationContinuation（续跑资格）三个键
  - `sessionQuery.listSessions()`（dsh-session-query/lib/index.js:95）只回
    header + live/persisted/formatStatus；`readTitleSnapshots` 只折 title
  - `dsh-session-query-sqlite`（lib/index.ts:268-296）只暴露 searchSessions/
    searchEvents（FTS5 检索 + snippet），没有 lastMessage/preview 列
- **实现（桥内存缓存）**：
  - `adapter/project.js` 新增 `toPreviewText` / `previewOfBlocks` /
    `lastChatMessage` 纯函数（smoke 直接单测）
  - `adapter/dsh.js` 维护 `Map<sessionId,{text,role,seq}>`：
    `message.created` / `message.done` 事件实时更新（index.js 把
    EventHub 订阅喂给 `adapter.observePreviewEvent`，dshSeq 单调保护
    防乱序回退）；启动 `warmPreviewCache()` 对列表前 20 个会话用
    `getHistoryPage({turns:1})` 批量补齐；列表请求时对缓存缺失的前 20 个
    后台补齐（单飞队列 + 去重，不阻塞响应）；缓存上限 1000 条 FIFO
- 兼容性：纯增量字段，`CONTRACT_VERSION` 仍为 3；桥刚启动的短暂窗口内
  preview 可能为空串（契约 §3.1 已注记，App 需容忍）

### 说明

- 冒烟测试新增 3 项：preview 生成（启动补齐 + 60 字截断 + 空会话空串）、
  事件实时更新（message.created 后列表立即反映）、previewOfBlocks 占位符
- 包版本与 `BRIDGE_VERSION` 升至 **3.5.0**；`CONTRACT_VERSION` 仍为 3


## 3.4.0（2026-11-15）

### 新增（contract §9.6：审批策略可写）

- **PUT /api/sessions/:id/permission 支持审批策略**：载荷新增 `approval`
  （`every-step` ↔ DSH `ask`；`auto` ↔ `never`），与 `mode` 任意组合：
  只传 approval 不动 mode；只传 mode 不动 approval；两者都传先 mode 后
  approval（折叠语义取最后一条，显式 approval 覆盖预设自带的审批默认）
- **写路径核实**（app.asar 源码）：`setApprovalPolicy(session, policy)`
  （dsh-user-approval/src/index.ts:117-122）校验 `ask|never` 后
  `session.append('approval/policy', { policy })`——"the sole durable
  representation of a session policy override"；事件载荷 schema
  （index.ts:41-44，缺 source = 运行时切换）、已知事件词表
  （dsh-session/src/known-event-types.ts:27）、折叠 last-write-wins
  （index.ts:99）。桥作为进程内插件通过活 Session 实例追加同一事件
  （与 §9.5 sandbox/mode 直写同一手法）
- GET /permission 的 approval 同步反映当前值（写完 GET 回读一致，
  smoke 固化「只写 approval 不动 mode + 回读一致」）
- 空 PUT（mode/approval 都缺）→ 400；非法值 → 400 INVALID_PARAM

### 说明

- 冒烟测试 63 → **67 项**（approval 单独写+回读、组合 patch、预设冲突覆盖、
  无效值/空 body/会话不存在拒绝）
- 包版本与 `BRIDGE_VERSION` 升至 **3.4.0**；`CONTRACT_VERSION` 仍为 3


## 3.3.0（2026-11-15）

### 新增（contract §10.1：通道扩展，覆盖市面全部内网穿透）

- **custom 模式**：花生壳 / natapp / cpolar / zrok 等专有工具拿到的地址直接粘贴——
  桥只存 publicUrl 并校验格式（必须 http/https）+ 探活，不托管任何进程；
  缺地址/格式非法 → 卡片报错降级局域网
- **ngrok 托管**（新增 `bridge/ngrok.js`）：
  - ngrok.exe 自动引导：官方源 dl.ngrok.com（v3 stable，`DSH_NGROK_URL` 可覆盖），
    size 强制校验 + sha256 尽力校验（`.sha256` 旁车或 `DSH_NGROK_SHA256`；
    ngrok stable 无官方 checksums 清单，与 frp 的锁定版本策略不同），
    校验不过绝不落盘；用户手放 `~/.dsh/phone-bridge/ngrok/ngrok.exe` 永远优先
  - 官方 CLI 序列：`ngrok config add-authtoken <token>`（token 只落
    transport.json（600），不进日志/状态/health）→
    `ngrok http <桥端口> --domain=<静态域名> --log=stdout --log-format=json`，
    解析 started tunnel JSON 行回填 publicUrl；崩溃指数退避重启最多 5 次
- **探活接口**：`POST /api/transport/probe`（仅本机）`{url}` → 对
  `<url>/api/health` GET 3s 超时 → `{ok,status,latencyMs,error?}`；
  custom 粘贴地址后即时验证
- **transport/mode 载荷扩展**：`{tunnelMode, publicUrl?, frp?, ngrok?}`——切换时
  一并写入通道参数并持久化到 transport.json；frp token / ngrok authtoken 只落盘
  不回显；部分参数更新不覆盖未提供字段
- **配对页升级**：通道卡片左侧色条 + 内联 SVG 图标 + 当前通道高亮描边 +
  错误红字；frp 卡片「服务商预设」折叠区（自建 frps / OpenFrp / 樱花Frp(natfrp) /
  Sunny-Ngrok 四模板：字段说明 + 官方入口 URL + 注意事项，纯展示层）；
  custom 卡片地址输入框 + 探活按钮 + 结果徽标；ngrok 卡片 authtoken/静态域名表单
- **安全不变**：ngrok 透传保留原 Host（静态域名，非回环），与 frp 同策略——
  配对码/配对页/通道切换对一切非本机直连 403 ROUTE_LOCAL_ONLY，业务接口 Bearer 放行

### 说明

- `TUNNEL_MODES` 扩展为 7 种：quick/named/frp/custom/ngrok/relay/off；
  `isTunnelRequest` 语义复核：仅匹配 cloudflared Host 标记，ngrok/custom/frp 来源
  由「Host 回环」判定天然拒绝本机路由
- 冒烟测试 56 → **63 项**（custom 模式三种状态、探活接口 5 断言、ngrok 托管
  CLI 序列/崩溃重启/authtoken 不落日志、下载双校验与 zip 抽取、预设模板数据
  完整性、HTTP 参数持久化与不回显等；ngrok 用 mock 进程）
- 包版本与 `BRIDGE_VERSION` 升至 **3.3.0**；`CONTRACT_VERSION` 仍为 3


## 3.2.0（2026-11-14）

### 新增（contract §10：公网接入多通道，用户自选）

- **通道统一状态机**（`bridge/transport.js`）：`tunnelMode = quick | named | frp | relay | off`，
  `switchMode` 停旧起新；任一通道失败自动降级局域网（LAN 永远可用）。
  状态（`tunnelMode` / `tunnelStatus` / `tunnelUrl` / `tunnelError` / 四通道 `channels`）
  全部进 `/api/health`、`GET /api/transport`；`POST /api/transport/mode`（仅本机）
  一键切换并把选择持久化到 `$DSH_HOME/phone-bridge/transport.json`（重启仍生效）。
  旧 `cloudflareTunnel: startup` 配置自动映射为 `tunnelMode: quick`（向后兼容）
- **frp 通道**（自有 VPS，国内延迟最低）：
  - frpc 自动引导（`bridge/frpc.js`）：写死官方 GitHub releases（fatedier/frp，
    锁定 v0.61.1，`DSH_FRP_VERSION` 可覆盖），下载后 **size + sha256 双校验**
    （元数据取 GitHub release assets，缺 digest 时退官方 checksums 文件），再从
    zip 抽出 frpc.exe（解压后 CRC32 复核）——校验不过绝不落盘；
    用户手放在 `~/.dsh/phone-bridge/frpc/frpc.exe` 的二进制永远优先、不覆盖
  - `frpc.toml` 自动生成（官方键：serverAddr/serverPort/auth.method=token/
    auth.token/transport.tls.enabled/[[proxies]] tcp→127.0.0.1:桥端口），
    token 只写配置文件（权限 600），**永不进日志/状态/健康检查**；
    `remotePort=0` 时从 frpc 输出的 frps 分配结果（remoteAddr=...）回填
    `publicUrl = vps:port`
  - frpc 进程生命周期：随桥 dispose 回收；崩溃自动重启（指数退避 1s/2s/4s/8s/16s，
    最多 5 次，超过报错降级局域网）
  - 安全：frp tcp 透传时 Host 是 `vps:remotePort`（非回环），仅本机路由判定从
    「socket 回环」加严为「socket 回环 + Host 回环」——frp/各隧道来源的业务接口
    照常放行，pairing-code 与 /pair 页对一切非本机直连 403（与 quick 隧道同一策略）
- **配对页通道选择**（仅本机）：4 个通道卡片（quick/named/frp/relay）显示当前态、
  一键切换、每通道错误原因与地址，含选型建议（frp 延迟最低 / named 免维护 /
  quick 免费试用）
- **relay**：本期仅配置占位（`relay.endpoint`）+ 通道状态展示，订阅连接逻辑下一阶段

### 说明

- `named` 通道不做自动建隧道（CF 后台一次性配置是用户自己的事），只透传 `publicUrl`
- 冒烟测试 48 → **56 项**（frp 配置生成/双校验拒绝篡改/崩溃重启策略/通道状态机切换/
  用户手放优先/HTTP 通道路由等；frpc 用 mock 进程，不需要真 frps）
- 包版本与 `BRIDGE_VERSION` 升至 **3.2.0**；`CONTRACT_VERSION` 仍为 3

## 3.1.0（2026-11-14）

### 新增

- **上传附件**：`POST /api/uploads`（contract §9.1）——原始字节流（Content-Length 已知），
  `X-File-Name`（URL 编码）+ `X-Media-Type` 头；边收边落临时文件并计算 sha256，
  单文件上限 **200 MB**（超限 `413 INVALID_PARAM`，Content-Length 预检 + 流式计数双保险）。
  对象按内容寻址写入 DSH 附件存储：`image/*` → `attachments/v1/objects/<hex前2>/<hex>`、
  其余 → `attachments/v1/file-objects/<hex前2>/<hex>`（与 DSH 自带发布器一致，同字节重传幂等复用）；
  PNG/JPEG 魔数解析宽高（GIF/WebP 识别类型、宽高 0），`kind` = image | video | file
- **带附件发消息**：REST `POST /api/sessions/:id/messages` 与 WS `send` 载荷新增 `attachments`
  （≤9 个，contract §9.2）——`image/*` → `{type:'image', attachment:{attachmentId, mediaType,
  bytes, width, height, name}}`（mediaType/bytes/宽高以落盘对象实测为准，保证 DSH
  readImageFile 逐字段校验通过）；`video/*` 与其他文件 → 先经 DSH 官方
  `fileUploads.uploadStream` 暂存收据再以 `{type:'file', receiptId}` 进 prompt
  （DSH 的 resolvePromptFileReceipts 只认收据，直接给 attachment 引用会被拒），
  会话日志里的 file 块仍是 `{type:'file', attachment:{...}}`；附件块全部拼在 text 之前，
  空文本 + 附件的纯附件消息允许；未上传过的 attachmentId → `404 INVALID_PARAM`
- **归档会话删除**：`DELETE /api/sessions/:id?purge=true` 与
  `POST /api/sessions/batch-delete`（≤200 个，部分成功返回 200，purged / archivedFallback /
  failed 三数组齐全，contract §9.3）。
  **DSH 删除能力核实结论**（app.asar 源码）：`SessionPersistence` 只有
  create/open/flush/stat/list（append-only 语义写死）、`SessionStore` 的 disposal 仅由
  创建方 fiber 内部 detach 触发、`workspaceController` 只有归档/置顶（其 delete 是删工作区）、
  全源码无 purge 入口 —— **DSH 0.2.x 无对外会话硬删能力**，因此 purge 一律降级为
  「归档 + 尽力清标题」，结果放 `archivedFallback` 如实上报，绝不假装删成功；
  v3.0 的 DELETE（不带 purge）语义不变（仍 = 归档）

### 新增（v3.1 追加）

- **会话权限模式**（contract §9.5）：`GET /api/sessions/:id/permission` 与
  `PUT /api/sessions/:id/permission`，3 档 `read-only` / `workspace-write` / `full-access`
  + `approval`（'ask'→every-step / 'never'→auto，只读返回）。
  **DSH 运行时写入口已核实**：`permissionPresets.set(session, preset)`
  （dsh-permission-presets/src/index.ts:395-411，ds-bot 即如此使用，见
  ds-bot/src/host/permissions.js:28）；默认预设表只有 workspace-write 与
  danger-full-access（index.ts:183-190），因此 full-access → 预设
  danger-full-access，read-only（默认表没有）→ 直写官方
  `sandbox/mode` 事件（`session.append('sandbox/mode', {mode})`，
  dsh-sandbox-policy/src/session-mode.ts:53-54 "THE write path ... the switch
  IS its event"，SANDBOX_MODES 含 read-only）。PUT 成功后广播 `session.updated`
- **隧道安全修复**：Quick Tunnel 启动加 `--http-host-header dsh-phone-bridge-tunnel`
  （cloudflare.js），桥据此识别隧道来源 —— `/api/pairing-code` 与 `/pair` 页对
  隧道流量一律 `403 ROUTE_LOCAL_ONLY`（新错误码）。此前隧道流量从 127.0.0.1 连入，
  socket 层面与本机无法区分，**外网可凭隧道地址自助拿配对码**（实测复现的漏洞）。
  `/api/pair` 保留隧道可达（外地合法配对路径），但加防爆破：同源连续错
  **20 次**锁 **15 分钟**（`429 RATE_LIMITED` + retryAfter）

### 修复

- **资源不存在误报 501**：`GET /api/media/:name`、`GET /api/attachments/:id`、
  `GET /api/files/:id` 在对象缺失时返回 `NOT_SUPPORTED(501)`，语义应为 404。
  新增错误码 `MEDIA_NOT_FOUND(404)` 与 `ATTACHMENT_NOT_FOUND(404)`
  （contract §5 错误表同步）；发消息时引用未上传附件保持契约规定的 `404 INVALID_PARAM`
- `GET /api/attachments/:id` / `/api/media/:name` / `/api/files/:id` 的
  `?token=` 查询参数鉴权经实测确认可用（手机 Image/Video 组件带不了 Authorization 头）

### 说明

- 冒烟测试 27 → **48 项**（上传幂等、PNG/JPEG 尺寸魔数、413、image/file 块结构、
  fileUploads 收据、未上传 404、>9 附件、纯附件消息、WS 附件、purge 降级、
  batch 部分成功、超 200 批量上限、隧道 403、pair 防爆破、权限模式读写等）
- 包版本与 `BRIDGE_VERSION` 升至 `3.1.0`；`CONTRACT_VERSION` 仍为 3（纯增量）

## 3.0.1（2026-11-14）

### 新增

- **媒体投影**：`generate_image` / `generate_video` 工具结果里的
  `images[].attachment_id` → `image` 块、`videos[].url` → `video` 块（`media:<文件名>` 引用），
  手机端无需电脑路径即可加载素材
- **视频字节路由**：`GET /api/media/:name`（`send` 流式，支持 Range/206，可直接拖动播放），
  服务 `$DSH_HOME/dsh-imagegen/videos/files`
- **通用文件下载**：`GET /api/files/:attachmentId`，服务 `attachments/v1/file-objects` 内容寻址对象
- **冒烟测试** 23 → 27 项（媒体二进制、Range 206、路径穿越拒绝、投影断言）

### 变更

- 助手 / 工具正文里的**本机绝对路径图片链接**被剥离（`![...](C:\...)`），不再把电脑路径透传到手机
- 生成类工具结果的正文从整段 JSON 换成其 `message` 字段（友好文案），错误时附 `error` 行
- 冒烟测试隔离 `$DSH_HOME`，不再污染真实 `~/.dsh/phone-bridge/model.json`
## 3.0.0（2026-11-13）

这是一次**重写**，v2 的「聊天原型」被完全替换为商业级桥接层。

### 新增

- **三层架构**：`bridge/`（BridgeService）· `adapter/`（DSH Adapter）· `bridge/eventhub.js`（EventHub）
- **会话全量管理**：列表（含标题）、详情、新建、改名、归档、置顶、搜索
- **历史分页**：按 turn 分页（`turns` + `beforeTurn`），修正了「用户提问排在 turn/start 之前」导致的漏条
- **实时推送**：订阅 Host Event `session/event` 与 `agent/assistant-stream`，
  下推 `message.created` / `message.done` / `message.part` / `turn.*` / `assistant.stream`
- **流式增量**：`StreamChunk` 七种载荷（text-delta / reasoning-delta / tool-call-delta …）原样转发
- **模型**：`modelCatalog()` 动态目录 + 默认模型读写（`agentDefaultModel`）
- **REST 控制面**：`/api/health` `/api/pair` `/api/sessions*` `/api/models` `/api/settings/model` `/api/sync` `/api/search` `/api/workspaces`
- **WS 数据面**：`/ws?token=`，`hello` / `send` / `stop` / `subscribe` / `sync` 补拉
- **鉴权**：令牌（Bearer / `?token=`）+ 一次性 6 位配对码；令牌落盘 `$DSH_HOME/phone-bridge/tokens.json`
- **配对页**：`/pair`（仅本机），二维码 + 大字配对码，主色 `#4D6BFE`
- **错误模型**：统一 `{ error: { code, message, retryAfter?, detail? } }`，14 个错误码
- **契约文件**：`shared/contract/contract.md` + `types.ts`
- **自带冒烟测试**：`node smoke-test.mjs`，23 项断言，无需 DSH 运行时

### 变更

- `inject` 从 `['webServer','connection','llm']` 改为
  `['webServer','connection','sessionController','sessionQuery','sessionTitle','workspaceController','agentDefaultModel']`
- 包版本 `2.0.0` → `3.0.0`；`exports` / `files` 补全

### 移除

- **直连模型的聊天实现**（`ctx.llm.stream` + `askDefaultModel`）——违反「不绕过 harness」红线
- **硬编码的 5 条 magpie 回退路由**——改为完全读真实 `modelCatalog()`
- 内存态 `sessions: Map` 与 `HISTORY_LIMIT` ——改为 DSH 持久化会话

### 修复

- 旧 `pair.js` 中文注释乱码（GBK/UTF-8 混淆），整体重写为干净 UTF-8
- 旧版端口被占用时的重试逻辑未回写真实端口，现从 `server.address()` 取实际端口

## 3.0.1（2026-11-13）

### 修复

- **归档箱不生效**：GET /api/sessions?archived=1 与主列表返回完全相同的集合。
  根因：SessionSummary 上不带归档 / 置顶字段，旧实现只是把 rchived 原样回显。
  修法：DshAdapter.startWorkspaceWatch() 订阅 workspaceController.follow()，
  用 baseline 与 rchived / pinned / eplace 增量维护 rchivedIds / pinnedIds 集合；
  listSessions(archived) 据此过滤，并给每条记录补 rchived / pinned 两个字段；
  置顶会话排最前，其次运行中，再按 updatedAt 倒序。
- **DELETE 语义澄清**：DSH 没有「彻底删除会话」的接口，DELETE /api/sessions/:id
  等同归档（可从归档箱恢复），http.js 注释与文档已注明。

### 说明

- 归档 / 置顶集合是 workspaceController 的全局集合，因此**必须重启 DSH** 后本次改动才生效。
