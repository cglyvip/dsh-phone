/**
 * dsh-phone-bridge · DSH 会话事件 → 手机线格式投影
 *
 * 输入是 DSH 真实的 SessionEvent（见 sessionQuery.readSession().events，
 * 字段形状已用本机真实会话日志核对）：
 *   { type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }
 * 其中：
 *   - user/message:      data = { role:'user', content:[{type:'text',text}], source, id }
 *   - assistant/message: data = { turn, step, message:{role:'assistant',content:[...],source:{provider,model},id}, usage?, stream?, interrupted? }
 *   - tool/call:         data = { turn, step, callId, name, arguments }
 *   - tool/result:       data = { turn, step, message:{role:'tool',toolCallId,content:[...],isError?,id}, error? }
 *   - session/title:     data = { title, messageSeqs, source }
 *   - model/selection:   data = { provider, model, reasoningEffort? }
 *
 * 证据等级：[官方源码] —— 事件名与结构取自 cordis Inspect 的 SessionEventMap，
 * 并用 $DSH_HOME/sessions 下真实 session.v4.jsonl.zstd 逐条核对。
 */

import path from 'node:path';

/**
 * 本机绝对路径（Windows 盘符 / UNC），手机端无法加载。
 * 生成类工具会把落盘路径写进正文（`![生成图片](C:\...\x.png)`），
 * 直接透传会让手机只看到一串路径，所以这里统一剥掉。
 */
function isLocalAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(<?([^)\n]+?)>?\)/g;
/** 普通 markdown 链接 `[文字](<路径>)`：交付类工具常用它给出视频/图片（`!` 开头的图片语法除外）。 */
const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\(<?([^)\n]+?)>?\)/g;
/** 任意 markdown 链接/图片语法（抽取媒体时两者都要看）。 */
const MARKDOWN_ANY_LINK = /!?\[([^\]]*)\]\(<?([^)\n]+?)>?\)/g;

/** 媒体扩展名白名单（只有这些才当作可下发的媒体，避免把普通文档当视频）。 */
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic)$/i;

/** 媒体扩展名 → MIME（手机端 Video/Image 组件据此选解码器）。 */
const MEDIA_MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic',
};

/** 按扩展名判断媒体类型：'video' | 'image' | ''（不是媒体）。 */
export function mediaKindOf(value) {
  const text = String(value ?? '').split('?')[0].split('#')[0];
  if (VIDEO_EXT.test(text)) return 'video';
  if (IMAGE_EXT.test(text)) return 'image';
  return '';
}

/** 按扩展名猜 MIME，猜不到给空串（手机端会按块类型兜底）。 */
function mediaMimeOf(value) {
  const text = String(value ?? '').split('?')[0].split('#')[0];
  const dot = text.lastIndexOf('.');
  if (dot < 0) return '';
  return MEDIA_MIME[text.slice(dot + 1).toLowerCase()] ?? '';
}

/**
 * 去掉指向本机磁盘的图片 markdown（图片本身改由 image 块渲染），
 * 并把本机媒体链接降级为可读文字：
 *   `[demo](<deliver/demo.mp4>)` → `demo`
 * 媒体字节已由 media 块承载，正文里再留一串路径只会让手机用户困惑。
 * 只处理媒体扩展名且没有 http(s) 等 scheme 的目标，普通文档链接保持原样。
 */
