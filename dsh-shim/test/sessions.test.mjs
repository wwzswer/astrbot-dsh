import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, mergeConfig, loadConfig } from '../src/config.mjs';
import { SessionPool } from '../src/sessions.mjs';

test('mergeConfig 深合并，不覆盖未提及的字段', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { dsh: { baseUrl: 'http://127.0.0.1:9999' } });
  assert.equal(merged.dsh.baseUrl, 'http://127.0.0.1:9999');
  assert.equal(merged.dsh.timeoutMs, DEFAULT_CONFIG.dsh.timeoutMs, '未提及的字段应保留默认');
  assert.equal(merged.server.port, DEFAULT_CONFIG.server.port);
});

test('mergeConfig 不改动基准对象', () => {
  const before = JSON.stringify(DEFAULT_CONFIG);
  mergeConfig(DEFAULT_CONFIG, { server: { port: 1 } });
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
});

test('loadConfig 文件不存在时安静地返回默认值', () => {
  const config = loadConfig('/definitely/not/a/real/config.json');
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.memory.enabled, false);
});

test('环境变量优先级高于配置文件', () => {
  process.env.SHIM_PORT = '7999';
  process.env.MEMORY_URL = 'http://127.0.0.1:7800';
  try {
    const config = loadConfig('/definitely/not/a/real/config.json');
    assert.equal(config.server.port, 7999);
    assert.equal(config.memory.enabled, true, '给了 MEMORY_URL 就该自动启用记忆');
    assert.equal(config.memory.baseUrl, 'http://127.0.0.1:7800');
  } finally {
    delete process.env.SHIM_PORT;
    delete process.env.MEMORY_URL;
  }
});

function fakeClient({ onAsk } = {}) {
  let created = 0;
  const calls = [];
  return {
    calls,
    get createdCount() {
      return created;
    },
    async createSession() {
      created += 1;
      return `session-${created}`;
    },
    async ask(sessionId, text) {
      calls.push({ sessionId, text });
      if (onAsk) await onAsk(text);
      return { reply: `re:${text}`, ms: 1, turn: 1, baseline: 0 };
    },
  };
}

function makePool({ client, maxTurns = 40 } = {}) {
  return new SessionPool({
    client,
    config: {
      session: { maxTurns, idleMinutes: 120, replyTimeoutMs: 1000, pollMs: 10 },
      dsh: { agentPreset: '', cwd: '' },
    },
  });
}

test('同一个会话的请求串行执行（不会互相插队）', async () => {
  const order = [];
  const client = fakeClient({
    onAsk: async (text) => {
      order.push(`start:${text}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end:${text}`);
    },
  });
  const pool = makePool({ client });

  const results = await Promise.all([pool.ask('k', 'A'), pool.ask('k', 'B'), pool.ask('k', 'C')]);
  assert.deepEqual(order, [
    'start:A',
    'end:A',
    'start:B',
    'end:B',
    'start:C',
    'end:C',
  ]);
  assert.equal(results.length, 3);
  assert.equal(client.createdCount, 1, '同一个 key 只应建一个会话');
});

test('不同会话互不阻塞', async () => {
  const client = fakeClient({ onAsk: () => new Promise((resolve) => setTimeout(resolve, 150)) });
  const pool = makePool({ client });
  const startedAt = Date.now();
  await Promise.all([pool.ask('a', '1'), pool.ask('b', '2')]);
  // 串行会是 300ms+；并行约 150ms。阈值放到 280 是为了让 CI 上慢一点的机器不误报。
  assert.ok(Date.now() - startedAt < 280, '两个不同 key 应该并行，不该串成 300ms');
  assert.equal(client.createdCount, 2);
});

test('聊满 maxTurns 轮后自动换新会话', async () => {
  const client = fakeClient();
  const pool = makePool({ client, maxTurns: 2 });
  const first = await pool.ask('k', '1');
  await pool.ask('k', '2');
  assert.equal(client.createdCount, 1);
  const third = await pool.ask('k', '3');
  assert.equal(client.createdCount, 2, '超过轮数上限应新建会话');
  assert.notEqual(third.sessionId, first.sessionId);
});

test('reset 之后下次会新建会话', async () => {
  const client = fakeClient();
  const pool = makePool({ client });
  await pool.ask('k', '1');
  assert.equal(pool.reset('k'), true);
  assert.equal(pool.reset('k'), false, '重复 reset 应返回 false');
  await pool.ask('k', '2');
  assert.equal(client.createdCount, 2);
});

test('ask 失败时不会卡住后续请求', async () => {
  let fail = true;
  const client = fakeClient({
    onAsk: async () => {
      if (fail) throw new Error('boom');
    },
  });
  const pool = makePool({ client });
  await assert.rejects(() => pool.ask('k', 'bad'), /boom/);
  fail = false;
  const ok = await pool.ask('k', 'good');
  assert.equal(ok.reply, 're:good');
});
