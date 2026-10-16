export const PROFILE_ID = 'cachito-id36';
export const BRIDGE_BASE = 'http://127.0.0.1:8765/v1';
const PAIRING_KEY = 'yuzuki-device-bridge:pairing:v1';

export function readPairing(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(PAIRING_KEY) || '{}');
    return { token: /^[a-f0-9]{64}$/i.test(value.token || '') ? value.token : '', mode: value.mode === 'native' ? 'native' : 'helper' };
  } catch { return { token: '', mode: 'helper' }; }
}

export function savePairing(token, mode = 'helper', storage = globalThis.localStorage) {
  const normalized = String(token || '').trim();
  if (normalized && !/^[a-f0-9]{64}$/i.test(normalized)) throw new Error('请完整粘贴小助手复制的 64 位配对密钥');
  const pairing = { token: normalized, mode: mode === 'native' ? 'native' : 'helper' };
  storage.setItem(PAIRING_KEY, JSON.stringify(pairing));
  return pairing;
}

export function buildPowerRequest(power, deadline = 0, { now = Date.now(), startNew = true } = {}) {
  if (!Number.isInteger(power) || power < 0 || power > 100) throw new Error('强度无效');
  const remaining = deadline > 0 ? Math.ceil(deadline - now) : 30_000;
  if (power < 2 || remaining <= 0) return { path: '/stop', body: null };
  if (!Number.isFinite(remaining)) throw new Error('截止时间无效');
  return { path: '/suction', body: { profileId: PROFILE_ID, power, timeoutMs: Math.min(1_800_000, remaining), startNew: Boolean(startNew) } };
}

export async function requestBridge(path, { token, signal, fetchImpl = globalThis.fetch, body, method = 'GET' } = {}) {
  if (!/^[a-f0-9]{64}$/i.test(token || '')) throw new Error('先打开设备桥，复制密钥并在这里保存配对');
  const headers = { Authorization: `Bearer ${token}` };
  if (body != null) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetchImpl(`${BRIDGE_BASE}${path}`, {
      method, headers, body: body == null ? undefined : JSON.stringify(body),
      signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('设备桥响应超时，请检查小助手是否运行');
    throw new Error('无法连接设备桥：请开启小助手，核对酒馆地址，并检查当前浏览器是否允许访问本机');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) throw new Error(payload.error || `设备桥请求失败（${response.status}）`);
  return payload;
}
