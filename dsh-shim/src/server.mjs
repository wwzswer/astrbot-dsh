/**
 * HTTP 服务：AstrBot 插件只认这几个路由。
 *
 *   GET  /health              存活 + DSH 连通性（不需要令牌）
 *   POST /v1/chat             { sessionKey, text } -> { reply, sessionId, ms, turns }
 *   POST /v1/reset            { sessionKey }      -> 丢弃该会话
 *   GET  /v1/stats            会话池概况
 */
import http from 'node:http';
import { DshClient } from './dsh-client.mjs';
import { SessionPool } from './sessions.mjs';
import { MemoryClient } from './memory-client.mjs';

const MAX_BODY = 256 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.statusCode = 400;
    throw error;
  }
}

function requireField(body, key) {
  const value = body?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error(`缺少字段 ${key}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

export function createServer({ config, logger = () => {} }) {
  const dsh = new DshClient({
    baseUrl: config.dsh.baseUrl,
    authToken: config.dsh.authToken,
    dshHome: config.dsh.dshHome,
    timeoutMs: config.dsh.timeoutMs,
  });
  const pool = new SessionPool({ client: dsh, config, logger });
  const memory = new MemoryClient({
    baseUrl: config.memory?.enabled ? config.memory.baseUrl : '',
    token: config.memory?.token ?? '',
  });

  async function handleChat(body) {
    const sessionKey = requireField(body, 'sessionKey');
    const text = requireField(body, 'text');

    let promptText = text;
    let usedIds = [];
    let rejectedIds = [];

    const memoryContext = await memory.before(sessionKey, text);
    if (memoryContext?.promptBlock) {
      // 记忆块贴在用户消息前面，而不是塞进 system：DSH 会话有自己的 system，
      // 混进去会被 AGENTS.md / preset 覆盖掉。
      promptText = `${memoryContext.promptBlock}\n\n---\n${text}`;
      usedIds = memoryContext.usedIds;
      rejectedIds = memoryContext.rejectedIds;
    }

    const result = await pool.ask(sessionKey, promptText);

    // 回写用**原始用户输入**，不要把带记忆块的整段存进去（否则记忆会滚雪球）
    if (memory.enabled) {
      void memory.after(sessionKey, text, result.reply, usedIds, rejectedIds);
    }

    return {
      ok: true,
      reply: result.reply,
      sessionId: result.sessionId,
      ms: result.ms,
      turns: result.turns,
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (url.pathname === '/health') {
        let dshOk = false;
        let detail = '';
        try {
          await dsh.rpc('session/list', { _request: {} });
          dshOk = true;
        } catch (error) {
          detail = error?.message ?? String(error);
        }
        sendJson(res, dshOk ? 200 : 503, {
          ok: dshOk,
          service: 'dsh-shim',
          dsh: { baseUrl: config.dsh.baseUrl, reachable: dshOk, detail },
          memory: { enabled: memory.enabled },
          sessions: pool.stats().keys,
        });
        return;
      }

      if (config.server.token) {
        const header = req.headers['x-shim-token'] ?? req.headers.authorization ?? '';
        if (String(header).replace(/^Bearer\s+/i, '') !== config.server.token) {
          sendJson(res, 401, { ok: false, error: '缺少或错误的 token' });
          return;
        }
      }

      if (route === 'POST /v1/chat') {
        const body = await readJson(req);
        sendJson(res, 200, await handleChat(body));
        return;
      }

      if (route === 'POST /v1/reset') {
        const body = await readJson(req);
        const sessionKey = requireField(body, 'sessionKey');
        sendJson(res, 200, { ok: true, reset: pool.reset(sessionKey) });
        return;
      }

      if (route === 'GET /v1/stats') {
        sendJson(res, 200, { ok: true, ...pool.stats() });
        return;
      }

      sendJson(res, 404, { ok: false, error: `未知路由 ${route}` });
    } catch (error) {
      const status = error?.statusCode ?? (error?.name === 'DshError' ? 502 : 500);
      if (status >= 500) logger(`[shim] ${route} 失败：${error?.stack ?? error}`);
      sendJson(res, status, { ok: false, error: String(error?.message ?? error) });
    }
  });

  return { server, pool, dsh, memory };
}
