/**
 * dsh-phone-bridge v2 · 目录浏览（只读）
 *
 * 参考 hdsh-remote-pair 的 directories.js：
 * - 列一层子目录 + 面包屑
 * - 探测实际存在的盘符（Windows）
 * - 不读文件内容，隐藏目录打标
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_ENTRIES = 1000;

function hidden(name) {
  return name.startsWith('.');
}

function crumbsFor(directory) {
  const parsed = path.parse(directory);
  const crumbs = [{ name: parsed.root, path: parsed.root, hidden: false }];
  const relative = path.relative(parsed.root, directory);
  if (relative.length === 0) return crumbs;
  let current = parsed.root;
  for (const segment of relative.split(path.sep)) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    crumbs.push({ name: segment, path: current, hidden: hidden(segment) });
  }
  return crumbs;
}

function absoluteDirectory(raw) {
  const requested = typeof raw === 'string' ? raw.trim() : '';
  const directory = requested.length > 0 ? path.normalize(requested) : os.homedir();
  if (!path.isAbsolute(directory)) {
    throw Object.assign(new Error('目录必须是绝对路径'), { code: 'bad-path' });
  }
  return directory;
}

async function isDirectory(fullPath) {
  const stat = await fs.stat(fullPath);
  return stat.isDirectory();
}

/** 列出一层目录（含文件，带类型标记）。 */
export async function listDirectory(rawPath) {
  const directory = absoluteDirectory(rawPath);
  if (!await isDirectory(directory)) {
    throw Object.assign(new Error('目标不是目录'), { code: 'not-directory', path: directory });
  }
  const dirents = await fs.readdir(directory, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    if (entries.length >= MAX_ENTRIES) break;
    const fullPath = path.join(directory, dirent.name);
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = await isDirectory(fullPath);
      } catch {
        isDir = false;
      }
    }
    entries.push({
      name: dirent.name,
      path: fullPath,
      type: isDir ? 'dir' : 'file',
      hidden: hidden(dirent.name),
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return {
    path: directory,
    home: os.homedir(),
    truncated: dirents.length > MAX_ENTRIES,
    crumbs: crumbsFor(directory),
    entries,
  };
}

/** 探测电脑实际存在的盘符（仅 Windows 有意义）。 */
export async function listDrives() {
  if (process.platform !== 'win32') return [];
  const drives = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    try {
      if (await isDirectory(`${letter}:\\`)) drives.push(`${letter}:`);
    } catch {
      // 盘符不存在
    }
  }
  return drives;
}
