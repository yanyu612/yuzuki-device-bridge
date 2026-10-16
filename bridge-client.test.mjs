import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPowerRequest, requestBridge, readPairing, savePairing } from './bridge-client.mjs';

const token = 'a'.repeat(64);
test('credentials stay in browser-local storage and malformed keys are rejected', () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) };
  assert.deepEqual(readPairing(storage), { token: '', mode: 'helper' });
  savePairing(token, 'helper', storage);
  assert.equal(readPairing(storage).token, token);
  assert.throws(() => savePairing('short', 'helper', storage));
});
test('expired commands become stop, patterns retain a bounded remaining deadline', () => {
  assert.equal(buildPowerRequest(20, 900, { now: 1000 }).path, '/stop');
  assert.equal(buildPowerRequest(0).path, '/stop');
  assert.equal(buildPowerRequest(20).body.timeoutMs, 30_000);
  assert.deepEqual(buildPowerRequest(20, 2000, { now: 1000, startNew: false }).body,
    { profileId: 'cachito-id36', power: 20, timeoutMs: 1000, startNew: false });
  assert.equal(buildPowerRequest(20, 9_000_000, { now: 0 }).body.timeoutMs, 1_800_000);
  assert.throws(() => buildPowerRequest(1000));
});
test('unpaired clients do not make a network request', async () => {
  let calls = 0;
  await assert.rejects(requestBridge('/status', { fetchImpl: () => { calls++; } }), /密钥/);
  assert.equal(calls, 0);
});
test('transport is fixed to loopback and never sends browser cookies', async () => {
  let received;
  const fetchImpl = async (url, options) => {
    received = { url, options };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await requestBridge('/suction', { token, method: 'POST', body: { power: 20 }, fetchImpl });
  assert.equal(received.url, 'http://127.0.0.1:8765/v1/suction');
  assert.equal(received.options.credentials, 'omit');
  assert.equal(received.options.redirect, 'error');
  assert.equal(received.options.headers.Authorization, `Bearer ${token}`);
});
test('auth and browser network failures remain actionable without echoing secrets', async () => {
  await assert.rejects(requestBridge('/status', { token, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: '重新配对' }) }) }), /重新配对/);
  await assert.rejects(requestBridge('/status', { token, fetchImpl: async () => { throw new TypeError('blocked'); } }), /本机/);
});
