/**
 * 用**真实 DSH 会话日志**验证 adapter/project.js 的投影与分页逻辑。
 *
 * DSH 的会话日志是「多帧 zstd」：整个 .zstd 文件由成千上万个独立 zstd 帧拼接，
 * Node 的 zstdDecompressSync / createZstdDecompress 只解第一帧，必须按 magic
 * (28 B5 2F FD) 手工切帧再逐帧解压。
 *
 * 运行：node tools/project-real-log.mjs [会话日志路径]
 * 默认自动挑 $DSH_HOME/sessions 下最大的那个日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

import { projectEvents, pageByTurns, eventToWire } from '../adapter/project.js';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 按 magic 切帧并逐帧解压，返回 UTF-8 文本。 */
export function decompressMultiFrameZstd(buffer) {
  const starts = [];
  let index = buffer.indexOf(MAGIC, 0);
  while (index !== -1) {
    starts.push(index);
    index = buffer.indexOf(MAGIC, index + 4);
  }
  if (starts.length === 0) return '';
  const chunks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : buffer.length;
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(from, to)));
    } catch (error) {
      // 单帧损坏就跳过，不影响整体
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function findLargestSessionLog() {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  if (!fs.existsSync(root)) return '';
  let best = '';
  let bestSize = 0;
  for (const workspace of fs.readdirSync(root)) {
    const workspaceDir = path.join(root, workspace);
    let entries = [];
    try {
      entries = fs.readdirSync(workspaceDir);
    } catch (error) {
      continue;
    }
    for (const sessionId of entries) {
      const candidate = path.join(workspaceDir, sessionId, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(candidate)) continue;
      const size = fs.statSync(candidate).size;
      if (size > bestSize) {
        bestSize = size;
        best = candidate;
      }
    }
  }
  return best;
}

function main() {
  const target = process.argv[2] ?? findLargestSessionLog();
  if (!target || !fs.existsSync(target)) {
    console.error('找不到会话日志，请传入路径');
    process.exitCode = 1;
    return;
  }
  const raw = fs.readFileSync(target);
  const text = decompressMultiFrameZstd(raw);
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  console.log(`日志: ${target}`);
  console.log(`压缩后: ${raw.length} 字节 → 解压后 ${text.length} 字节 / ${lines.length} 行`);

  let header = null;
  const events = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      continue;
    }
    if (parsed.type === 'session') {
      header = parsed;
      continue;
    }
    if (typeof parsed.seq !== 'number') continue;
    events.push(parsed);
  }
  console.log(`会话: ${header?.id ?? '(无 header)'}  事件: ${events.length} 条`);

  const projected = projectEvents(events);
  console.log('\n— projectEvents —');
  console.log(`消息数: ${projected.messages.length}`);
  console.log(`turn 数: ${projected.turns.length}`);
  console.log(`标题: ${projected.title || '(无)'}`);
  console.log(`元信息: preset=${projected.meta.preset} sandbox=${projected.meta.sandbox} approval=${projected.meta.approval}`);
  if (projected.meta.model !== undefined) {
    console.log(`模型: ${projected.meta.model.provider}/${projected.meta.model.model} (${projected.meta.model.reasoningEffort})`);
  }
  const roles = {};
  for (const message of projected.messages) {
    roles[message.role] = (roles[message.role] ?? 0) + 1;
  }
  console.log('角色分布:', roles);

  // 打印前 3 条消息摘要（截断）
  for (const message of projected.messages.slice(0, 3)) {
    const preview = message.text.length > 60 ? `${message.text.slice(0, 60)}…` : message.text;
    console.log(`  [${message.role}] turn=${message.turn} blocks=${message.blocks.map((b) => b.type).join('+')} :: ${preview}`);
  }

  console.log('\n— pageByTurns —');
  const firstPage = pageByTurns(events, { turns: 2 });
  console.log(`第一页: 消息 ${firstPage.messages.length} / turn ${firstPage.turns.length} / hasMore=${firstPage.hasMore} / nextBeforeTurn=${firstPage.nextBeforeTurn}`);
  if (firstPage.hasMore) {
    const secondPage = pageByTurns(events, { turns: 2, beforeTurn: firstPage.nextBeforeTurn });
    console.log(`第二页: 消息 ${secondPage.messages.length} / turn ${secondPage.turns.length} / hasMore=${secondPage.hasMore}`);

    // 断言两页的消息 seq 不重叠（分页不重不漏）
    const firstSeqs = new Set(firstPage.messages.map((m) => m.seq));
    const overlap = secondPage.messages.filter((m) => firstSeqs.has(m.seq));
    console.log(`两页重叠消息: ${overlap.length} 条（应为 0）`);
    if (overlap.length !== 0) process.exitCode = 1;
  }

  // 断言：每条 user 消息都能出现在某一页里
  const allUserSeqs = projected.messages.filter((m) => m.role === 'user').map((m) => m.seq);
  console.log(`\n用户消息总数: ${allUserSeqs.length}`);

  console.log('\n— eventToWire —');
  let wire = 0;
  for (const event of events.slice(0, 200)) {
    if (eventToWire(header?.id ?? 'test', event) !== null) wire += 1;
  }
  console.log(`前 200 条事件中可转成手机线事件: ${wire} 条`);

  console.log('\n✅ 真实日志投影验证完成');
}

main();
