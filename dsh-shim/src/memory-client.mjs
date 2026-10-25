/**
 * 可选的记忆接入：接上 long-memory sidecar（同仓 ../long-memory）之后，
 * 每轮对话前拿上下文、对话后回写，跨 DSH 会话的连续性就靠它兜住。
 *
 * 没接也不会影响主流程：所有失败都降级成「这轮没有记忆」。
 */
export class MemoryClient {
  constructor({ baseUrl, token = '', timeoutMs = 4000 } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token || '';
    this.timeoutMs = timeoutMs;
  }

  get enabled() {
    return Boolean(this.baseUrl);
  }

  async #post(path, payload) {
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers['x-memory-token'] = this.token;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`memory ${path} -> HTTP ${response.status}`);
    return response.json();
  }

  /** @returns {{promptBlock:string, usedIds:string[], rejectedIds:string[]}|null} */
  async before(ns, query) {
    if (!this.enabled) return null;
    try {
      const data = await this.#post('/v1/before', { ns, query });
      return {
        promptBlock: data?.promptBlock ?? '',
        usedIds: Array.isArray(data?.usedIds) ? data.usedIds : [],
        rejectedIds: Array.isArray(data?.rejectedIds) ? data.rejectedIds : [],
      };
    } catch {
      return null;
    }
  }

  async after(ns, userText, reply, usedIds = [], rejectedIds = []) {
    if (!this.enabled) return null;
    try {
      return await this.#post('/v1/after', { ns, userText, reply, usedIds, rejectedIds });
    } catch {
      return null;
    }
  }
}
