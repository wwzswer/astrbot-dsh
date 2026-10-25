#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.mjs';
import { loadConfig, resolveConfigPath } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = resolveConfigPath(process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'config.json'));
const config = loadConfig(configPath);

const { server } = createServer({ config, logger: (line) => console.log(line) });

server.listen(config.server.port, config.server.host, () => {
  console.log(`dsh-shim 已启动: http://${config.server.host}:${config.server.port}`);
  console.log(`  DSH:    ${config.dsh.baseUrl}`);
  console.log(`  鉴权:   ${config.dsh.authToken ? 'launch token' : '离线铸造 Cookie（~/.dsh/.credentials.yaml）'}`);
  console.log(`  令牌:   ${config.server.token ? '已开启（x-shim-token）' : '关闭（仅本机回环）'}`);
  console.log(`  记忆:   ${config.memory.enabled ? config.memory.baseUrl : '未启用'}`);
  console.log(`  会话:   最多 ${config.session.maxTurns} 轮 / 空闲 ${config.session.idleMinutes} 分钟回收`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
