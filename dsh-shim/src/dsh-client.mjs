/**
 * DSH 客户端：鉴权 + RPC + 等待一轮回复。
 *
 * 只依赖 Node 内置的 fetch：不引 ws、不引 yaml、不引 SDK。
 * 这条路是实测出来的，不是照文档猜的（见 docs/protocol.md）：
 *
 *   1. 鉴权      GET /?token=<launch token>  →  Set-Cookie
 *                或  用 ~/.dsh/.credentials.yaml 里的签名密钥离线铸造 Cookie
 *   2. 建会话    POST /api/session/create
 *   3. 发消息    POST /api/session/prompt
 *   4. 取回复    POST /api/session/projections → values.turnOutline[].response
 *
 * 关键发现：**不需要 WebSocket**。DSH 的 `turnOutline` 投影里每一轮都带
 * `{turn, seq, prompt, response}`，轮次结束后就落在那儿，轮询就能拿到完整回复。
 * 这让整个桥接可以做到零依赖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const BROWSER_SESSION_KEY = 'client-connection/browser-session';
const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_LIFETIME_MS = 60 * 60 * 1000;
const COOKIE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const b64url = (buffer) =>
  Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export function resolveDshHome(explicit) {
  return explicit || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 从 .credentials.yaml 里抠出浏览器会话签名密钥（正则解析，不引 yaml） */
export function readBrowserSessionSecret(dshHome) {
  const file = path.join(resolveDshHome(dshHome), '.credentials.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const block = text.split(BROWSER_SESSION_KEY)[1] ?? '';
  const match = block.match(/secret:\s*([A-Za-z0-9_-]+)/);
  if (!match) return null;
  const decoded = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  // DSH 的密钥恒为 32 字节；长度不对说明换了方案，宁可失败也不要发坏 Cookie
  return decoded.byteLength === 32 ? decoded : null;
}

/** 离线铸造会话 Cookie（纯本地 HMAC，无网络往返，DSH 重启后依然有效） */
export function mintCookie(baseUrl, secret, lifetimeMs = COOKIE_LIFETIME_MS) {
  const authority = new URL(baseUrl).host;
  const body = b64url(
    Buffer.from(
      JSON.stringify({
        version: 1,
        authority,
        issuedAt: Date.now(),
        expiresAt: Date.now() + lifetimeMs,
      }),
      'utf8',
    ),
  );
  const signature = b64url(createHmac('sha256', secret).update(body).digest());
  const name = COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest());
  return `${name}=v1.${body}.${signature}`;
}

export function isLoopback(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '[::1]') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

export class DshError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'DshError';
    this.code = code;
    this.status = status;
  }
}

