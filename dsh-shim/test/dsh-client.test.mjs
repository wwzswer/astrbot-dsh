import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac, createHash } from 'node:crypto';
import { DshClient, isLoopback, mintCookie, readBrowserSessionSecret, DshError } from '../src/dsh-client.mjs';

const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

test('isLoopback 只认真正的回环地址', () => {
  assert.equal(isLoopback('http://127.0.0.1:3080'), true);
  assert.equal(isLoopback('http://127.5.5.5:1'), true);
  assert.equal(isLoopback('http://localhost:3080'), true);
  assert.equal(isLoopback('http://[::1]:3080'), true);
  assert.equal(isLoopback('http://192.168.1.10:3080'), false);
  assert.equal(isLoopback('https://dsh.example.com'), false);
  assert.equal(isLoopback('not a url'), false);
});

test('铸造的 Cookie 绑定 authority，且签名可复算', () => {
  const secret = Buffer.alloc(32, 7);
  const cookie = mintCookie('http://127.0.0.1:19387', secret);
  const [name, value] = cookie.split('=');
  assert.ok(name.startsWith('dsh-auth-'));
  assert.equal(name, 'dsh-auth-' + b64url(createHash('sha256').update('127.0.0.1:19387').digest()));

  const [version, body, signature] = value.split('.');
  assert.equal(version, 'v1');
  assert.equal(signature, b64url(createHmac('sha256', secret).update(body).digest()));

  const payload = JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  assert.equal(payload.authority, '127.0.0.1:19387');
  assert.equal(payload.version, 1);
  assert.ok(payload.expiresAt > payload.issuedAt);
});

test('不同端口的 authority 生成不同 Cookie 名', () => {
  const secret = Buffer.alloc(32, 1);
  const a = mintCookie('http://127.0.0.1:19387', secret).split('=')[0];
  const b = mintCookie('http://127.0.0.1:3080', secret).split('=')[0];
  assert.notEqual(a, b);
});

test('从 .credentials.yaml 读密钥（正则解析，不依赖 yaml）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dshhome-'));
  try {
    const secret = Buffer.alloc(32, 42);
    await writeFile(
      path.join(home, '.credentials.yaml'),
      [
        'records:',
        '  client-connection/browser-session:',
        '    kind: grant',
        '    payload:',
        '      version: 1',
        `      secret: ${b64url(secret)}`,
        '  other/thing:',
        '    payload:',
        '      secret: unrelated-secret-should-not-be-picked',
        '',
      ].join('\n'),
    );
    const read = readBrowserSessionSecret(home);
    assert.ok(read);
    assert.equal(read.toString('base64'), secret.toString('base64'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('密钥文件缺失时返回 null（而不是抛错）', () => {
  assert.equal(readBrowserSessionSecret(path.join(os.tmpdir(), 'definitely-not-here-xyz')), null);
});

test('没有凭据时给出可操作的报错', async () => {
  const client = new DshClient({
    baseUrl: 'http://127.0.0.1:19387',
    dshHome: path.join(os.tmpdir(), 'no-dsh-home-xyz'),
    timeoutMs: 1000,
  });
  await assert.rejects(
    () => client.ensureAuth(),
    (error) => error instanceof DshError && /credentials\.yaml|authToken/.test(error.message),
  );
});

test('拒绝把 launch token 发往非回环地址', async () => {
  const client = new DshClient({
    baseUrl: 'http://10.0.0.5:19387',
    authToken: 'fake-token',
    timeoutMs: 1000,
  });
  await assert.rejects(
    () => client.ensureAuth(),
    (error) => error instanceof DshError && /非本机地址/.test(error.message),
  );
});
