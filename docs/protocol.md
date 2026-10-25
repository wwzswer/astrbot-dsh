# DSH 协议实测记录

> 这份文档是**踩出来的**，不是从官方文档抄的——DSH 目前没有公开的 HTTP API 文档。
> 版本基线：DSH 0.2.x（`agentPresets` 命名空间已是复数、`session/control` 的队列已并入 `projections`）。
> 换版本后如果有字段对不上，按本文末尾的「怎么重新摸」走一遍，十分钟就能搞定。

---

## 1. 鉴权

DSH 是本地 Web 服务，鉴权产物是一个 **Cookie**。两条路：

### 路线 A：离线铸造（推荐）

DSH 在 `~/.dsh/.credentials.yaml` 里持久化了一个「浏览器会话签名密钥」：

```yaml
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: <base64url，恒为 32 字节>
```

用它对下面这个 JSON 做 HMAC-SHA256：

```json
{ "version": 1, "authority": "127.0.0.1:19387", "issuedAt": 1739000000000, "expiresAt": 1739003600000 }
```

然后：

```
cookie 名   = "dsh-auth-" + base64url(sha256(authority))
cookie 值   = "v1." + base64url(payloadJson) + "." + base64url(hmacSha256(payloadJson, secret))
```

`authority` 就是 `host:port`——**端口不同 Cookie 就不同**，所以 DSH 换端口后旧 Cookie 自动失效，
不需要额外处理。

好处：纯本地计算，不联网、不依赖 DSH 进程状态、DSH 重启后照样能用。

> 只对回环地址成立：远程 DSH 用的是另一份密钥，拿本机密钥去签只会换回 401。

### 路线 B：launch token 交换

```
GET /?token=<launch token>   →   Set-Cookie: ...
```

launch token 是**进程启动凭据**（DSH 重启即失效），且协议要求放在 URL 查询串里，
一旦发往非回环地址就等于把凭据交给链路上的每一环。所以代码里硬性拒绝非回环目标。

---

## 2. RPC 信封

所有一元 RPC 都是 `POST /api/<path>`，path 由方法名的 `.` 换成 `/`：

```json
// 请求
{ "type": "client-request", "rpcId": "<uuid>", "method": "session/create",
  "payload": { "args": { "request": { ... } } } }

// 成功
{ "type": "server-response", "rpcId": "<同一个>", "result": { "ok": true, "value": { ... } } }

// 失败（注意：HTTP 状态码仍是 200）
{ "type": "server-response", "rpcId": "<同一个>",
  "result": { "ok": false, "error": { "code": "gateway/input-invalid", "message": "...", "details": {...} } } }
```

**参数包装**是这套协议最容易踩的地方——同一批 RPC 用了三种不同的包法：

| 方法 | `args` 形状 |
| --- | --- |
| `session/create`、`session/prompt`、`session/projections`、`session/cancel` | `{ "request": {...} }` |
| `session/list` | `{ "_request": {...} }` |
| `agentPresets/list` | `{}`（空） |

包错了不会告诉你「形状不对」，只会回 `gateway/input-invalid` + `field: "request"`，
所以只能试。本文的技巧部分见末尾。

---

## 3. 三个真正用得上的调用

### 建会话

```json
// POST /api/session/create
{ "args": { "request": { "agentPreset": "standard", "cwd": "D:\\work" } } }
→ { "ok": true, "value": { "sessionId": "session-…", "agentPreset": "standard" } }
```

`agentPreset` 和 `cwd` 都可省略（省略 = DSH 默认）。可用 preset 列表：
`POST /api/agentPresets/list`，`args: {}`。

### 发消息

```json
// POST /api/session/prompt
{ "args": { "request": {
    "sessionId": "session-…",
    "mode": "queue",
    "requestId": "<uuid，必填>",
    "content": [{ "type": "text", "text": "你好" }]
} } }
→ { "ok": true, "value": { "accepted": true } }
```

**这是异步的**：`accepted` 只代表收下了，不代表想完了。

### 取回复（关键发现）

```json
// POST /api/session/projections
{ "args": { "request": { "sessionId": "session-…" } } }
→ { "ok": true, "value": {
      "asOfSeq": 18,
      "values": {
        "turnOutline": [ { "turn": 1, "seq": 4, "prompt": "…", "response": "完整回复文本" } ],
        "sessionStats": { "turns": 1, "steps": 1, "llmMs": 5176, … },
        "tokenUsage": { … },
        "inbox": { "next-turn": [], "next-step": [] },
        …
      } } }
```

`turnOutline[].response` 就是**这一轮的完整助手回复**（不是流式片段，不用拼接）。

有了它就不需要 `remote.mux` 那条 WebSocket：记住发消息前的 `turnOutline.length`，
轮询到长度变大且最后一条 `response` 非空即可。

代价是平均多等半个轮询间隔（本项目用 400ms）；收益是**整个桥接零依赖**。

> `turnOutline` 之外还有 `title / goal / tokenUsage / contextPressure / inbox / todos / plan /
> sessionStats / contextTimeline` 等投影，做监控面板时很有用。
> 注意：**消息正文不在 projections 里**（没有 `messages` 键），只有 `turnOutline` 的 prompt/response。

---

## 4. 已知边界

- `session/page` 的 `request` 形状没能试出来（`sessionId`、`address`、`limit` 各种组合都被
  `gateway/input-invalid` 拒掉）。**不需要它**——`turnOutline` 已经够用，所以没有继续挖。
- 同一个会话**不要并行发 prompt**：它们会排队进同一段上下文，回复对不上号。
  本项目在 `sessions.mjs` 里按会话 key 串行化。
- 回复是轮次级的，拿不到逐 token 流。想要打字机效果得走 `remote.mux`，代价是引入 `ws` 依赖。

---

## 5. 换版本后怎么重新摸

1. **先看报错**。`gateway/input-invalid` 会带 `details.field`，告诉你哪个字段被拒了，
   逐字段加/减就能逼出真实 schema。
2. **用 projections 反推**。`session/projections` 返回的是全量投影，字段名变了这里最先看出来。
3. **看 DSH 自己的界面**。桌面版能做的操作，对应的 RPC 一定存在；在 DevTools 的
   Network 里看 `/api/*` 请求体，比猜快得多。
4. 摸出新形状欢迎提 PR 更新本文——这份文档的价值就在于它是**实测**的。
