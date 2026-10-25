/**
 * 会话池：把「聊天窗口」映射到「DSH 会话」。
 *
 * 两个必须做对的地方：
 *   1. **同一个 key 的请求串行**。QQ 群里两个人同时说话，如果并行发同一个 DSH 会话，
 *      两条 prompt 会排队进同一个上下文，回复对不上号。串行化是最省事的正确解。
 *   2. **会话要轮换**。DSH 的上下文会越滚越长（token 线性涨），聊够 maxTurns 轮
 *      或空闲太久就换一个新会话；跨会话的连续性由 long-memory（可选）兜底。
 */
export class SessionPool {
  constructor({ client, config, logger = () => {} }) {
    this.client = client;
    this.config = config;
    this.logger = logger;
    this.sessions = new Map(); // key -> { sessionId, turns, lastUsedAt }
    this.chains = new Map(); // key -> Promise（串行队列）
    this.created = 0;
  }

  async #acquire(key) {
    const sessionConfig = this.config.session;
    const now = Date.now();
    const existing = this.sessions.get(key);

    if (existing) {
      const idleMs = now - existing.lastUsedAt;
      const tooOld = idleMs > sessionConfig.idleMinutes * 60000;
      const tooLong = existing.turns >= sessionConfig.maxTurns;
      if (!tooOld && !tooLong) return existing;

      this.logger(
        `[session] 轮换 ${key}：${tooLong ? `已满 ${existing.turns} 轮` : `空闲 ${Math.round(idleMs / 60000)} 分钟`}`,
      );
      this.sessions.delete(key);
    }

    const sessionId = await this.client.createSession({
      agentPreset: this.config.dsh.agentPreset || undefined,
      cwd: this.config.dsh.cwd || undefined,
    });
    const record = { sessionId, turns: 0, lastUsedAt: now };
    this.sessions.set(key, record);
    this.created += 1;
    this.logger(`[session] 新建 ${key} -> ${sessionId}`);
    return record;
  }

  /** 串行执行同一个 key 的任务 */
  #enqueue(key, task) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    // 队列只关心顺序，不关心成败；吞掉异常避免 unhandled rejection
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async ask(key, text) {
    return this.#enqueue(key, async () => {
      const record = await this.#acquire(key);
      try {
        const result = await this.client.ask(record.sessionId, text, {
          pollMs: this.config.session.pollMs,
          timeoutMs: this.config.session.replyTimeoutMs,
        });
        record.turns += 1;
        record.lastUsedAt = Date.now();
        return { ...result, sessionId: record.sessionId, turns: record.turns };
      } catch (error) {
        record.lastUsedAt = Date.now();
        throw error;
      }
    });
  }

  reset(key) {
    const existed = this.sessions.delete(key);
    return existed;
  }

  stats() {
    return {
      keys: this.sessions.size,
      created: this.created,
      sessions: [...this.sessions.entries()].map(([key, record]) => ({
        key,
        sessionId: record.sessionId,
        turns: record.turns,
        idleMs: Date.now() - record.lastUsedAt,
      })),
    };
  }
}
