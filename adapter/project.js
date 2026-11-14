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
 * 并用 C:\Users\CGLY\.dsh\sessions 下真实 session.v4.jsonl.zstd 逐条核对。
 */

/** 把 DSH ContentBlock 转成手机线格式块。 */
export function blockToWire(block) {
  if (block === null || typeof block !== 'object') return null;
  const type = block.type;
  if (type === 'text') {
    return { type: 'text', text: typeof block.text === 'string' ? block.text : '' };
  }
  if (type === 'reasoning') {
    return { type: 'reasoning', text: typeof block.text === 'string' ? block.text : '' };
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
export function projectEvents(events) {
  const messages = [];
  const turns = [];
  const meta = { preset: '', sandbox: '', approval: '', model: undefined };
  let title = '';
  let titleUpdatedAt = 0;
  /** @type {Map<string, string>} callId → toolName */
  const toolNames = new Map();
  let currentTurn = 0;
  let currentStep = 0;

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
      messages.push({
        id: typeof message.id === 'string' ? message.id : `a_${seq}`,
        seq,
        role: 'assistant',
        time,
        turn: typeof data.turn === 'number' ? data.turn : currentTurn,
        step: typeof data.step === 'number' ? data.step : currentStep,
        blocks,
        text: textOfBlocks(message.content),
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
      const error = data.error && typeof data.error === 'object' ? data.error : undefined;
      messages.push({
        id: typeof message.id === 'string' ? message.id : `t_${seq}`,
        seq,
        role: 'tool',
        time,
        turn: typeof data.turn === 'number' ? data.turn : currentTurn,
        step: typeof data.step === 'number' ? data.step : currentStep,
        blocks,
        text: textOfBlocks(message.content),
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
 * @param {{ turns?: number, beforeTurn?: number }} options
 */
export function pageByTurns(events, options = {}) {
  const wantTurns = Number.isInteger(options.turns) && options.turns > 0 ? Math.min(options.turns, 200) : 10;
  const projected = projectEvents(events);
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
export function eventToWire(sessionId, event) {
  if (event === null || typeof event !== 'object') return null;
  const type = event.type;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const seq = typeof event.seq === 'number' ? event.seq : 0;
  const time = typeof event.time === 'number' ? event.time : 0;

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
    return {
      name: 'message.done',
      sessionId,
      seq,
      timestamp: time,
      payload: {
        id: typeof message.id === 'string' ? message.id : `a_${seq}`,
        role: 'assistant',
        blocks,
        text: textOfBlocks(message.content),
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
        text: textOfBlocks(message.content),
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
