# astrbot-dsh

[![ci](https://github.com/wwzswer/Astrbot-DSH/actions/workflows/ci.yml/badge.svg)](https://github.com/wwzswer/Astrbot-DSH/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**AstrBot 当 QQ 前端，DeepSeek Harness 当大脑。**

把 AstrBot 收到的 QQ 消息交给本机的 DSH agent 处理，再把回复发回 QQ。
DSH 那边的工具能力（读文件、跑命令、搜网页、读写仓库）就都变成了 QQ 上能用的能力。

```
QQ 用户
  │
  ▼
AstrBot（aiocqhttp 适配器）           ← 负责接入、收发、白名单、指令
  │  HTTP  POST /v1/chat
  ▼
dsh-shim（Node，零依赖，127.0.0.1:7824） ← 负责会话映射、串行化、轮换
  │  HTTP  /api/session/*
  ▼
DeepSeek Harness（127.0.0.1:19387）    ← 负责「想」：模型 + 工具 + 工作区
```

---

## 为什么是两个进程，而不是一个 AstrBot 插件搞定

1. **DSH 的协议在 Node 侧最省事。** 鉴权要读 `~/.dsh/.credentials.yaml` 并做 HMAC 铸造，
   会话与事件模型也是 Node 生态的形状；Python 里重写一遍等于维护两份实现。
2. **进程隔离。** DSH 挂了、模型超时了、某个会话卡住了——AstrBot 本体不受影响，
   插件还能降级回 AstrBot 自己的模型。
3. **可观测。** 一个 `curl http://127.0.0.1:7824/health` 就能分清是「QQ 那边的问题」
   还是「DSH 那边的问题」。

---

## 快速开始

### 0. 前置

| 需要 | 说明 |
| --- | --- |
| Node.js ≥ 20.10 | shim 用内置 `fetch`，**零依赖**，不用 `npm install` 任何包 |
| 一个能跑的 DeepSeek Harness | 桌面版默认监听 `127.0.0.1:19387`；老版本可能是 `3080` |
| AstrBot | 已配好 QQ 适配器（aiocqhttp 等），能正常收发消息 |

### 1. 体检

```bash
cd dsh-shim
node src/doctor.mjs --chat
```

它会逐项检查：Node 版本 → 凭据文件 → 鉴权 → RPC → agent preset →
（`--chat` 时）真的建一个会话让它说句话。全绿再往下走。

### 2. 起 shim

```bash
cd dsh-shim
cp config.example.json config.json     # 先按需改
SHIM_TOKEN=你的随机串 npm start
```

看到这几行就对了：

```
dsh-shim 已启动: http://127.0.0.1:7824
  DSH:    http://127.0.0.1:19387
  鉴权:   离线铸造 Cookie（~/.dsh/.credentials.yaml）
  令牌:   已开启（x-shim-token）
```

> 不想用环境变量就把 `token` 写进 `config.json`；**别留空**，留空等于同机任何进程都能驱动你的 agent。

### 3. 装插件

把 `astrbot-plugin/` 整个拷进 AstrBot 的插件目录：

```
AstrBot/data/plugins/dsh_bridge/
  main.py
  dsh_client.py
  metadata.yaml
  config.json          ← 从 config.json.example 复制，填 shim_url 和 token
```

重启 AstrBot，日志里应该有：

```
[dsh] shim=http://127.0.0.1:7824 触发模式=all
```

### 4. 说话

给机器人发一句「你好」，几秒后会收到 DSH 的回复（首次会新建 DSH 会话，稍慢）。

### 5. 自检

```
/dsh health      # shim / DSH / 活动会话
/dsh stats
/dsh reset       # 丢弃当前会话的上下文，下一条重建
```

---

## 配置

### shim（`dsh-shim/config.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `server.host` / `server.port` | `127.0.0.1` / `7824` | **只监听回环**，别改成 `0.0.0.0` |
| `server.token` | 空 | 建议必填；也可以用 `SHIM_TOKEN` |
| `dsh.baseUrl` | `http://127.0.0.1:19387` | 你的 DSH 地址 |
| `dsh.authToken` | 空 | 留空 = 用 `~/.dsh/.credentials.yaml` 离线铸造（推荐，DSH 重启也不失效） |
| `dsh.agentPreset` | 空 | 用哪个 preset 建会话，留空 = DSH 默认；可用 `standard` / `minimal` / 你自建的 |
| `dsh.cwd` | 空 | 会话工作目录，留空 = shim 的当前目录 |
| `session.maxTurns` | 40 | 同一会话聊满多少轮换新会话（DSH 上下文会越滚越长） |
| `session.idleMinutes` | 120 | 空闲多久回收 |
| `session.replyTimeoutMs` | 180000 | 等一轮回复的上限 |
| `memory.enabled` | false | 接 [long-memory](https://github.com/wwzswer/long-memory) sidecar 做长期记忆 |

环境变量覆盖：`DSH_BASE_URL` / `DSH_AUTH_TOKEN` / `DSH_HOME` / `SHIM_TOKEN` / `SHIM_PORT` / `MEMORY_URL` / `MEMORY_TOKEN`。

### 插件（`astrbot-plugin/config.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `shim_url` | `http://127.0.0.1:7824` | shim 地址 |
| `token` | 空 | 与 `server.token` 一致 |
| `reply_timeout_seconds` | 180 | 超过这么久没回就放弃 |
| `trigger.mode` | `all` | `all` 全部接管 / `whitelist` 只在白名单群 / `at` 只在 @ 时 |
| `trigger.groups` | `[]` | 白名单群号（`mode=whitelist` 时生效） |
| `trigger.require_at` | false | 是否必须 @ 机器人才接管 |
| `trigger.ignore_prefix` | `["/"]` | 以这些开头的消息不接管，留给 AstrBot 指令 |
| `fallback_on_error` | true | shim 挂了就把消息交回 AstrBot 自己的模型 |

---

## 设计取舍（看这一节能省你半天）

**为什么不用 AstrBot 的「自定义 OpenAI 兼容 provider」？**
那是最省事的接法，但 OpenAI 协议里没有会话标识——拿不到群号/QQ 号，就没法按人分会话、
按群分记忆。插件走事件钩子能拿到 `unified_msg_origin`，代价只是多写 100 行。

**为什么是轮询，不是 WebSocket？**
DSH 的 `turnOutline` 投影里每轮都带 `{prompt, response}`，轮次结束后就落在那儿。
轮询 400ms 拿到的是**完整**回复，代价是平均多半拍；换来的是整个桥接**零依赖**
（Node 内置 `fetch` 就够），部署时不用 `npm install`。协议细节见 [docs/protocol.md](docs/protocol.md)。

**为什么同一个会话的请求要串行？**
群里两个人同时说话，如果两条 prompt 并行塞进同一个 DSH 会话，它们会排队进同一段上下文，
回复就对不上号了。串行化是最省事也最正确的解法。

**为什么会话要轮换？**
DSH 的上下文随轮次线性增长，token 成本跟着涨。聊满 `maxTurns` 或空闲太久就换新会话，
跨会话的连续性交给长期记忆（可选）兜底。

---

## 已验证 / 未验证

诚实标注，免得你踩坑时以为是自己配错了。

| 项 | 状态 |
| --- | --- |
| DSH 鉴权（离线铸造 Cookie / launch token） | ✅ 在 DSH 0.2.x 上实测通过 |
| `session/create` → `session/prompt` → `turnOutline` 取回复 | ✅ 实测，单轮 ~2-3 秒 |
| 会话复用与多轮上下文（"我刚才说的数字"） | ✅ 实测 |
| shim 的 HTTP 路由、鉴权、串行化、轮换 | ✅ 16 个单测 |
| Python 客户端 → shim → DSH 全链路 | ✅ 实测 |
| 开启记忆后：shim 把每轮写入 long-memory 并回读 | ✅ 实测（2 轮后记忆库有 2 条） |
| **AstrBot 内部的钩子行为** | ⚠️ 未在真机 AstrBot 上验证（本仓库开发环境没装） |

最后一条的意思是：`filter.event_message_type` / `event.stop_event()` /
`event.plain_result()` 这套 API 是按 AstrBot 4.x 的公开接口写的，但作者没能在
真实 AstrBot 实例里跑过。如果钩子名字对不上，只需要改 `main.py` 里**一个装饰器**，
HTTP 协议和 shim 都不用动。欢迎提 PR 把这一格改成 ✅。

---

## 和 long-memory 一起用（可选）

想让机器人**跨 DSH 会话**记住人和事，就把长期记忆接上：

```bash
# 1. 另起一个记忆服务（另一个仓库：long-memory）
cd long-memory && LONGMEM_TOKEN=memtok node server.mjs

# 2. 起 shim 时挂上它
cd astrbot-dsh/dsh-shim
SHIM_TOKEN=dev MEMORY_URL=http://127.0.0.1:7823 MEMORY_TOKEN=memtok npm start
```

生效后每一轮会变成：

```
用户消息 → /v1/before 取上下文 → 拼进 prompt → DSH → /v1/after 回写
```

几个细节：

- 记忆块贴在**用户消息前面**，不是塞进 system prompt——DSH 会话有自己的 system，
  混进去会被 preset / AGENTS.md 覆盖掉。
- 回写用的是**用户原始输入**，不是带记忆块的整段，否则记忆会滚雪球。
- `sessionKey` 同时是记忆的命名空间：同一个会话 key = 同一份记忆。
- 记忆服务挂了只是"这轮没有记忆"，不影响回复。

---

## 排错

先看 [docs/troubleshooting.md](docs/troubleshooting.md)，覆盖了最常见的六种失败：
凭据读不到、401、429 一样的"卡住不回"、回复乱码、重复回复、群里串话。

---

## 安全与隐私

- shim **只监听 127.0.0.1**；插件也只连回环。
- **一定设 token**：同机的任何进程只要能访问 7824 端口，就能驱动你的 agent——
  而 DSH agent 是有工具权限的（能读写文件、跑命令）。这不是"聊天数据泄露"级别的问题。
- `dsh.authToken` 是**进程启动凭据**，代码里硬性拒绝把它发往非回环地址。
- 消息内容会进入 DSH 会话与模型上下文；如果开了 `memory`，还会落到本地记忆库。
  DSH 会把 token 用量记进它自己的账本，注意成本。

---

## 目录结构

```
astrbot-dsh/
├── dsh-shim/                 # Node 侧：DSH 客户端 + 会话池 + HTTP 服务（零依赖）
│   ├── src/
│   │   ├── dsh-client.mjs    # 鉴权 / RPC / 等待一轮回复
│   │   ├── sessions.mjs      # 会话池：串行化 + 轮换
│   │   ├── memory-client.mjs # 可选的长期记忆接入
│   │   └── doctor.mjs        # 体检
│   └── test/                 # 16 个离线单测（CI 里跑）
├── astrbot-plugin/           # Python 侧：AstrBot 插件（薄适配层）
└── docs/
    ├── protocol.md           # DSH 协议的实测记录（逆向笔记）
    └── troubleshooting.md
```

---

## 许可

MIT，见 [LICENSE](LICENSE)。

本项目与 DeepSeek、AstrBot 官方均无隶属关系；使用各自的软件请遵守各自的许可协议。