export class DshClient {
  constructor({ baseUrl = 'http://127.0.0.1:3080', authToken = '', dshHome, timeoutMs = 15000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.authToken = authToken || '';
    this.dshHome = dshHome;
    this.timeoutMs = timeoutMs;
    this.cookie = '';
    this.cookieExpiresAt = 0;
    this.strategy = '';
  }

  async ensureAuth() {
    if (this.cookie && Date.now() < this.cookieExpiresAt - COOKIE_REFRESH_MARGIN_MS) return this.cookie;

    // 优先离线铸造：不依赖启动器把 token 写进日志，DSH 重启也不会失效
    if (!this.authToken) {
      const secret = readBrowserSessionSecret(this.dshHome);
      if (secret && isLoopback(this.baseUrl)) {
        this.cookie = mintCookie(this.baseUrl, secret);
        this.cookieExpiresAt = Date.now() + COOKIE_LIFETIME_MS;
        this.strategy = 'minted';
        return this.cookie;
      }
      throw new DshError(
        `拿不到 DSH 凭据：既没有配置 authToken，也从 ${path.join(resolveDshHome(this.dshHome), '.credentials.yaml')} 读不到签名密钥。` +
          '请确认 DSH 已启动过一次（会写入凭据），或改用 launch token。',
      );
    }

    if (!isLoopback(this.baseUrl)) {
      throw new DshError(
        `拒绝把 launch token 发往非本机地址（${this.baseUrl}）：那是进程启动凭据，只应交给 127.0.0.1。`,
      );
    }

    const url = new URL(this.baseUrl);
    url.pathname = '/';
    url.search = '';
    url.searchParams.set('token', this.authToken);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    const setCookie = response.headers.get('set-cookie');
    await response.body?.cancel();
    if (!setCookie) {
      throw new DshError(`DSH 鉴权失败：HTTP ${response.status}（launch token 可能已过期，DSH 重启后旧 token 作废）`, {
        status: response.status,
      });
    }
    this.cookie = setCookie.split(';')[0];
    // token 换来的 Cookie 有效期由 DSH 决定，保守按 1 小时重换
    this.cookieExpiresAt = Date.now() + COOKIE_LIFETIME_MS;
    this.strategy = 'token';
    return this.cookie;
  }

  /** 调一个一元 RPC；必要时把旧 payload 包成 { args: { <wrapper>: payload } } */
  async rpc(method, args = {}, { retry = true } = {}) {
    const cookie = await this.ensureAuth();
    const endpoint = method.replace(/\./g, '/');
    const rpcId = randomUUID();
    const body = {
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    };

    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DshError(`连不上 DSH（${this.baseUrl}）：${error?.message ?? error}`);
    }

    if (response.status === 401 && retry) {
      // Cookie 失效（DSH 重启会换密钥）：清掉重来一次
      await response.body?.cancel();
      this.cookie = '';
      this.cookieExpiresAt = 0;
      return this.rpc(method, args, { retry: false });
    }

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new DshError(`DSH 返回的不是 JSON（${endpoint}）：${text.slice(0, 200)}`);
    }
    if (json?.type !== 'server-response' || !json.result) {
      throw new DshError(`DSH 响应格式异常（${endpoint}）：${text.slice(0, 200)}`);
    }
    if (json.result.ok !== true) {
      const error = json.result.error ?? {};
      throw new DshError(`DSH 拒绝 ${endpoint}：${error.code ?? ''} ${error.message ?? JSON.stringify(error)}`, {
        code: error.code,
      });
    }
    return json.result.value;
  }

  async createSession({ agentPreset, cwd } = {}) {
    const request = {};
    if (agentPreset) request.agentPreset = agentPreset;
    if (cwd) request.cwd = cwd;
    const value = await this.rpc('session/create', { request });
    return value.sessionId;
  }

  async prompt(sessionId, text) {
    return this.rpc('session/prompt', {
      request: {
        sessionId,
        mode: 'queue',
        requestId: randomUUID(),
        content: [{ type: 'text', text }],
      },
    });
  }

  async projections(sessionId) {
    const value = await this.rpc('session/projections', { request: { sessionId } });
    // DSH 0.2.x 的形状：{ asOfSeq, values: {...} }；旧版可能直接给 values
    return value?.values ?? value ?? {};
  }

  async turnOutline(sessionId) {
    const values = await this.projections(sessionId);
    return Array.isArray(values.turnOutline) ? values.turnOutline : [];
  }

  /**
   * 发一条消息并等到这一轮结束。
   * @returns {{reply:string, ms:number, turn:number, baseline:number}}
   */
  async ask(sessionId, text, { pollMs = 400, timeoutMs = 180000 } = {}) {
    const before = await this.turnOutline(sessionId);
    const baseline = before.length;

    await this.prompt(sessionId, text);

    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let outline;
      try {
        outline = await this.turnOutline(sessionId);
      } catch (error) {
        lastError = error; // 轮询期间的瞬时错误不致命，继续等
        continue;
      }
      if (outline.length > baseline) {
        const latest = outline[outline.length - 1];
        if (typeof latest.response === 'string' && latest.response.length > 0) {
          return { reply: latest.response, ms: Date.now() - startedAt, turn: latest.turn ?? baseline + 1, baseline };
        }
      }
    }
    throw new DshError(
      `等 DSH 回复超时（${Math.round(timeoutMs / 1000)} 秒）` + (lastError ? `，最后一次错误：${lastError.message}` : ''),
    );
  }
}
