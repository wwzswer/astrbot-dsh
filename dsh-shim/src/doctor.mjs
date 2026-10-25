#!/usr/bin/env node
/**
 * 体检：装完先跑这个，比看报错猜原因快。
 *   node src/doctor.mjs [--chat]
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DshClient, readBrowserSessionSecret, resolveDshHome } from './dsh-client.mjs';
import { loadConfig, resolveConfigPath } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig(resolveConfigPath(process.argv[2] && !process.argv[2].startsWith('-') ? path.resolve(process.argv[2]) : path.join(here, '..', 'config.json')));

const ok = (label, extra = '') => console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`);
const bad = (label, extra = '') => console.log(`  ✗ ${label}${extra ? `  ${extra}` : ''}`);
const warn = (label, extra = '') => console.log(`  ! ${label}${extra ? `  ${extra}` : ''}`);

let failed = 0;
const fail = (label, extra) => {
  failed += 1;
  bad(label, extra);
};

console.log('dsh-shim 体检\n');

console.log('运行环境');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node ${process.versions.node}`);
else fail(`Node 版本过低：${process.versions.node}`, '需要 >= 20.10');
ok(`平台 ${os.platform()} ${os.arch()}`);

console.log('\nDSH 连接');
console.log(`  配置地址：${config.dsh.baseUrl}`);
const client = new DshClient({
  baseUrl: config.dsh.baseUrl,
  authToken: config.dsh.authToken,
  dshHome: config.dsh.dshHome,
  timeoutMs: 10000,
});

const secret = readBrowserSessionSecret(config.dsh.dshHome);
if (config.dsh.authToken) ok('使用 launch token 鉴权');
else if (secret) ok('找到签名密钥', path.join(resolveDshHome(config.dsh.dshHome), '.credentials.yaml'));
else fail('没有可用凭据', '先启动一次 DSH（会写入 .credentials.yaml），或在 config.json 里填 dsh.authToken');

try {
  const value = await client.rpc('session/list', { _request: {} });
  const items = value?.items ?? [];
  ok(`RPC 可用，已有 ${items.length} 个会话`);
} catch (error) {
  fail('RPC 调用失败', error?.message ?? String(error));
}

try {
  const presets = await client.rpc('agentPresets/list', {});
  const ids = (presets?.presets ?? []).map((p) => p.id);
  ok(`agent preset 可用：${ids.join(', ') || '（空）'}`);
  if (config.dsh.agentPreset && !ids.includes(config.dsh.agentPreset)) {
    warn(`配置的 preset "${config.dsh.agentPreset}" 不在列表里`, 'DSH 会退回默认 preset');
  }
} catch (error) {
  warn('读不到 agent preset 列表', error?.message ?? String(error));
}

console.log('\n记忆（可选）');
if (!config.memory.enabled) {
  warn('未启用', '想跨会话连续记忆就把 memory.enabled 设为 true');
} else {
  try {
    const response = await fetch(`${config.memory.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) ok(`long-memory sidecar 可用：${config.memory.baseUrl}`);
    else fail('long-memory 返回非 200', `HTTP ${response.status}`);
  } catch (error) {
    fail('连不上 long-memory', error?.message ?? String(error));
  }
}

if (process.argv.includes('--chat')) {
  console.log('\n端到端（会真的建一个 DSH 会话并让它说一句话）');
  try {
    const sessionId = await client.createSession({ agentPreset: config.dsh.agentPreset || undefined });
    ok(`创建会话 ${sessionId}`);
    const result = await client.ask(sessionId, '只回答两个字：在的', { timeoutMs: 90000 });
    ok(`收到回复（${result.ms}ms）：${JSON.stringify(result.reply).slice(0, 80)}`);
  } catch (error) {
    fail('端到端失败', error?.message ?? String(error));
  }
}

console.log('');
if (failed === 0) {
  console.log('结论：可以启动。接着跑 npm start，然后启动 AstrBot。');
  process.exit(0);
}
console.log(`结论：有 ${failed} 项没通过，先按上面的提示修，别急着启动。`);
process.exit(1);
