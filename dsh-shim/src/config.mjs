/** 配置：默认值 + config.json 覆盖 + 环境变量覆盖（环境变量优先级最高） */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  server: {
    host: '127.0.0.1',
    port: 7824,
    /** 建议设一个；留空则只靠「只监听回环」这一层保护 */
    token: '',
  },
  dsh: {
    baseUrl: 'http://127.0.0.1:19387',
    /** 留空 = 用 ~/.dsh/.credentials.yaml 离线铸造 Cookie（推荐） */
    authToken: '',
    dshHome: '',
    /** 新建会话时用的 agent preset；留空 = DSH 默认（standard） */
    agentPreset: '',
    /** 会话工作目录；留空 = shim 进程的当前目录 */
    cwd: '',
    timeoutMs: 15000,
  },
  session: {
    /** 同一个会话最多聊多少轮就换一个新的（DSH 上下文会越来越长） */
    maxTurns: 40,
    /** 空闲多久回收会话 */
    idleMinutes: 120,
    /** 等一轮回复的上限 */
    replyTimeoutMs: 180000,
    /** 轮询间隔 */
    pollMs: 400,
  },
  memory: {
    /** 可选：接上 long-memory sidecar 后，每轮前后会自动读写记忆 */
    enabled: false,
    baseUrl: 'http://127.0.0.1:7823',
    token: '',
  },
};

export function mergeConfig(base, patch) {
  const out = structuredClone(base);
  if (!patch || typeof patch !== 'object') return out;
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeConfig(out[key] ?? {}, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig(file) {
  let patch = {};
  try {
    patch = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`配置文件 ${file} 读取失败：${error.message}`);
  }
  const config = mergeConfig(DEFAULT_CONFIG, patch);

  // 环境变量覆盖（容器部署时不落盘密钥）
  if (process.env.DSH_BASE_URL) config.dsh.baseUrl = process.env.DSH_BASE_URL;
  if (process.env.DSH_AUTH_TOKEN) config.dsh.authToken = process.env.DSH_AUTH_TOKEN;
  if (process.env.DSH_HOME) config.dsh.dshHome = process.env.DSH_HOME;
  if (process.env.SHIM_TOKEN) config.server.token = process.env.SHIM_TOKEN;
  if (process.env.SHIM_PORT) config.server.port = Number(process.env.SHIM_PORT);
  if (process.env.MEMORY_URL) {
    config.memory.enabled = true;
    config.memory.baseUrl = process.env.MEMORY_URL;
  }
  if (process.env.MEMORY_TOKEN) config.memory.token = process.env.MEMORY_TOKEN;
  return config;
}

export function resolveConfigPath(explicit) {
  return explicit || process.env.SHIM_CONFIG || path.resolve(process.cwd(), 'config.json');
}