function stripLocalMediaPaths(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text
    .replace(MARKDOWN_IMAGE, (whole, alt, target) => (isLocalAbsolutePath(target) ? '' : whole))
    .replace(MARKDOWN_LINK, (whole, label, target) => {
      const clean = String(target ?? '').trim();
      if (clean.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return whole;
      if (mediaKindOf(clean).length === 0) return whole;
      const name = String(label ?? '').trim();
      return name.length > 0 ? name : path.basename(clean);
    })
    // present 工具逐行输出 `Presented <绝对路径>`：媒体已由块承载，正文只留文件名
    .replace(/^\s*Presented\s+(.+?)\s*$/gim, (whole, target) => {
      const clean = String(target ?? '').replace(/^[`'"]|[`'"]$/g, '').trim();
      return mediaKindOf(clean).length > 0 ? path.basename(clean) : whole;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从 URL 取最后一段作为文件名。 */
function fileNameOfUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return '';
  const clean = url.split('?')[0].split('#')[0];
  const parts = clean.split('/');
  const last = parts.length > 0 ? parts[parts.length - 1] : '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * 把正文里的本机路径解析成绝对路径。
 * 相对路径按会话工作区（cwd）展开；拿不到 cwd 时返回空串（宁可不给，也不猜）。
 */
function resolveLocalPath(target, cwd) {
  const value = typeof target === 'string' ? target.trim() : '';
  if (value.length === 0) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return ''; // http(s):// 等外链，桥无法代理
  if (value.startsWith('#')) return '';
  if (isLocalAbsolutePath(value)) return path.normalize(value);
  const base = typeof cwd === 'string' ? cwd.trim() : '';
  if (base.length === 0) return '';
  return path.resolve(base, value);
}

/**
 * 把本地绝对路径编码成桥可服务的媒体 ID：`media:v1.<base64url>`。
 *
 * 为什么复用 `media:` 前缀：手机端（鸿蒙 1.0.x 及更早）已有
 * 「attachmentId 以 media: 开头 → 走 /api/media/<id>」的分流逻辑，
 * 沿用前缀可以让老客户端无需升级就能加载会话工作区里的任意媒体。
 * 纯文件名仍是老的 v0 形态（dsh-imagegen/videos/files 目录）。
 */
function encodeLocalMediaId(absolutePath) {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) return '';
  return `media:v1.${Buffer.from(absolutePath, 'utf8').toString('base64url')}`;
}

/**
 * 从生成类工具的结果文本里抽取媒体引用。
 *
 * 实测形状（dsh-imagegen-video 3.x，本机 2026-11-14）：
 *   generate_image → {"images":[{"attachment_id":"sha256:<hex>","media_type":"image/png",
 *                                "bytes":1710437,"width":1024,"height":1024,"name":"..."}],
 *                     "files":["C:\\Users\\...\\dsh-imagegen\\images\\<id>-0.png"]}
 *   generate_video → {"videos":[{"url":"/api/dsh-imagegen/video/file/<file>.mp4",
 *                                "mime":"video/mp4","duration":5}]}
 *
 * 另外两种「不是 JSON」的交付形状也必须认（2026-11-17 实测）：
 *   present 工具     → 逐行 `Presented D:\\work\\deliver\\demo.mp4`
 *   助手正文 markdown → `[demo](<deliver/demo.mp4>)`（尖括号包裹的相对路径）
 *
 * 图片走附件字节（/api/attachments/:id），视频走桥的媒体文件路由（/api/media/<id>），
 * 两者都变成手机可直接加载的块，不再依赖电脑上的路径。
 *
 * @param {string} text 工具结果 / 助手正文
 * @param {string} [cwd] 会话工作区，用于把相对路径展开成绝对路径
 */
function extractMediaBlocks(text, cwd = '') {
  const blocks = [];
  if (typeof text !== 'string' || text.length === 0) return blocks;

  const seen = new Set();
  const push = (block) => {
    if (block === null) return;
    const key = `${block.type}|${block.attachmentId}`;
    if (seen.has(key)) return;
    seen.add(key);
    blocks.push(block);
  };

  /** 把一条「可能是本机路径」的引用变成 image/video 块。 */
  const pushLocal = (target, label) => {
    const absolute = resolveLocalPath(target, cwd);
    if (absolute.length === 0) return;
    const kind = mediaKindOf(absolute);
    if (kind.length === 0) return;
    const id = encodeLocalMediaId(absolute);
    if (id.length === 0) return;
    const name = String(label ?? '').trim() || path.basename(absolute);
    push({
      type: kind,
      attachmentId: id,
      mediaType: mediaMimeOf(absolute),
      width: 0,
      height: 0,
      name,
    });
  };

  // ① JSON 形状（生图 / 生视频工具的原始输出）
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === 'object') {
    const images = Array.isArray(parsed.images) ? parsed.images : [];
    for (const image of images) {
      if (image === null || typeof image !== 'object') continue;
      const id = typeof image.attachment_id === 'string' ? image.attachment_id : '';
      if (id.length === 0) continue;
      push({
        type: 'image',
        attachmentId: id,
        mediaType: typeof image.media_type === 'string' ? image.media_type : '',
        width: typeof image.width === 'number' ? image.width : 0,
        height: typeof image.height === 'number' ? image.height : 0,
        name: typeof image.name === 'string' ? image.name : '',
      });
    }

    const videos = Array.isArray(parsed.videos) ? parsed.videos : [];
    for (const video of videos) {
      if (video === null || typeof video !== 'object') continue;
      const url = typeof video.url === 'string' ? video.url : '';
      const name = fileNameOfUrl(url);
      if (name.length === 0) continue;
      push({
        type: 'video',
        attachmentId: `media:${name}`,
        mediaType: typeof video.mime === 'string' ? video.mime : '',
        width: 0,
        height: 0,
        name,
      });
    }
  }

  // ② markdown 链接 / 图片语法（助手正文最常见的交付形态）
  MARKDOWN_ANY_LINK.lastIndex = 0;
  let link;
  while ((link = MARKDOWN_ANY_LINK.exec(text)) !== null) {
    pushLocal(link[2], link[1]);
  }

  // ③ `Presented <路径>` 逐行输出（present 工具）
  const PRESENTED_LINE = /^\s*Presented\s+(.+?)\s*$/gim;
  let presented;
  while ((presented = PRESENTED_LINE.exec(text)) !== null) {
    const target = presented[1].replace(/^[`'"]|[`'"]$/g, '').trim();
    pushLocal(target, '');
  }

  return blocks;
}

/**
 * 生成类工具的结果正文是整段 JSON（task_id/status/videos…），
 * 手机上直接渲染可读性差；抽到媒体块后，把正文换成 JSON 里的
 * 人类可读 message 字段（没有就保留原文）。
 */
function friendlyToolText(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  if (!text.startsWith('{')) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.message === 'string' && parsed.message.length > 0) {
      const error = typeof parsed.error === 'string' && parsed.error.length > 0 ? `\n错误：${parsed.error}` : '';
      return parsed.message + error;
    }
  } catch {
    // 非 JSON，保留原文
  }
  return text;
}

/** 把 DSH ContentBlock 转成手机线格式块。 */
export function blockToWire(block) {
  if (block === null || typeof block !== 'object') return null;
  const type = block.type;
  if (type === 'text') {
    return { type: 'text', text: stripLocalMediaPaths(typeof block.text === 'string' ? block.text : '') };
  }
  if (type === 'reasoning') {
    return { type: 'reasoning', text: stripLocalMediaPaths(typeof block.text === 'string' ? block.text : '') };
  }
  if (type === 'image') {
    const attachment = block.attachment && typeof block.attachment === 'object' ? block.attachment : {};
    return {
      type: 'image',
      attachmentId: typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '',
      mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : '',
      width: typeof attachment.width === 'number' ? attachment.width : 0,
      height: typeof attachment.height === 'number' ? attachment.height : 0,
      name: typeof attachment.name === 'string' ? attachment.name : '',
    };
  }
  if (type === 'file') {
    const attachment = block.attachment && typeof block.attachment === 'object' ? block.attachment : {};
    return {
      type: 'file',
      attachmentId: typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '',
      name: typeof attachment.name === 'string' ? attachment.name : '',
      bytes: typeof attachment.bytes === 'number' ? attachment.bytes : 0,
    };
  }
  if (type === 'video') {
    const attachment = block.attachment && typeof block.attachment === 'object' ? block.attachment : {};
    return {
      type: 'video',
      attachmentId: typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '',
      mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : '',
      width: typeof attachment.width === 'number' ? attachment.width : 0,
      height: typeof attachment.height === 'number' ? attachment.height : 0,
      name: typeof attachment.name === 'string' ? attachment.name : '',
    };
  }
  if (type === 'tool-call') {
    return {
      type: 'toolCall',
      id: typeof block.id === 'string' ? block.id : '',
      name: typeof block.name === 'string' ? block.name : '',
      arguments: typeof block.arguments === 'string' ? block.arguments : '',
    };
  }
  if (type === 'tool-addition') {
    return { type: 'toolAddition', toolName: typeof block.toolName === 'string' ? block.toolName : '' };
  }
  if (type === 'tool-removal') {
    return { type: 'toolRemoval', toolName: typeof block.toolName === 'string' ? block.toolName : '' };
  }
  return null;
}

function blocksToWire(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const block of blocks) {
    const wire = blockToWire(block);
    if (wire !== null) out.push(wire);
  }
  return out;
}

/** 从块数组里抽纯文本（供列表摘要 / 通知用）。 */
export function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

// ── v3.5：会话列表「最后一条消息预览」（contract.md §3.1 preview/lastRole）──

/**
 * 单行化 + 截断：连续空白折叠成一个空格，首尾去空白；
 * 超过 limit（按 Unicode 码点数，中文不虚增）时截断并补省略号，总长 ≤ limit。
 */
export function toPreviewText(text, limit = 60) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : 60;
  const single = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (single.length === 0) return '';
  const characters = Array.from(single);
  if (characters.length <= max) return single;
  return `${characters.slice(0, max - 1).join('')}…`;
}

/**
 * 从手机线内容块生成预览文本：
 *   text 拼接；image/video/file/toolCall 块 → 占位符；reasoning 不进预览。
 * 没有任何可读内容时返回空串。
 */
export function previewOfBlocks(blocks, limit = 60) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' || block.type === 'reasoning') {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        parts.push(block.text.trim());
      }
      continue;
    }
    if (block.type === 'image') parts.push('[图片]');
    else if (block.type === 'video') parts.push('[视频]');
    else if (block.type === 'file') parts.push('[文件]');
    else if (block.type === 'toolCall') parts.push('[工具调用]');
  }
  return toPreviewText(parts.join(' '), limit);
}

