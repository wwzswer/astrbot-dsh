# 排错

按「症状 → 先查什么 → 常见原因」组织。每条都对应本仓库里一个具体的失败路径。

---

## 1. `node src/doctor.mjs` 说「没有可用凭据」

```
✗ 没有可用凭据  先启动一次 DSH（会写入 .credentials.yaml），或在 config.json 里填 dsh.authToken
```

**先查**：文件到底存不存在。

```bash
# Windows
dir %USERPROFILE%\.dsh\.credentials.yaml
# Linux / macOS
ls -l ~/.dsh/.credentials.yaml
```

**常见原因**：

- DSH 根本没启动过（凭据是首次启动时写的）。
- DSH 跑在别的用户账号下 / 装成了服务，`DSH_HOME` 指向别处。
  → 在 `config.json` 里显式设 `dsh.dshHome`，或用环境变量 `DSH_HOME`。
- 文件里没有 `client-connection/browser-session` 这一段（版本差异）。
  → 改走 launch token：`dsh.authToken` 填上，注意 DSH 重启后要换。

---

## 2. 体检里 RPC 全挂，但凭据读到了

**先查**：地址对不对。DSH 桌面版不同版本用过 `19387` 和 `3080` 两个端口。

```bash
curl -s http://127.0.0.1:19387/health || curl -s http://127.0.0.1:3080/health
```

**常见原因**：

- 端口填错 → 改 `dsh.baseUrl`。
- DSH 没开 → 先开 DSH。
- 401 → 铸造的 Cookie 和这台 DSH 对不上（`DSH_HOME` 指到了另一份 `.dsh`）。
  代码会自动重试一次并清 Cookie；如果一直 401，就是密钥源错了。

---

## 3. 发消息后一直等，最后超时

```
等 DSH 回复超时（180 秒）
```

**先查**：DSH 界面里那个会话是不是还在转圈。shim 启动日志会打印 `新建 key -> session-…`，
拿这个 sessionId 去 DSH 里看。

**常见原因**：

| 原因 | 判断 | 处理 |
| --- | --- | --- |
| 模型/网络慢 | DSH 里能看到在生成 | 调大 `session.replyTimeoutMs` |
| 会话里卡了个待审批的工具调用 | DSH 里显示等待批准 | 在 DSH 里点掉；或换 `agentPreset: minimal`（工具少） |
| 任务本身要跑很久（跑测试/装依赖） | DSH 里有命令在跑 | 正常，把超时调大；或让它别在 QQ 里干重活 |
| 本轮报错、`turnOutline` 没更新 | DSH 里能看到错误 | 看 DSH 日志；这类轮次不会产生 response |

---

## 4. 回复是乱码 / 模型说「你这条消息是乱码」

**先查**：是不是 shell 传参的问题。

Windows 的 `curl -d '{"text":"中文"}'` 会按 GBK 编码送出去，服务端按 UTF-8 解就是乱码。
**用 curl 测中文基本必踩**。

```bash
# 换 Node/Python 测，别用 curl 传中文
python astrbot-plugin/dsh_client.py http://127.0.0.1:7824 <token>
```

AstrBot 走的是 Python `json.dumps(ensure_ascii=False).encode('utf-8')`，不受影响。

---

## 5. 机器人回复了两遍（一条 DSH 的，一条 AstrBot 自己的）

说明插件**没有拦住** AstrBot 的默认 LLM 流程。

**常见原因**：

- `event.stop_event()` 没生效（版本差异），或调用位置在 `yield` 之后。
  → 确认 `stop_event()` 在 `yield event.plain_result(...)` **之前**调用（本项目就是这么写的）。
- 触发了 AstrBot 的「唤醒词」二次回复。
  → 在 AstrBot 的配置里关掉默认 LLM 的启用，或把唤醒条件收紧。

**兜底方案**：如果怎么调都拦不住，改用 AstrBot 的「自定义 OpenAI 兼容 provider」路线——
但那样拿不到群号/QQ 号，只能全体共用一个 DSH 会话（见 README「设计取舍」）。

---

## 6. 群里串话（A 的话被当成 B 的上下文）

**先查**：`/dsh stats` 看会话数量。

正常情况下每个会话 key 一个 DSH 会话。如果只有一个，说明 `_session_key` 退化成了固定值
（`unified_msg_origin` 取不到时的兜底分支）。

**常见原因**：

- AstrBot 版本里没有 `unified_msg_origin` → 兜底用 `platform:session:sender`，
  群聊时每个发言人是不同 key（这其实更符合"按人记"），但如果你想要"整个群共用一个大脑"，
  把 `_session_key` 改成只用 `platform:session`。

两种都合理，取决于你想要「按人记」还是「按群记」。

---

## 7. 插件加载报 `ModuleNotFoundError`

- `astrbot.api.event` / `astrbot.api.star` 找不到 → AstrBot 版本太旧，或插件目录放错层级
  （要放在 `data/plugins/<插件名>/` 下，`metadata.yaml` 和 `main.py` 同级）。
- `dsh_client` 找不到 → `dsh_client.py` 没一起拷过去。

---

## 8. 成本涨得很快

DSH 每轮都会把整个上下文（含工具定义）发一遍。一个 `standard` preset 的
system+tools 大约 2.6 万 token（本项目实测），聊得越多越贵。

**处理**：

- `session.maxTurns` 调小（比如 15），靠长期记忆保持连续性；
- `dsh.agentPreset` 用 `minimal`（工具少，上下文小很多）；
- 在 DSH 里看这个会话的 `tokenUsage` 投影，确认是哪里涨的。
