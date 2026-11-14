/**
 * 扫描真实会话日志，找出 image / file 内容块的真实结构。
 *
 * 目的：确认 ImageAttachmentRef 在会话事件里到底带哪些字段
 * （attachmentId / mediaType / bytes / width / height / name / originalDimensions），
 * 以便桥端能据此调用 ctx.attachments.readImage() 把图片字节流给手机。
 *
 * 用法：node tools/scan-images.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 多帧 zstd：Node 的 zstdDecompressSync 只解第一帧，必须按 magic 手工切帧。 */
function decompressMultiFrame(buffer) {
  const offsets = [];
  let cursor = 0;
  while (cursor < buffer.length - 4) {
    const index = buffer.indexOf(MAGIC, cursor);
    if (index < 0) break;
    offsets.push(index);
    cursor = index + 4;
  }
  if (offsets.length === 0) return buffer;
  const chunks = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
    chunks.push(zlib.zstdDecompressSync(buffer.subarray(start, end)));
  }
  return Buffer.concat(chunks);
}

function sessionRoot() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

function listLogs(root) {
  const found = [];
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const dir = path.join(wsDir, s.name);
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.startsWith('session.') && f.endsWith('.zstd')) {
          found.push({ workspace: ws.name, sessionId: s.name, file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size });
        }
      }
    }
  }
  return found;
}

const root = sessionRoot();
const logs = listLogs(root);
console.log(`日志根目录: ${root}`);
console.log(`找到 ${logs.length} 个会话日志`);

const imageSamples = [];
const fileSamples = [];
let scanned = 0;

for (const log of logs) {
  let text;
  try {
    const raw = fs.readFileSync(log.file);
    text = decompressMultiFrame(raw).toString('utf8');
  } catch (error) {
    console.log(`跳过 ${log.sessionId}: ${error.message}`);
    continue;
  }
  scanned += 1;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    if (!line.includes('"image"') && !line.includes('"file"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const data = record && record.data;
    if (!data) continue;
    const message = data.message;
    if (!message || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && block.type === 'image' && imageSamples.length < 4) {
        imageSamples.push({ sessionId: log.sessionId, eventType: record.type, block });
      }
      if (block && block.type === 'file' && fileSamples.length < 4) {
        fileSamples.push({ sessionId: log.sessionId, eventType: record.type, block });
      }
    }
  }
}

console.log(`实际解压 ${scanned} 个日志`);

console.log('\n=== image 块样本 ===');
if (imageSamples.length === 0) {
  console.log('（未找到 image 块）');
} else {
  for (const sample of imageSamples) {
    console.log(JSON.stringify(sample, null, 2));
  }
}

console.log('\n=== file 块样本 ===');
if (fileSamples.length === 0) {
  console.log('（未找到 file 块）');
} else {
  for (const sample of fileSamples) {
    console.log(JSON.stringify(sample, null, 2));
  }
}
