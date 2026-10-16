import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as roles from './role-control.mjs';
import * as client from './bridge-client.mjs';

// Exercise the real integration functions with a fake transport and no browser/Bluetooth.
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
  .replace(/export function /g, 'function ')
  .replaceAll('import.meta.url', JSON.stringify('file:///fixture/index.js'));

function fixture({ mode = 'helper' } = {}) {
  const requests = [];
  const callbacks = new Map();
  let timerId = 0;
  const context = {
    extensionSettings: {}, chatId: 'fixture-chat', chat: [],
    setExtensionPrompt() {}, saveSettingsDebounced() {},
    eventTypes: { MESSAGE_RECEIVED: 'message', GENERATION_STARTED: 'generation', CHAT_CHANGED: 'chat' },
    eventSource: { on: (event, fn) => callbacks.set(event, fn), removeListener: (event) => callbacks.delete(event) },
  };
  const sandbox = {
    ...roles, ...client, console, AbortController, Date, performance, queueMicrotask,
    setTimeout: () => ++timerId, clearTimeout() {}, setInterval: () => ++timerId, clearInterval() {},
    readPairing: () => ({ mode, token: 'a'.repeat(64) }),
    requestBridge: async (path, options) => { requests.push({ path, ...options }); return { ok: true }; },
    SillyTavern: { getContext: () => context },
    // This method must not be used when testing the independent helper path.
    SillyDroidAndroidHostBridge: {
      getCachitoStatus: () => { throw new Error('unexpected native fallback'); },
      setCachitoSuctionPower: () => { throw new Error('unexpected native fallback'); },
      stopCachito: () => true,
    },
  };
  sandbox.window = sandbox;
  const exported = '\nglobalThis.subject = { runtime, getSettings, sendBridgePower, installVirtualPhonePatch, setRoleControlEnabled, bindRoleControl, onRoleMessageReceived };';
  vm.runInNewContext(source + exported, sandbox);
  return { subject: sandbox.subject, sandbox, requests, context, callbacks };
}

test('helper mode never silently falls back to the old custom Android host', async () => {
  const f = fixture();
  const deadline = Date.now() + 10_000;
  await f.subject.sendBridgePower(20, deadline);
  await f.subject.sendBridgePower(10, deadline);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].body.startNew, true);
  assert.equal(f.requests[1].body.startNew, false);
  assert.equal(f.requests[1].body.profileId, 'cachito-id36');
});

test('an expired role command is sent as stop and cannot start a fresh active command', async () => {
  const f = fixture();
  await f.subject.sendBridgePower(20, Date.now() - 100);
  assert.equal(f.requests[0].path, '/stop');
  assert.equal(f.subject.runtime.helperCommandDeadline, null);
});

test('a late phone response after disabling control is cleaned without controlling hardware', async () => {
  const f = fixture();
  let finish;
  f.sandbox.VirtualPhone = { apiManager: { callAI: () => new Promise((resolve) => { finish = resolve; }) } };
  f.subject.getSettings().roleControlEnabled = true;
  f.subject.installVirtualPhonePatch();
  const messages = [
    { role: 'system', isPhoneMessage: true, content: '手机内对话' },
    { role: 'user', isPhoneMessage: true, content: '继续聊天' },
  ];
  const pending = f.sandbox.VirtualPhone.apiManager.callAI(messages, { appId: 'wechat' });
  f.subject.setRoleControlEnabled(false, { stopDevice: false });
  finish({ success: true, summary: '<!--yuzuki-toy:steady:20-->普通文字' });
  const result = await pending;
  assert.equal(result.summary, '普通文字');
  assert.equal(f.requests.length, 0);
});

test('disabling and re-enabling control cannot revive an old ordinary-tavern response', async () => {
  const f = fixture();
  f.subject.getSettings().roleControlEnabled = true;
  f.subject.bindRoleControl();
  f.callbacks.get('generation')();
  f.subject.setRoleControlEnabled(false, { stopDevice: false });
  f.subject.setRoleControlEnabled(true, { stopDevice: false });
  f.context.chat.push({ is_user: false, mes: '<!--yuzuki-toy:steady:20-->' });
  await f.subject.onRoleMessageReceived(0, 'normal');
  assert.equal(f.requests.length, 0);
});