/**
 * 取消息数组里最后一条 user/assistant 气泡（tool/system/developer 不算，
 * lastRole 契约只有 'user'|'assistant'）。没有返回 undefined。
 */
export function lastChatMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message === null || typeof message !== 'object') continue;
    if (message.role === 'user' || message.role === 'assistant') return message;
  }
  return undefined;
}

/**
 * 手机端带宽裁剪。
 * 真实会话里单条工具结果是几十 KB 级（实测一页 2 个 turn 就有 464KB），
 * 直接在手机上渲染既慢又没必要。所以：
 *  - 每类角色给一个正文上限，超出部分截断并标注原始长度；
 *  - tool / system / developer 的正文只走 `text` 字段，`blocks` 里不再重复一份纯文本
 *    （原来同一段文字在 blocks 和 text 里各存一遍，白白多一倍流量）。
 */
const TEXT_LIMIT = { user: 6000, assistant: 6000, tool: 1500, system: 3000, developer: 3000 };
const ARGUMENTS_LIMIT = 1500;

function capText(text, limit) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断，原文 ${value.length} 字）`;
}

function capBlocks(blocks, limit) {
  const out = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' || block.type === 'reasoning') {
      out.push(Object.assign({}, block, { text: capText(block.text, limit) }));
    } else if (block.type === 'toolCall') {
      out.push(Object.assign({}, block, { arguments: capText(block.arguments, ARGUMENTS_LIMIT) }));
    } else {
      out.push(block);
    }
  }
  return out;
}

/** 就地裁剪消息数组（返回同一数组，便于链式使用）。 */
function trimMessages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = typeof message.role === 'string' ? message.role : '';
    const limit = TEXT_LIMIT[role] !== undefined ? TEXT_LIMIT[role] : 4000;
    message.text = capText(message.text, limit);
    if (!Array.isArray(message.blocks)) {
      message.blocks = [];
    } else if (role === 'tool' || role === 'system' || role === 'developer') {
      // 纯文本已在 text 里，这里只保留图片/文件等非文本块
      message.blocks = message.blocks.filter(
        (block) => block !== null && typeof block === 'object' && block.type !== 'text',
      );
    } else {
      message.blocks = capBlocks(message.blocks, limit);
    }
  }
  return messages;
}

function usageToWire(usage) {
  if (usage === null || typeof usage !== 'object') return undefined;
  const out = {};
  if (typeof usage.inputTokens === 'number') out.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === 'number') out.outputTokens = usage.outputTokens;
  if (typeof usage.totalTokens === 'number') out.totalTokens = usage.totalTokens;
  if (typeof usage.cacheReadTokens === 'number') out.cacheReadTokens = usage.cacheReadTokens;
  if (typeof usage.cacheWriteTokens === 'number') out.cacheWriteTokens = usage.cacheWriteTokens;
  if (typeof usage.reasoningTokens === 'number') out.reasoningTokens = usage.reasoningTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 把一段真实事件流投影成：
 *   messages: 手机可直接渲染的气泡数组（按 seq 升序）
 *   turns:    turn 元信息（turn 号 + 结束原因），供分页与状态展示
 *   meta:     会话级配置事件（权限预设 / 沙箱 / 审批 / 模型选择）
 *   title:    最新标题
 */
export function projectEvents(events, options = {}) {
  const messages = [];
  const turns = [];
  const meta = { preset: '', sandbox: '', approval: '', model: undefined };
  let title = '';
  let titleUpdatedAt = 0;
  /** @type {Map<string, string>} callId → toolName */
  const toolNames = new Map();
  let currentTurn = 0;
  let currentStep = 0;
  /** 会话工作区：相对媒体路径（`deliver/demo.mp4`）按它展开成绝对路径。 */
  const cwd = typeof options.cwd === 'string' ? options.cwd : '';

  /**
   * 把媒体块挂到「同 turn 最后一条助手消息」上。
   *
   * 为什么要提升：工具结果的媒体块按契约挂在 role:'tool' 消息里，
   * 而手机端（鸿蒙 1.0.x）的工具行只渲染 args/resultText、完全不看 blocks，
   * 所以只挂在 tool 上用户永远看不到视频。助手消息的媒体是必渲染的，
   * 提升一份过去即可让老客户端无需升级就能显示。
   * 找不到同 turn 助手消息时（例如只有工具事件）就只留在 tool 上。
   */
  const promoteToAssistant = (mediaBlocks) => {
    if (mediaBlocks.length === 0) return;
    let target = null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant') continue;
      if (message.turn !== currentTurn) break;
      target = message;
      break;
    }
    if (target === null) return;
    if (!Array.isArray(target.blocks)) target.blocks = [];
    for (const media of mediaBlocks) {
      const exists = target.blocks.some(
        (block) => block.type === media.type && block.attachmentId === media.attachmentId,
      );
      if (!exists) target.blocks.push(media);
    }
  };

  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue;
    const type = event.type;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const seq = typeof event.seq === 'number' ? event.seq : 0;
    const time = typeof event.time === 'number' ? event.time : 0;

    if (type === 'turn/start') {
      currentTurn = typeof data.turn === 'number' ? data.turn : currentTurn;
      turns.push({ turn: currentTurn, startedSeq: seq, startedAt: time, ended: '', endedAt: 0, endSeq: 0 });
      continue;
    }
    if (type === 'turn/end') {
      const last = turns.length > 0 ? turns[turns.length - 1] : undefined;
      const reason = data.reason && typeof data.reason === 'object' ? data.reason : {};
      if (last !== undefined) {
        last.ended = typeof reason.kind === 'string' ? reason.kind : '';
        last.endedAt = time;
        last.endSeq = seq;
        if (last.ended === 'error' && reason.error && typeof reason.error.message === 'string') {
          last.errorMessage = reason.error.message;
          last.errorCode = typeof reason.error.code === 'string' ? reason.error.code : '';
        }
      }
      continue;
    }
    if (type === 'step/start') {
      currentStep = typeof data.step === 'number' ? data.step : currentStep;
      continue;
    }
    if (type === 'step/end') continue;

    if (type === 'permission/preset') {
      if (typeof data.preset === 'string') meta.preset = data.preset;
      continue;
    }
    if (type === 'sandbox/mode') {
      if (typeof data.mode === 'string') meta.sandbox = data.mode;
      continue;
    }
    if (type === 'approval/policy') {
      if (typeof data.policy === 'string') meta.approval = data.policy;
      continue;
    }
    if (type === 'model/selection') {
      meta.model = {
        provider: typeof data.provider === 'string' ? data.provider : '',
        model: typeof data.model === 'string' ? data.model : '',
        reasoningEffort: typeof data.reasoningEffort === 'string' ? data.reasoningEffort : '',
      };
      continue;
    }
    if (type === 'session/title') {
      if (typeof data.title === 'string' && data.title.length > 0) {
        title = data.title;
        titleUpdatedAt = time;
      }
      continue;
    }

    if (type === 'user/message') {
      const blocks = blocksToWire(data.content);
      messages.push({
        id: typeof data.id === 'string' ? data.id : `u_${seq}`,
        seq,
        role: 'user',
        time,
        turn: currentTurn,
        step: currentStep,
        blocks,
        text: textOfBlocks(data.content),
      });
      continue;
    }

    if (type === 'assistant/message') {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      const source = message.source && typeof message.source === 'object' ? message.source : {};
      const blocks = blocksToWire(message.content);
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block && block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
          toolNames.set(block.id, block.name);
        }
      }
      // 助手正文里的媒体链接（`[demo](<deliver/demo.mp4>)`）转成媒体块，
      // 正文里的路径同时降级成可读文字，手机端才不会只看到一串本地路径。
      const assistantText = textOfBlocks(message.content);
      for (const media of extractMediaBlocks(assistantText, cwd)) {
        if (!blocks.some((block) => block.type === media.type && block.attachmentId === media.attachmentId)) {
          blocks.push(media);
        }
      }
      messages.push({
        id: typeof message.id === 'string' ? message.id : `a_${seq}`,
        seq,
        role: 'assistant',
        time,
        turn: typeof data.turn === 'number' ? data.turn : currentTurn,
        step: typeof data.step === 'number' ? data.step : currentStep,
        blocks,
        text: stripLocalMediaPaths(textOfBlocks(message.content)),
        provider: typeof source.provider === 'string' ? source.provider : '',
        model: typeof source.model === 'string' ? source.model : '',
        usage: usageToWire(data.usage),
        interrupted: data.interrupted === true,
      });
      continue;
    }

    if (type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : '';
      const name = typeof data.name === 'string' ? data.name : '';
      if (callId.length > 0 && name.length > 0) toolNames.set(callId, name);
      continue;
    }

    if (type === 'tool/result') {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      const callId = typeof message.toolCallId === 'string'
        ? message.toolCallId
        : (typeof data.callId === 'string' ? data.callId : '');
      const blocks = blocksToWire(message.content);
      const rawText = textOfBlocks(message.content);
      const friendlyText = friendlyToolText(rawText);
      // 生成类工具（生图/生视频/交付）只返回媒体引用或路径，没有可渲染的块；
      // 这里把引用补成 image / video 块，手机端才能真正看到素材。
      const mediaBlocks = [];
      for (const media of extractMediaBlocks(rawText, cwd)) {
        if (!blocks.some((block) => block.type === media.type && block.attachmentId === media.attachmentId)) {
          blocks.push(media);
        }
        mediaBlocks.push(media);
      }
      // 手机端工具行不渲染 blocks，同 turn 助手消息上再挂一份（见 promoteToAssistant）。
      promoteToAssistant(mediaBlocks);
      const error = data.error && typeof data.error === 'object' ? data.error : undefined;
      messages.push({
        id: typeof message.id === 'string' ? message.id : `t_${seq}`,
        seq,
        role: 'tool',
        time,
        turn: typeof data.turn === 'number' ? data.turn : currentTurn,
        step: typeof data.step === 'number' ? data.step : currentStep,
        blocks,
        text: stripLocalMediaPaths(friendlyText),
        callId,
        toolName: toolNames.get(callId) ?? '',
        isError: message.isError === true || error !== undefined,
        errorCode: error !== undefined && typeof error.code === 'string' ? error.code : '',
      });
      continue;
    }

    if (type === 'system/message' || type === 'developer/message') {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      const blocks = blocksToWire(message.content);
      if (blocks.length === 0) continue;
      messages.push({
        id: typeof message.id === 'string' ? message.id : `s_${seq}`,
        seq,
        role: type === 'system/message' ? 'system' : 'developer',
        time,
        turn: typeof data.turn === 'number' ? data.turn : currentTurn,
        step: typeof data.step === 'number' ? data.step : currentStep,
        blocks,
        text: textOfBlocks(message.content),
        hidden: true,
      });
      continue;
    }
  }

  return { messages: trimMessages(messages), turns, meta, title, titleUpdatedAt };
}

/**
 * 按 turn 分页：取最后 N 个 turn（或截止到 beforeTurn 之前的 N 个）。
 * @param {unknown[]} events
 * @param {{ turns?: number, beforeTurn?: number, cwd?: string }} options
 */
export function pageByTurns(events, options = {}) {
  const wantTurns = Number.isInteger(options.turns) && options.turns > 0 ? Math.min(options.turns, 200) : 10;
  const projected = projectEvents(events, { cwd: options.cwd });
  const allTurns = projected.turns;
  if (allTurns.length === 0) {
    return {
      messages: projected.messages,
      turns: [],
      meta: projected.meta,
      title: projected.title,
      titleUpdatedAt: projected.titleUpdatedAt,
      hasMore: false,
      nextBeforeTurn: 0,
    };
  }

  // 选区：默认最后 wantTurns 个 turn；beforeTurn 时取编号 < beforeTurn 的尾部
  let sliceEnd = allTurns.length;
  if (Number.isInteger(options.beforeTurn) && options.beforeTurn > 0) {
    sliceEnd = 0;
    for (let i = 0; i < allTurns.length; i += 1) {
      if (allTurns[i].turn < options.beforeTurn) sliceEnd = i + 1;
    }
  }
  const sliceStart = Math.max(0, sliceEnd - wantTurns);
  const selected = allTurns.slice(sliceStart, sliceEnd);

  // 该区间的起始 seq（含）～结束 seq（含）
  // 注意：DSH 日志里 user/message 排在 turn/start 之前，所以起始 seq 要
  // 回退到「上一个 turn 的结束位置 + 1」，否则用户提问会被漏掉。
  let startSeq = selected.length > 0 ? selected[0].startedSeq : 0;
  if (sliceStart > 0) {
    const previous = allTurns[sliceStart - 1];
    if (previous !== undefined && previous.endSeq > 0) {
      startSeq = previous.endSeq + 1;
    } else if (selected.length > 0) {
      // 上一 turn 没有 end 记录（例如中断），退一步把它的 start 之前也算进来
      startSeq = 0;
    }
  } else {
    startSeq = 0;
  }
  const endTurn = selected.length > 0 ? selected[selected.length - 1] : undefined;
  const endSeq = endTurn !== undefined && endTurn.endSeq > 0 ? endTurn.endSeq : Number.MAX_SAFE_INTEGER;

  const messages = projected.messages.filter(
    (message) => message.seq >= startSeq && message.seq <= endSeq,
  );

  return {
    messages,
    turns: selected.map((turn) => ({
      turn: turn.turn,
      startedAt: turn.startedAt,
      ended: turn.ended,
      endedAt: turn.endedAt,
      errorMessage: turn.errorMessage,
      errorCode: turn.errorCode,
    })),
    meta: projected.meta,
    title: projected.title,
    titleUpdatedAt: projected.titleUpdatedAt,
    hasMore: sliceStart > 0,
    nextBeforeTurn: selected.length > 0 ? selected[0].turn : 0,
  };
}

/**
 * 把单个事件转换成手机线事件（用于 WS 实时推送）。
 * 返回 null 表示该事件不需要下发（例如内部元数据事件）。
 */
export function eventToWire(sessionId, event, options = {}) {
  if (event === null || typeof event !== 'object') return null;
  const type = event.type;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const seq = typeof event.seq === 'number' ? event.seq : 0;
  const time = typeof event.time === 'number' ? event.time : 0;
  /** 会话工作区（相对媒体路径按它展开），由 EventHub 从 session 对象上带下来。 */
  const cwd = typeof options.cwd === 'string' ? options.cwd : '';

  if (type === 'turn/start') {
    return { name: 'turn.started', sessionId, seq, timestamp: time, payload: { turn: data.turn ?? 0 } };
  }
  if (type === 'turn/end') {
    const reason = data.reason && typeof data.reason === 'object' ? data.reason : {};
    return {
      name: 'turn.finished',
      sessionId,
      seq,
      timestamp: time,
      payload: {
        turn: data.turn ?? 0,
        reason: typeof reason.kind === 'string' ? reason.kind : '',
        message: reason.error && typeof reason.error.message === 'string' ? reason.error.message : '',
      },
    };
  }
  if (type === 'user/message') {
    const blocks = blocksToWire(data.content);
    return {
      name: 'message.created',
      sessionId,
      seq,
      timestamp: time,
      payload: {
        id: typeof data.id === 'string' ? data.id : `u_${seq}`,
        role: 'user',
        blocks,
        text: textOfBlocks(data.content),
      },
    };
  }
  if (type === 'assistant/message') {
    const message = data.message && typeof data.message === 'object' ? data.message : {};
    const source = message.source && typeof message.source === 'object' ? message.source : {};
    const blocks = blocksToWire(message.content);
    // 助手正文里的媒体链接 → 媒体块（与历史投影同一套规则）
    for (const media of extractMediaBlocks(textOfBlocks(message.content), cwd)) {
      if (!blocks.some((block) => block.type === media.type && block.attachmentId === media.attachmentId)) {
        blocks.push(media);
      }
    }
    return {
      name: 'message.done',
      sessionId,
      seq,
      timestamp: time,
      payload: {
        id: typeof message.id === 'string' ? message.id : `a_${seq}`,
        role: 'assistant',
        blocks,
        text: stripLocalMediaPaths(textOfBlocks(message.content)),
        provider: typeof source.provider === 'string' ? source.provider : '',
        model: typeof source.model === 'string' ? source.model : '',
        usage: usageToWire(data.usage),
        interrupted: data.interrupted === true,
        turn: data.turn ?? 0,
        step: data.step ?? 0,
      },
    };
  }
  if (type === 'tool/result') {
    const message = data.message && typeof data.message === 'object' ? data.message : {};
    const blocks = blocksToWire(message.content);
    const rawText = textOfBlocks(message.content);
    const friendlyText = friendlyToolText(rawText);
    for (const media of extractMediaBlocks(rawText, cwd)) {
      if (!blocks.some((block) => block.type === media.type && block.attachmentId === media.attachmentId)) {
        blocks.push(media);
      }
    }
    const error = data.error && typeof data.error === 'object' ? data.error : undefined;
    return {
      name: 'message.part',
      sessionId,
      seq,
      timestamp: time,
      payload: {
        id: typeof message.id === 'string' ? message.id : `t_${seq}`,
        role: 'tool',
        kind: 'tool-result',
        blocks,
        text: stripLocalMediaPaths(friendlyText),
        callId: typeof message.toolCallId === 'string' ? message.toolCallId : '',
        isError: message.isError === true || error !== undefined,
        turn: data.turn ?? 0,
        step: data.step ?? 0,
      },
    };
  }
  if (type === 'tool/call') {
    return {
      name: 'message.part',
      sessionId,
      seq,
      timestamp: time,
      payload: {
        kind: 'tool-call',
        callId: typeof data.callId === 'string' ? data.callId : '',
        toolName: typeof data.name === 'string' ? data.name : '',
        arguments: typeof data.arguments === 'string' ? data.arguments : '',
        turn: data.turn ?? 0,
        step: data.step ?? 0,
      },
    };
  }
  if (type === 'session/title') {
    return {
      name: 'session.updated',
      sessionId,
      seq,
      timestamp: time,
      payload: { title: typeof data.title === 'string' ? data.title : '' },
    };
  }
  if (type === 'model/selection') {
    return {
      name: 'settings.updated',
      sessionId,
      seq,
      timestamp: time,
      payload: {
        model: {
          provider: typeof data.provider === 'string' ? data.provider : '',
          model: typeof data.model === 'string' ? data.model : '',
          reasoningEffort: typeof data.reasoningEffort === 'string' ? data.reasoningEffort : '',
        },
      },
    };
  }
  return null;
}
