/**
 * dsh-phone-bridge · 令牌与配对码
 *
 * 设计：
 * - 令牌是访问桥的唯一凭据（Bearer / ?token=），默认 7 天有效，落盘持久化。
 * - 配对码是「换取令牌」的一次性短码，默认 10 分钟有效，只在电脑本机可见
 *   （/pair 页面、DSH 对话里的 /pair 命令、宿主日志）。
 * - 令牌明文只存在于电脑端磁盘与手机端本地存储；桥永不回显已签发令牌给第三方。
 *
 * 证据等级：[推断] —— 本文件不依赖任何 DSH 内部 API，纯本机实现。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError, ErrorCode } from './errors.js';

const TOKEN_PREFIX = 'dsb_';
const CODE_DIGITS = 6;

function nowMs() {
  return Date.now();
}

function randomToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
}

function randomCode() {
  // 6 位数字，避免首 0 被吃掉：始终格式化到 6 位
  const value = crypto.randomInt(0, 10 ** CODE_DIGITS);
  return String(value).padStart(CODE_DIGITS, '0');
}

/**
 * 令牌存储。文件不存在或损坏时静默以内存模式运行（不影响桥启动）。
 */
export class TokenStore {
  /** @param {{ file?: string, ttlMs?: number, log?: (msg: string) => void }} options */
  constructor(options = {}) {
    this.file = typeof options.file === 'string' && options.file.length > 0 ? options.file : '';
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 7 * 24 * 3600 * 1000;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    /** @type {Map<string, { token: string, clientId: string, clientName: string, issuedAt: number, expiresAt: number, lastSeenAt: number, lastIp: string }>} */
    this.records = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
      const cutoff = nowMs();
      for (const item of list) {
        if (!item || typeof item.token !== 'string') continue;
        if (typeof item.expiresAt !== 'number' || item.expiresAt <= cutoff) continue;
        this.records.set(item.token, {
          token: item.token,
          clientId: typeof item.clientId === 'string' ? item.clientId : '',
          clientName: typeof item.clientName === 'string' ? item.clientName : '',
          issuedAt: typeof item.issuedAt === 'number' ? item.issuedAt : cutoff,
          expiresAt: item.expiresAt,
          lastSeenAt: typeof item.lastSeenAt === 'number' ? item.lastSeenAt : cutoff,
          lastIp: typeof item.lastIp === 'string' ? item.lastIp : '',
        });
      }
      this.log(`已载入 ${this.records.size} 个未过期令牌`);
    } catch (error) {
      this.log(`令牌文件读取失败（按内存模式继续）：${error?.message ?? String(error)}`);
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tokens = [...this.records.values()];
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 3, tokens }, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.log(`令牌文件写入失败：${error?.message ?? String(error)}`);
    }
  }

  /**
   * 签发令牌。
   * @param {{ clientName?: string, ip?: string }} meta
   */
  issue(meta = {}) {
    const token = randomToken();
    const issuedAt = nowMs();
    const record = {
      token,
      clientId: `phone-${crypto.randomUUID().slice(0, 8)}`,
      clientName: typeof meta.clientName === 'string' && meta.clientName.trim().length > 0 ? meta.clientName.trim().slice(0, 60) : '手机',
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      lastSeenAt: issuedAt,
      lastIp: typeof meta.ip === 'string' ? meta.ip : '',
    };
    this.records.set(token, record);
    this.save();
    return { ...record };
  }

  /** 校验令牌；成功返回记录，失败抛 BridgeError。 */
  verify(token, ip = '') {
    if (typeof token !== 'string' || token.length === 0) {
      throw new BridgeError(ErrorCode.AUTH_REQUIRED, '缺少访问令牌');
    }
    const record = this.records.get(token);
    if (record === undefined) {
      throw new BridgeError(ErrorCode.AUTH_INVALID, '访问令牌无效');
    }
    if (record.expiresAt <= nowMs()) {
      this.records.delete(token);
      this.save();
      throw new BridgeError(ErrorCode.AUTH_EXPIRED, '访问令牌已过期，请重新配对');
    }
    record.lastSeenAt = nowMs();
    if (ip.length > 0) record.lastIp = ip;
    return record;
  }

  /** 刷新过期时间（不改变 token 本身）。 */
  touch(token) {
    const record = this.records.get(token);
    if (record === undefined) return undefined;
    record.lastSeenAt = nowMs();
    record.expiresAt = nowMs() + this.ttlMs;
    this.save();
    return record;
  }

  revoke(token) {
    const existed = this.records.delete(token);
    if (existed) this.save();
    return existed;
  }

  /** 撤销某个客户端的所有令牌。 */
  revokeClient(clientId) {
    let removed = 0;
    for (const [token, record] of this.records) {
      if (record.clientId === clientId) {
        this.records.delete(token);
        removed += 1;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  list() {
    return [...this.records.values()].map((record) => ({
      clientId: record.clientId,
      clientName: record.clientName,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      lastSeenAt: record.lastSeenAt,
      lastIp: record.lastIp,
    }));
  }
}

/**
 * 配对码管理。按需生成，过期自动轮换。
 */
export class PairingCode {
  /** @param {{ ttlMs?: number }} options */
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 10 * 60 * 1000;
    this.code = '';
    this.expiresAt = 0;
    this.attempts = 0;
    this.maxAttempts = 20;
  }

  /** 取当前有效配对码；不存在或已过期就重新生成。 */
  current() {
    if (this.code.length === 0 || this.expiresAt <= nowMs()) {
      this.rotate();
    }
    return { code: this.code, expiresAt: this.expiresAt };
  }

  rotate() {
    this.code = randomCode();
    this.expiresAt = nowMs() + this.ttlMs;
    this.attempts = 0;
    return { code: this.code, expiresAt: this.expiresAt };
  }

  /** 校验配对码；成功后立即作废（一次性）。 */
  consume(code) {
    if (this.code.length === 0 || this.expiresAt <= nowMs()) {
      throw new BridgeError(ErrorCode.PAIRING_CODE_INVALID, '配对码已过期，请在电脑上重新打开配对页获取新码');
    }
    if (this.attempts >= this.maxAttempts) {
      throw new BridgeError(ErrorCode.RATE_LIMITED, '配对尝试次数过多，请重新打开配对页', { retryAfter: 60 });
    }
    this.attempts += 1;
    const input = String(code ?? '').trim();
    if (input.length !== this.code.length || input !== this.code) {
      throw new BridgeError(ErrorCode.PAIRING_CODE_INVALID, '配对码不正确');
    }
    // 一次性：用掉即轮换
    this.rotate();
    return true;
  }
}
