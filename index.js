import {
  appendVirtualPhoneRolePrompt,
  buildRoleControlPrompt,
  classifyRoleControl,
  CONTINUOUS_ROLE_CONTROL_HARD_LIMIT_SECONDS,
  DEFAULT_ROLE_CONTROL_DURATION_SECONDS,
  MAX_ROLE_CONTROL_DURATION_SECONDS,
  MIN_ROLE_CONTROL_DURATION_SECONDS,
  normalizeRoleDurationMode,
  normalizeRoleDurationSeconds,
  resolveRoleDuration,
  rolePatternPower,
  shouldHandleVirtualPhoneRoleCall,
  stripRoleControlMarkers,
} from './role-control.mjs';
import { readPairing, savePairing, buildPowerRequest, requestBridge } from './bridge-client.mjs';

const MODULE_ID = 'yuzuki-device-bridge';
const LIVE_INTERVAL_MS = 120;
const PHONE_PATCH_INTERVAL_MS = 500;
const ROLE_PATTERN_INTERVAL_MS = 900;
const LAUNCHER_PEEK_PX = 26;
const ROLE_PROMPT_ID = `${MODULE_ID}-role-control`;
const UI_PLACEMENT_KEY = `${MODULE_ID}:ui-placement:v1`;
const DEFAULT_SETTINGS = Object.freeze({
  roleControlEnabled: false,
  roleControlMaxPower: 30,
  roleControlDurationMode: 'timed',
  roleControlDurationSeconds: DEFAULT_ROLE_CONTROL_DURATION_SECONDS,
});
const IGNORED_MESSAGE_TYPES = new Set(['first_message', 'command', 'extension', 'impersonate']);

const runtime = {
  mounted: false,
  open: false,
  root: null,
  button: null,
  panel: null,
  panelHeader: null,
  panelBody: null,
  minimizeButton: null,
  status: null,
  value: null,
  slider: null,
  permissionButton: null,
  pairingToken: null,
  transportMode: null,
  pairingHelp: null,
  helperCommandDeadline: null,
  bridgeMaxPower: 30,
  pairingChanging: false,
  messageGenerationEpoch: null,
  roleToggle: null,
  roleToggleState: null,
  roleFeedback: null,
  roleMaxSlider: null,
  roleMaxValue: null,
  roleModeValue: null,
  roleDurationMode: null,
  roleDurationSecondsWrap: null,
  roleDurationSeconds: null,
  roleDurationHint: null,
  lastQueuedAt: 0,
  trailingTimer: null,
  statusTimer: null,
  phonePatchTimer: null,
  rolePatternTimer: null,
  rolePatternStopTimer: null,
  rolePatternMode: 'stop',
  rolePatternGeneration: 0,
  rolePatternDeadline: 0,
  roleControlEpoch: 0,
  suppressLaunchClick: false,
  requestInFlight: false,
  queuedCommand: null,
  lastRoleMessageKey: null,
  phoneApiManager: null,
  phoneOriginalCallAI: null,
  phoneWrappedCallAI: null,
  abortControllers: new Set(),
  disposers: [],
};

function getContext() {
  const context = globalThis.SillyTavern?.getContext?.();
  if (!context) throw new Error(`[${MODULE_ID}] SillyTavern context is unavailable`);
  return context;
}

function getSettings() {
  const context = getContext();
  const root = context.extensionSettings ?? (context.extensionSettings = {});
  const current = root[MODULE_ID] ?? (root[MODULE_ID] = {});
  if (typeof current.roleControlEnabled !== 'boolean') {
    current.roleControlEnabled = DEFAULT_SETTINGS.roleControlEnabled;
  }
  const maxPower = Number(current.roleControlMaxPower);
  current.roleControlMaxPower = Number.isFinite(maxPower)
    ? Math.min(100, Math.max(2, Math.round(maxPower)))
    : DEFAULT_SETTINGS.roleControlMaxPower;
  current.roleControlDurationMode = normalizeRoleDurationMode(current.roleControlDurationMode);
  current.roleControlDurationSeconds = normalizeRoleDurationSeconds(current.roleControlDurationSeconds);
  return current;
}

function saveSettings() {
  getContext().saveSettingsDebounced?.();
}

function getEventContract() {
  const context = getContext();
  const eventTypes = context.eventTypes ?? context.event_types;
  if (!context.eventSource || !eventTypes?.MESSAGE_RECEIVED) return null;
  return { context, eventSource: context.eventSource, eventTypes };
}

function syncRolePrompt() {
  const context = getContext();
  if (typeof context.setExtensionPrompt !== 'function') return false;
  const settings = getSettings();
  const prompt = settings.roleControlEnabled
    ? buildRoleControlPrompt(settings.roleControlMaxPower, {
      mode: settings.roleControlDurationMode,
      seconds: settings.roleControlDurationSeconds,
    })
    : '';
  context.setExtensionPrompt(
    ROLE_PROMPT_ID,
    prompt,
    prompt ? 1 : -1,
    0,
    false,
    0,
  );
  return true;
}

function listen(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  runtime.disposers.push(() => target.removeEventListener(type, handler, options));
}

function visibleViewport() {
  const viewport = window.visualViewport;
  return viewport
    ? { x: viewport.offsetLeft, y: viewport.offsetTop, width: viewport.width, height: viewport.height }
    : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
}

function readUiPlacement() {
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_PLACEMENT_KEY) || '{}');
    return parsed?.version === 1 ? parsed : { version: 1 };
  } catch (_) {
    return { version: 1 };
  }
}

function writeUiPlacement(patch) {
  try {
    localStorage.setItem(UI_PLACEMENT_KEY, JSON.stringify({ ...readUiPlacement(), ...patch, version: 1 }));
  } catch (_) {}
}

function clampElementPosition(element, x, y, gap = 8) {
  const viewport = visibleViewport();
  const rect = element.getBoundingClientRect();
  const width = Math.min(rect.width || element.offsetWidth || 1, viewport.width - gap * 2);
  const height = Math.min(rect.height || element.offsetHeight || 1, viewport.height - gap * 2);
  return {
    x: Math.min(Math.max(Number(x) || viewport.x + gap, viewport.x + gap), viewport.x + viewport.width - width - gap),
    y: Math.min(Math.max(Number(y) || viewport.y + gap, viewport.y + gap), viewport.y + viewport.height - height - gap),
  };
}

function setElementPosition(element, x, y) {
  const next = clampElementPosition(element, x, y);
  element.style.left = `${Math.round(next.x)}px`;
  element.style.top = `${Math.round(next.y)}px`;
  element.style.right = 'auto';
  element.style.bottom = 'auto';
  return next;
}

function restoreElementPlacement(element, key, fallbackFx, fallbackFy) {
  const viewport = visibleViewport();
  const saved = readUiPlacement()[key];
  const fx = Number.isFinite(saved?.fx) ? Math.min(1, Math.max(0, saved.fx)) : fallbackFx;
  const fy = Number.isFinite(saved?.fy) ? Math.min(1, Math.max(0, saved.fy)) : fallbackFy;
  const rect = element.getBoundingClientRect();
  setElementPosition(
    element,
    viewport.x + Math.max(0, viewport.width - rect.width) * fx,
    viewport.y + Math.max(0, viewport.height - rect.height) * fy,
  );
}

function persistElementPlacement(element, key) {
  const viewport = visibleViewport();
  const rect = element.getBoundingClientRect();
  const availableX = Math.max(1, viewport.width - rect.width);
  const availableY = Math.max(1, viewport.height - rect.height);
  writeUiPlacement({
    [key]: {
      fx: Math.min(1, Math.max(0, (rect.left - viewport.x) / availableX)),
      fy: Math.min(1, Math.max(0, (rect.top - viewport.y) / availableY)),
    },
  });
}

function dockLauncher(side, y) {
  const viewport = visibleViewport();
  const rect = runtime.button.getBoundingClientRect();
  const normalizedSide = side === 'left' ? 'left' : 'right';
  const width = rect.width || runtime.button.offsetWidth || 38;
  const height = rect.height || runtime.button.offsetHeight || 58;
  const minY = viewport.y + 8;
  const maxY = viewport.y + viewport.height - height - 8;
  const nextY = Math.min(Math.max(Number(y) || minY, minY), Math.max(minY, maxY));
  const nextX = normalizedSide === 'left'
    ? viewport.x - (width - LAUNCHER_PEEK_PX)
    : viewport.x + viewport.width - LAUNCHER_PEEK_PX;
  runtime.button.style.left = `${Math.round(nextX)}px`;
  runtime.button.style.top = `${Math.round(nextY)}px`;
  runtime.button.style.right = 'auto';
  runtime.button.style.bottom = 'auto';
  runtime.button.dataset.side = normalizedSide;
}

function persistLauncherPlacement() {
  const viewport = visibleViewport();
  const rect = runtime.button.getBoundingClientRect();
  const availableY = Math.max(1, viewport.height - rect.height);
  writeUiPlacement({
    launcher: {
      side: runtime.button.dataset.side === 'left' ? 'left' : 'right',
      fy: Math.min(1, Math.max(0, (rect.top - viewport.y) / availableY)),
    },
  });
}

function restoreLauncherPlacement(fallbackSide = 'right', fallbackFy = 0.72) {
  const viewport = visibleViewport();
  const saved = readUiPlacement().launcher;
  const side = saved?.side === 'left' || saved?.side === 'right'
    ? saved.side
    : Number(saved?.fx) < 0.5 ? 'left' : fallbackSide;
  const fy = Number.isFinite(saved?.fy) ? Math.min(1, Math.max(0, saved.fy)) : fallbackFy;
  const rect = runtime.button.getBoundingClientRect();
  dockLauncher(side, viewport.y + Math.max(0, viewport.height - rect.height) * fy);
}

function bindDraggable(element, handle, placementKey, { launcher = false } = {}) {
  let gesture = null;
  listen(handle, 'pointerdown', (event) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (!launcher && event.target.closest('button, input, a')) return;
    const rect = element.getBoundingClientRect();
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      dragging: false,
    };
    handle.setPointerCapture?.(event.pointerId);
  });
  listen(handle, 'pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.dragging && Math.hypot(dx, dy) < 6) return;
    gesture.dragging = true;
    event.preventDefault();
    element.classList.add('is-dragging');
    setElementPosition(element, gesture.originX + dx, gesture.originY + dy);
  });
  const finish = (event, cancelled = false) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const wasDragging = gesture.dragging;
    try { handle.releasePointerCapture?.(event.pointerId); } catch (_) {}
    gesture = null;
    element.classList.remove('is-dragging');
    if (!cancelled && wasDragging) {
      if (launcher) {
        const viewport = visibleViewport();
        const rect = element.getBoundingClientRect();
        const side = rect.left + rect.width / 2 < viewport.x + viewport.width / 2 ? 'left' : 'right';
        dockLauncher(side, rect.top);
        persistLauncherPlacement();
      } else {
        persistElementPlacement(element, placementKey);
      }
      if (launcher) {
        runtime.suppressLaunchClick = true;
        setTimeout(() => { runtime.suppressLaunchClick = false; }, 0);
      }
    }
  };
  listen(handle, 'pointerup', (event) => finish(event));
  listen(handle, 'pointercancel', (event) => finish(event, true));
}

function setStatus(kind, text) {
  if (!runtime.status) return;
  runtime.status.dataset.state = kind;
  runtime.status.textContent = text;
}

function setRoleFeedback(kind, text) {
  if (!runtime.roleFeedback) return;
  runtime.roleFeedback.dataset.state = kind;
  runtime.roleFeedback.textContent = text;
}

function updateRoleToggleUi(enabled) {
  const isEnabled = Boolean(enabled);
  if (runtime.roleToggle) runtime.roleToggle.checked = isEnabled;
  if (runtime.roleToggleState) runtime.roleToggleState.textContent = isEnabled ? '已开启' : '已关闭';
  if (runtime.root) runtime.root.dataset.roleControl = isEnabled ? 'on' : 'off';
}

function updateRoleDurationUi(settings = getSettings()) {
  const mode = normalizeRoleDurationMode(settings.roleControlDurationMode);
  const seconds = normalizeRoleDurationSeconds(settings.roleControlDurationSeconds);
  if (runtime.roleDurationMode) runtime.roleDurationMode.value = mode;
  if (runtime.roleDurationSeconds) runtime.roleDurationSeconds.value = String(seconds);
  if (runtime.roleDurationSecondsWrap) runtime.roleDurationSecondsWrap.hidden = mode !== 'timed';
  if (runtime.roleDurationHint) {
    const hasNativeDeadline = readPairing().mode === 'helper' || typeof getNativeCachitoBridge()?.setCachitoSuctionPowerWithTimeout === 'function';
    runtime.roleDurationHint.textContent = mode === 'until-next'
      ? `持续到下一条有效角色指令、你的手动操作或立即停止；${hasNativeDeadline ? '手机侧' : '页面运行时'}最多 ${Math.round(CONTINUOUS_ROLE_CONTROL_HARD_LIMIT_SECONDS / 60)} 分钟后自动停。`
      : `控制指令到达后运行 ${seconds} 秒；范围 ${MIN_ROLE_CONTROL_DURATION_SECONDS}–${MAX_ROLE_CONTROL_DURATION_SECONDS} 秒。`;
  }
}

function roleDurationStatusText(settings = getSettings()) {
  return settings.roleControlDurationMode === 'until-next'
    ? '持续到下次指令'
    : `${settings.roleControlDurationSeconds} 秒`;
}

function stopActiveRolePattern(reason) {
  if (runtime.rolePatternMode === 'stop') return false;
  clearRolePattern();
  if (runtime.slider) runtime.slider.value = '0';
  updateValue(0);
  queuePower(0, `${reason} · 当前控制已停止`);
  return true;
}

async function bridgeFetch(path, options = {}) {
  const controller = new AbortController();
  runtime.abortControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 1800);
  try {
    return await requestBridge(path, { token: readPairing().token, signal: controller.signal, ...options });
  } finally {
    clearTimeout(timeout);
    runtime.abortControllers.delete(controller);
  }
}

function getNativeCachitoBridge() {
  const bridge = globalThis.SillyDroidAndroidHostBridge;
  if (!bridge || typeof bridge.getCachitoStatus !== 'function') return null;
  if (typeof bridge.setCachitoSuctionPower !== 'function' || typeof bridge.stopCachito !== 'function') return null;
  return bridge;
}

async function readBridgeStatus() {
  const nativeBridge = readPairing().mode === 'native' ? getNativeCachitoBridge() : null;
  if (readPairing().mode === 'native' && !nativeBridge) throw new Error('当前客户端没有旧版原生蓝牙接口，请切换到独立小助手');
  if (nativeBridge) {
    const raw = await Promise.resolve(nativeBridge.getCachitoStatus());
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  return bridgeFetch('/status');
}

async function sendBridgePower(power, deadline = 0) {
  const nativeBridge = readPairing().mode === 'native' ? getNativeCachitoBridge() : null;
  if (readPairing().mode === 'native' && !nativeBridge) throw new Error('当前客户端没有旧版原生蓝牙接口');
  if (nativeBridge) {
    let accepted;
    if (power < 2) {
      accepted = await Promise.resolve(nativeBridge.stopCachito());
    } else if (deadline > 0 && typeof nativeBridge.setCachitoSuctionPowerWithTimeout === 'function') {
      const remainingMs = Math.ceil(deadline - Date.now());
      accepted = remainingMs <= 0
        ? await Promise.resolve(nativeBridge.stopCachito())
        : await Promise.resolve(nativeBridge.setCachitoSuctionPowerWithTimeout(power, remainingMs));
    } else {
      accepted = await Promise.resolve(nativeBridge.setCachitoSuctionPower(power));
    }
    if (accepted !== true) throw new Error('Native bridge rejected the command');
    return;
  }
  const startNew = !deadline || runtime.helperCommandDeadline !== deadline;
  const request = buildPowerRequest(power, deadline, { startNew });
  await bridgeFetch(request.path, { method: 'POST', body: request.body });
  runtime.helperCommandDeadline = request.path === '/stop' ? null : deadline;
}

async function refreshStatus() {
  if (!runtime.open) return;
  try {
    const data = await readBridgeStatus();
    if (!data.nativeBridge && (data.apiVersion !== 2 || data.profileId !== 'cachito-id36')) throw new Error('设备桥版本或设备型号不兼容');
    runtime.permissionButton.hidden = true;
    if (data.nativeBridge && !data.permissionReady) {
      setStatus('warning', '需要允许“附近设备”，才能控制偷欢 Pro');
      runtime.permissionButton.textContent = '允许附近设备';
      runtime.permissionButton.hidden = false;
      return;
    }
    if (!data.bluetoothReady) {
      setStatus('warning', data.nativeBridge ? '蓝牙未开启' : 'Bridge 已找到，但蓝牙未就绪');
      if (data.nativeBridge) {
        runtime.permissionButton.textContent = '开启蓝牙';
        runtime.permissionButton.hidden = false;
      }
      return;
    }
    const settings = getSettings();
    runtime.bridgeMaxPower = Number.isInteger(data.maxPower) ? Math.min(100, Math.max(2, data.maxPower)) : 100;
    runtime.slider.max = String(runtime.bridgeMaxPower);
    if (data.transmitError) throw new Error(data.message || '蓝牙广播发送失败');
    const readyText = data.nativeBridge ? '旧版原生接口已就绪' : `设备桥已就绪 · ${data.device} · 桥接上限 ${data.maxPower}`;
    setStatus(
      'connected',
      settings.roleControlEnabled
        ? `${readyText} · 角色控制已开启 · ${roleDurationStatusText(settings)} · 上限 ${settings.roleControlMaxPower}`
        : `${readyText} · 手动可用 · 角色控制未开启`,
    );
    const power = Number.isInteger(data.power) ? data.power : 0;
    runtime.slider.value = String(power);
    updateValue(power);
  } catch (error) {
    runtime.permissionButton.hidden = true;
    setStatus('offline', error.message || '设备桥未连接');
  }
}

function updateValue(power) {
  if (!runtime.value || !runtime.slider) return;
  runtime.value.textContent = power < 2 ? '暂停' : String(power);
  runtime.slider.setAttribute('aria-valuetext', power < 2 ? '暂停' : `吮吸强度 ${power}`);
}

function updateRoleMode(mode = 'stop') {
  runtime.rolePatternMode = mode;
  if (!runtime.roleModeValue) return;
  runtime.roleModeValue.textContent = {
    steady: '稳定',
    wave: '波浪',
    pulse: '脉冲',
    stop: '停止',
  }[mode] || '停止';
}

function clearRolePattern() {
  runtime.helperCommandDeadline = null;
  runtime.rolePatternGeneration += 1;
  clearInterval(runtime.rolePatternTimer);
  clearTimeout(runtime.rolePatternStopTimer);
  runtime.rolePatternTimer = null;
  runtime.rolePatternStopTimer = null;
  runtime.rolePatternDeadline = 0;
  updateRoleMode('stop');
}

function enforceRoleDeadline() {
  if (
    runtime.rolePatternMode === 'stop'
    || !runtime.rolePatternDeadline
    || Date.now() < runtime.rolePatternDeadline
  ) return false;
  clearRolePattern();
  if (runtime.slider) runtime.slider.value = '0';
  updateValue(0);
  setRoleFeedback('warning', '页面恢复时发现控制已超时 · 已停止');
  queuePower(0, '控制已超时 · 页面恢复后安全停止');
  return true;
}

function queuePower(power, successText = null, deadline = 0) {
  if (runtime.pairingChanging && power >= 2) return;
  power = Math.min(power, runtime.bridgeMaxPower);
  runtime.queuedCommand = { power, successText, deadline };
  void pumpPowerQueue();
}

function runRoleCommand(command, sourceLabel) {
  if (!command) return;
  clearRolePattern();
  if (command.power < 2 || command.mode === 'stop') {
    if (runtime.slider) runtime.slider.value = '0';
    updateValue(0);
    setRoleFeedback('ready', `${sourceLabel}已发出停止指令`);
    queuePower(0, `${sourceLabel}已停止设备`);
    return;
  }

  const peak = Math.min(command.power, runtime.bridgeMaxPower);
  const mode = command.mode || 'steady';
  const settings = getSettings();
  const duration = resolveRoleDuration(
    settings.roleControlDurationMode,
    settings.roleControlDurationSeconds,
  );
  const modeLabel = { steady: '稳定', wave: '波浪', pulse: '脉冲' }[mode] || '稳定';
  const clampedNote = command.requestedPower !== peak ? `（已限制自 ${command.requestedPower}）` : '';
  const patternGeneration = runtime.rolePatternGeneration;
  let step = 0;
  const sendStep = () => {
    if (
      patternGeneration !== runtime.rolePatternGeneration
      || runtime.rolePatternMode !== mode
      || enforceRoleDeadline()
    ) return;
    const power = rolePatternPower(mode, peak, step);
    step += 1;
    if (runtime.slider) runtime.slider.value = String(power);
    updateValue(power);
    queuePower(
      power,
      `${sourceLabel}${modeLabel}控制 · 强度 ${power}/${peak}${clampedNote}`,
      runtime.rolePatternDeadline,
    );
  };

  updateRoleMode(mode);
  runtime.rolePatternDeadline = Date.now() + duration.stopAfterSeconds * 1000;
  setRoleFeedback(
    'active',
    duration.continuesUntilNext
      ? `${sourceLabel}已发出${modeLabel}指令 · 峰值 ${peak} · 持续到下次指令`
      : `${sourceLabel}已发出${modeLabel}指令 · 峰值 ${peak} · ${duration.configuredSeconds} 秒`,
  );
  sendStep();
  if (mode !== 'steady') runtime.rolePatternTimer = setInterval(sendStep, ROLE_PATTERN_INTERVAL_MS);
  runtime.rolePatternStopTimer = setTimeout(() => {
    if (patternGeneration !== runtime.rolePatternGeneration) return;
    clearRolePattern();
    if (runtime.slider) runtime.slider.value = '0';
    updateValue(0);
    const stopLabel = duration.continuesUntilNext
      ? `${Math.round(CONTINUOUS_ROLE_CONTROL_HARD_LIMIT_SECONDS / 60)} 分钟失联保护`
      : `${duration.configuredSeconds} 秒定时`;
    setRoleFeedback('warning', `${stopLabel}已触发 · 已停止`);
    queuePower(0, `${sourceLabel}${modeLabel} · ${stopLabel}停止`);
  }, duration.stopAfterSeconds * 1000);
}

async function pumpPowerQueue() {
  if (runtime.requestInFlight) return;
  runtime.requestInFlight = true;
  try {
    while (runtime.queuedCommand !== null) {
      const { power, successText, deadline } = runtime.queuedCommand;
      runtime.queuedCommand = null;
      try {
        await sendBridgePower(power, deadline);
        setStatus('connected', successText || (power < 2 ? '已停止' : `实时控制中 · 强度 ${power}`));
      } catch (error) {
        clearRolePattern();
        runtime.helperCommandDeadline = null;
        runtime.queuedCommand = null;
        if (runtime.slider) runtime.slider.value = '0';
        updateValue(0);
        setStatus('offline', error.message || '发送失败 · 检查设备桥是否开启');
      }
    }
  } finally {
    runtime.requestInFlight = false;
    if (runtime.queuedCommand !== null) void pumpPowerQueue();
  }
}

function setRoleControlEnabled(enabled, { stopDevice = true } = {}) {
  const settings = getSettings();
  const nextEnabled = Boolean(enabled);
  if (settings.roleControlEnabled !== nextEnabled) runtime.roleControlEpoch += 1;
  settings.roleControlEnabled = nextEnabled;
  saveSettings();
  syncRolePrompt();
  updateRoleToggleUi(settings.roleControlEnabled);
  if (stopDevice && !settings.roleControlEnabled) {
    clearRolePattern();
    if (runtime.slider) runtime.slider.value = '0';
    updateValue(0);
    setRoleFeedback('off', '角色控制未开启 · 剧情台词不会启动设备');
    queuePower(0, '已停止 · 角色控制已关闭');
  } else if (settings.roleControlEnabled) {
    installVirtualPhonePatch();
    setRoleFeedback('ready', '角色控制已开启 · 等待下一次角色回复');
    setStatus('connected', `角色控制已开启 · ${roleDurationStatusText(settings)} · 上限 ${settings.roleControlMaxPower}`);
  } else {
    setRoleFeedback('off', '角色控制未开启 · 剧情台词不会启动设备');
  }
}

async function onRoleMessageReceived(messageId, generationType) {
  const settings = getSettings();
  if (!settings.roleControlEnabled || IGNORED_MESSAGE_TYPES.has(String(generationType))) return;

  const context = getContext();
  const message = context.chat?.[Number(messageId)];
  if (runtime.messageGenerationEpoch !== null && runtime.messageGenerationEpoch !== runtime.roleControlEpoch) return;
  if (!message || message.is_user === true || message.is_system === true || typeof message.mes !== 'string') return;

  const messageKey = `${context.chatId ?? ''}:${messageId}:${message.mes}`;
  if (runtime.lastRoleMessageKey === messageKey) return;
  runtime.lastRoleMessageKey = messageKey;

  applyRoleControlText(message.mes, '角色');
}

function applyRoleControlText(text, sourceLabel = '角色') {
  const settings = getSettings();
  if (!settings.roleControlEnabled) return { kind: 'disabled', command: null };
  const control = classifyRoleControl(text, settings.roleControlMaxPower);
  if (control.kind === 'none') {
    setRoleFeedback('warning', `${sourceLabel}这次没有返回控制指令 · 保持当前状态`);
    return control;
  }
  if (control.kind === 'invalid') {
    clearRolePattern();
    if (runtime.slider) runtime.slider.value = '0';
    updateValue(0);
    setRoleFeedback('error', `${sourceLabel}指令格式错误 · 已安全停止`);
    queuePower(0, `${sourceLabel}指令格式错误 · 已安全停止`);
    return control;
  }
  runRoleCommand(control.command, sourceLabel);
  return control;
}

function restoreVirtualPhonePatch() {
  const manager = runtime.phoneApiManager;
  if (runtime.phoneWrappedCallAI) runtime.roleControlEpoch += 1;
  if (manager && manager.callAI === runtime.phoneWrappedCallAI && runtime.phoneOriginalCallAI) {
    manager.callAI = runtime.phoneOriginalCallAI;
  }
  runtime.phoneApiManager = null;
  runtime.phoneOriginalCallAI = null;
  runtime.phoneWrappedCallAI = null;
}

function installVirtualPhonePatch() {
  const manager = window.VirtualPhone?.apiManager;
  if (!manager || typeof manager.callAI !== 'function') return false;
  if (manager === runtime.phoneApiManager && manager.callAI === runtime.phoneWrappedCallAI) return true;

  restoreVirtualPhonePatch();
  const inherited = manager.callAI.__ycbOwner === MODULE_ID && typeof manager.callAI.__ycbOriginal === 'function'
    ? manager.callAI.__ycbOriginal
    : manager.callAI;
  const wrapped = async function virtualPhoneRoleControl(messages, options = {}) {
    const settings = getSettings();
    const shouldHandle = settings.roleControlEnabled && shouldHandleVirtualPhoneRoleCall(messages, options);
    const requestEpoch = runtime.roleControlEpoch;
    const requestMessages = shouldHandle
      ? appendVirtualPhoneRolePrompt(messages, settings.roleControlMaxPower, {
        mode: settings.roleControlDurationMode,
        seconds: settings.roleControlDurationSeconds,
      })
      : messages;
    if (shouldHandle) setRoleFeedback('waiting', '控制要求已注入 · 等待小手机角色回复');

    let result;
    try {
      result = await inherited.call(this, requestMessages, options);
    } catch (error) {
      if (
        shouldHandle
        && requestEpoch === runtime.roleControlEpoch
        && getSettings().roleControlEnabled
      ) applyRoleControlText('', '小手机角色');
      throw error;
    }

    if (!shouldHandle) return result;
    const summary = typeof result?.summary === 'string' ? result.summary : '';
    const visibleResult = summary
      ? { ...result, summary: stripRoleControlMarkers(summary) }
      : result;
    if (requestEpoch !== runtime.roleControlEpoch || !getSettings().roleControlEnabled) {
      return visibleResult;
    }
    if (!result?.success || !summary) {
      applyRoleControlText('', '小手机角色');
      return visibleResult;
    }

    applyRoleControlText(summary, '小手机角色');
    return visibleResult;
  };
  Object.defineProperties(wrapped, {
    __ycbOwner: { value: MODULE_ID },
    __ycbOriginal: { value: inherited },
  });
  manager.callAI = wrapped;
  runtime.phoneApiManager = manager;
  runtime.phoneOriginalCallAI = inherited;
  runtime.phoneWrappedCallAI = wrapped;
  return true;
}

function bindVirtualPhoneRoleControl() {
  installVirtualPhonePatch();
  runtime.phonePatchTimer = window.setInterval(installVirtualPhonePatch, PHONE_PATCH_INTERVAL_MS);
  runtime.disposers.push(() => {
    window.clearInterval(runtime.phonePatchTimer);
    runtime.phonePatchTimer = null;
    restoreVirtualPhonePatch();
  });
}

function bindRoleControl() {
  const contract = getEventContract();
  if (!contract || typeof contract.context.setExtensionPrompt !== 'function') return false;
  contract.eventSource.on(contract.eventTypes.MESSAGE_RECEIVED, onRoleMessageReceived);
  if (contract.eventTypes.GENERATION_STARTED) {
    const rememberGeneration = () => { runtime.messageGenerationEpoch = runtime.roleControlEpoch; };
    contract.eventSource.on(contract.eventTypes.GENERATION_STARTED, rememberGeneration);
    runtime.disposers.push(() => contract.eventSource.removeListener(contract.eventTypes.GENERATION_STARTED, rememberGeneration));
  }
  if (contract.eventTypes.CHAT_CHANGED) {
    const stopForChatChange = () => { runtime.roleControlEpoch += 1; stopNow(); };
    contract.eventSource.on(contract.eventTypes.CHAT_CHANGED, stopForChatChange);
    runtime.disposers.push(() => contract.eventSource.removeListener(contract.eventTypes.CHAT_CHANGED, stopForChatChange));
  }
  runtime.disposers.push(() => {
    contract.eventSource.removeListener(contract.eventTypes.MESSAGE_RECEIVED, onRoleMessageReceived);
  });
  syncRolePrompt();
  bindVirtualPhoneRoleControl();
  return true;
}

function scheduleLivePower(power) {
  const now = performance.now();
  const elapsed = now - runtime.lastQueuedAt;
  clearTimeout(runtime.trailingTimer);
  if (elapsed >= LIVE_INTERVAL_MS) {
    runtime.lastQueuedAt = now;
    queuePower(power);
    return;
  }
  runtime.trailingTimer = setTimeout(() => {
    runtime.lastQueuedAt = performance.now();
    queuePower(Number(runtime.slider.value));
  }, LIVE_INTERVAL_MS - elapsed);
}

function sendFinalPower() {
  clearTimeout(runtime.trailingTimer);
  runtime.trailingTimer = null;
  runtime.lastQueuedAt = performance.now();
  queuePower(Number(runtime.slider.value));
}

function stopNow() {
  clearTimeout(runtime.trailingTimer);
  runtime.trailingTimer = null;
  clearRolePattern();
  runtime.slider.value = '0';
  updateValue(0);
  setRoleControlEnabled(false, { stopDevice: false });
  queuePower(0, '已停止 · 角色控制已关闭');
}

function placePanel(side) {
  const viewport = visibleViewport();
  const rect = runtime.panel.getBoundingClientRect();
  const x = side === 'left'
    ? viewport.x + 8
    : viewport.x + viewport.width - rect.width - 8;
  setElementPosition(runtime.panel, x, rect.top);
  persistElementPlacement(runtime.panel, 'panel');
}

function resetUiPlacement() {
  try { localStorage.removeItem(UI_PLACEMENT_KEY); } catch (_) {}
  restoreLauncherPlacement('right', 0.72);
  restoreElementPlacement(runtime.panel, 'panel', 0.5, 0.12);
  persistLauncherPlacement();
  persistElementPlacement(runtime.panel, 'panel');
}

function reclampUi() {
  if (runtime.button) {
    const buttonRect = runtime.button.getBoundingClientRect();
    dockLauncher(runtime.button.dataset.side, buttonRect.top);
  }
  if (runtime.panel && runtime.open) {
    const panelRect = runtime.panel.getBoundingClientRect();
    setElementPosition(runtime.panel, panelRect.left, panelRect.top);
  }
}

function setPanelOpen(open) {
  runtime.open = open;
  runtime.root.classList.toggle('is-open', open);
  runtime.button.style.pointerEvents = open ? 'none' : 'auto';
  runtime.panel.setAttribute('aria-hidden', String(!open));
  runtime.panel.inert = !open;
  runtime.button.setAttribute('aria-expanded', String(open));
  if (open) {
    requestAnimationFrame(() => restoreElementPlacement(runtime.panel, 'panel', 0.5, 0.12));
    void refreshStatus();
    clearInterval(runtime.statusTimer);
    runtime.statusTimer = setInterval(refreshStatus, 5000);
  } else {
    clearInterval(runtime.statusTimer);
    runtime.statusTimer = null;
  }
}

function buildUi() {
  const styleLink = document.createElement('link');
  styleLink.id = 'yuzuki-cachito-style';
  styleLink.rel = 'stylesheet';
  styleLink.href = new URL('./style.css', import.meta.url).href;
  document.head.appendChild(styleLink);
  runtime.disposers.push(() => styleLink.remove());

  const root = document.createElement('div');
  root.id = 'yuzuki-cachito-root';
  root.dataset.extensionId = MODULE_ID;
  root.innerHTML = `
    <button class="ycb-launch" type="button" data-side="right" aria-expanded="false" aria-controls="ycb-panel"
      aria-label="从侧边打开柚月玩具控制，按住可上下拖动或换边" title="点按打开 · 按住拖动或换边">
      <span aria-hidden="true"></span>
    </button>
    <section id="ycb-panel" class="ycb-panel" role="region"
      aria-labelledby="ycb-title" aria-hidden="true">
      <header class="ycb-header">
        <div class="ycb-title-group">
          <p class="ycb-kicker">柚月小手机</p>
          <h2 id="ycb-title">设备联动</h2>
          <small>按住标题栏可拖动</small>
        </div>
        <div class="ycb-header-actions">
          <button class="ycb-minimize" type="button" data-ycb-close
            aria-label="收回屏幕侧边" title="收回屏幕侧边">⌄</button>
        </div>
      </header>
      <div class="ycb-panel-body">
        <div class="ycb-placement-actions" aria-label="面板位置">
          <span>面板位置</span>
          <button type="button" data-ycb-place="left">贴左</button>
          <button type="button" data-ycb-place="right">贴右</button>
          <button type="button" data-ycb-place="reset">重置</button>
        </div>
        <div class="ycb-status" data-state="checking" role="status">正在检查本机设备桥…</div>
        <button class="ycb-permission" type="button" hidden>允许附近设备</button>
        <details class="ycb-pairing" open>
          <summary>连接与配对</summary>
          <label for="ycb-transport">连接方式</label>
          <select id="ycb-transport">
            <option value="helper">独立安卓设备桥</option>
            <option value="native">已有定制宿主的原生接口</option>
          </select>
          <label for="ycb-pairing-token">设备桥配对密钥</label>
          <input id="ycb-pairing-token" type="password" autocomplete="off" autocapitalize="none"
            spellcheck="false" placeholder="粘贴小助手复制的密钥" maxlength="64">
          <button type="button" class="ycb-permission" data-ycb-pair>保存并检查连接</button>
          <p class="ycb-duration-hint" data-ycb-pairing-help></p>
          <p class="ycb-duration-hint">当前型号：Cachito · 偷欢 Pro AI版（ID 36）。其他型号暂未适配。</p>
        </details>
        <div class="ycb-control">
          <div class="ycb-control-row">
            <label for="ycb-power">吮吸强度</label>
            <output id="ycb-power-value" for="ycb-power">暂停</output>
          </div>
          <input id="ycb-power" type="range" min="0" max="100" step="1" value="0"
            aria-label="吮吸强度" aria-valuetext="暂停">
          <div class="ycb-scale"><span>暂停</span><span>100</span></div>
        </div>
        <div class="ycb-auto-control">
          <label class="ycb-auto-toggle" for="ycb-role-control">
            <span>
              <strong>角色自动控制</strong>
              <small>角色可选择稳定、波浪、脉冲或停止</small>
            </span>
            <span class="ycb-auto-switch-wrap">
              <input id="ycb-role-control" type="checkbox" role="switch">
              <span class="ycb-auto-switch-track" aria-hidden="true"></span>
              <output id="ycb-role-toggle-state" aria-live="polite">已关闭</output>
            </span>
          </label>
          <div id="ycb-role-feedback" class="ycb-role-feedback" data-state="off" role="status">角色控制未开启 · 剧情台词不会启动设备</div>
          <div class="ycb-role-mode-row">
            <span>当前节奏</span>
            <output id="ycb-role-mode-value">停止</output>
          </div>
          <div class="ycb-auto-max-row">
            <label for="ycb-role-max">自动控制上限</label>
            <output id="ycb-role-max-value" for="ycb-role-max">30</output>
          </div>
          <input id="ycb-role-max" type="range" min="2" max="100" step="1" value="30"
            aria-label="角色自动控制强度上限">
          <div class="ycb-duration-setting">
            <label for="ycb-role-duration-mode">持续方式</label>
            <select id="ycb-role-duration-mode" aria-describedby="ycb-role-duration-hint">
              <option value="timed">自定义秒数</option>
              <option value="until-next">持续到下次指令</option>
            </select>
          </div>
          <div class="ycb-duration-seconds" id="ycb-duration-seconds-wrap">
            <label for="ycb-role-duration-seconds">运行秒数</label>
            <span>
              <input id="ycb-role-duration-seconds" type="number"
                min="${MIN_ROLE_CONTROL_DURATION_SECONDS}" max="${MAX_ROLE_CONTROL_DURATION_SECONDS}"
                step="1" inputmode="numeric" value="${DEFAULT_ROLE_CONTROL_DURATION_SECONDS}">
              <span>秒</span>
            </span>
          </div>
          <p id="ycb-role-duration-hint" class="ycb-duration-hint"></p>
        </div>
        <button class="ycb-stop" type="button">立即停止</button>
        <p class="ycb-note">偷欢 Pro 的硬件通道只有吮吸；波浪与脉冲会通过安全地改变吮吸力度实现。持续时间可自定，也可保持到下一次有效改变。</p>
        <p class="ycb-privacy">配对密钥只保存在当前浏览器，不随酒馆设置同步。聊天仍走你原来的酒馆；设备桥只处理控制指令。已发送不代表玩具已回执。</p>
      </div>
    </section>`;

  document.documentElement.appendChild(root);
  runtime.root = root;
  runtime.button = root.querySelector('.ycb-launch');
  runtime.panel = root.querySelector('.ycb-panel');
  runtime.panelHeader = root.querySelector('.ycb-header');
  runtime.panelBody = root.querySelector('.ycb-panel-body');
  runtime.minimizeButton = root.querySelector('.ycb-minimize');
  runtime.status = root.querySelector('.ycb-status');
  runtime.value = root.querySelector('#ycb-power-value');
  runtime.slider = root.querySelector('#ycb-power');
  runtime.permissionButton = root.querySelector('.ycb-permission');
  runtime.pairingToken = root.querySelector('#ycb-pairing-token');
  runtime.transportMode = root.querySelector('#ycb-transport');
  runtime.pairingHelp = root.querySelector('[data-ycb-pairing-help]');
  const pairing = readPairing();
  runtime.pairingToken.value = pairing.token;
  runtime.transportMode.value = pairing.mode;
  runtime.pairingHelp.textContent = `在小助手里保存这个酒馆地址：${location.origin}；开启桥接，再复制密钥到这里。`;
  runtime.pairingToken.disabled = pairing.mode === 'native';
  listen(runtime.transportMode, 'change', () => {
    runtime.pairingToken.disabled = runtime.transportMode.value === 'native';
  });
  listen(root.querySelector('[data-ycb-pair]'), 'click', async () => {
    const button = root.querySelector('[data-ycb-pair]');
    button.disabled = true;
    runtime.pairingChanging = true;
    try {
      clearRolePattern();
      runtime.queuedCommand = null;
      setRoleControlEnabled(false, { stopDevice: false });
      while (runtime.requestInFlight) await new Promise((resolve) => setTimeout(resolve, 50));
      if (readPairing().token || readPairing().mode === 'native') {
        await sendBridgePower(0).catch(() => {});
      }
      savePairing(runtime.pairingToken.value, runtime.transportMode.value);
      runtime.helperCommandDeadline = null;
      updateRoleDurationUi();
      await refreshStatus();
    } catch (error) { setStatus('offline', error.message); }
    finally { runtime.pairingChanging = false; button.disabled = false; }
  });
  runtime.roleToggle = root.querySelector('#ycb-role-control');
  runtime.roleToggleState = root.querySelector('#ycb-role-toggle-state');
  runtime.roleFeedback = root.querySelector('#ycb-role-feedback');
  runtime.roleMaxSlider = root.querySelector('#ycb-role-max');
  runtime.roleMaxValue = root.querySelector('#ycb-role-max-value');
  runtime.roleModeValue = root.querySelector('#ycb-role-mode-value');
  runtime.roleDurationMode = root.querySelector('#ycb-role-duration-mode');
  runtime.roleDurationSecondsWrap = root.querySelector('#ycb-duration-seconds-wrap');
  runtime.roleDurationSeconds = root.querySelector('#ycb-role-duration-seconds');
  runtime.roleDurationHint = root.querySelector('#ycb-role-duration-hint');
  const settings = getSettings();
  updateRoleToggleUi(settings.roleControlEnabled);
  setRoleFeedback(
    settings.roleControlEnabled ? 'ready' : 'off',
    settings.roleControlEnabled
      ? '角色控制已开启 · 等待下一次角色回复'
      : '角色控制未开启 · 剧情台词不会启动设备',
  );
  runtime.roleMaxSlider.value = String(settings.roleControlMaxPower);
  runtime.roleMaxValue.textContent = String(settings.roleControlMaxPower);
  updateRoleDurationUi(settings);
  root.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483000;pointer-events:none;';
  runtime.button.style.cssText = 'position:absolute;z-index:1;pointer-events:auto;';
  runtime.panel.style.position = 'absolute';
  requestAnimationFrame(() => restoreLauncherPlacement('right', 0.72));

  bindDraggable(runtime.button, runtime.button, 'launcher', { launcher: true });
  bindDraggable(runtime.panel, runtime.panelHeader, 'panel');
  listen(runtime.button, 'click', () => {
    if (runtime.suppressLaunchClick) return;
    setPanelOpen(!runtime.open);
  });
  root.querySelectorAll('[data-ycb-close]').forEach((element) => {
    listen(element, 'click', () => setPanelOpen(false));
  });
  root.querySelectorAll('[data-ycb-place]').forEach((element) => {
    listen(element, 'click', () => {
      const action = element.dataset.ycbPlace;
      if (action === 'reset') resetUiPlacement();
      else placePanel(action);
    });
  });
  listen(runtime.slider, 'input', () => {
    clearRolePattern();
    const power = Number(runtime.slider.value);
    updateValue(power);
    scheduleLivePower(power);
  });
  listen(runtime.slider, 'change', sendFinalPower);
  listen(root.querySelector('.ycb-stop'), 'click', stopNow);
  listen(runtime.roleToggle, 'change', () => {
    setRoleControlEnabled(runtime.roleToggle.checked);
  });
  listen(runtime.roleMaxSlider, 'input', () => {
    const settings = getSettings();
    settings.roleControlMaxPower = Math.min(100, Math.max(2, Number(runtime.roleMaxSlider.value)));
    runtime.roleMaxValue.textContent = String(settings.roleControlMaxPower);
    saveSettings();
    if (settings.roleControlEnabled) {
      syncRolePrompt();
      if (!stopActiveRolePattern(`上限已改为 ${settings.roleControlMaxPower}`)) {
        setStatus('connected', `角色控制已开启 · ${roleDurationStatusText(settings)} · 上限 ${settings.roleControlMaxPower}`);
      }
    }
  });
  listen(runtime.roleDurationMode, 'change', () => {
    const settings = getSettings();
    settings.roleControlDurationMode = normalizeRoleDurationMode(runtime.roleDurationMode.value);
    saveSettings();
    updateRoleDurationUi(settings);
    if (settings.roleControlEnabled) {
      syncRolePrompt();
      if (!stopActiveRolePattern('持续方式已改变')) {
        setRoleFeedback('ready', '持续方式已保存 · 等待下一次角色回复');
      }
    }
  });
  listen(runtime.roleDurationSeconds, 'change', () => {
    const settings = getSettings();
    settings.roleControlDurationSeconds = normalizeRoleDurationSeconds(runtime.roleDurationSeconds.value);
    saveSettings();
    updateRoleDurationUi(settings);
    if (settings.roleControlEnabled) {
      syncRolePrompt();
      if (!stopActiveRolePattern(`持续时间已改为 ${settings.roleControlDurationSeconds} 秒`)) {
        setRoleFeedback('ready', `持续时间已保存为 ${settings.roleControlDurationSeconds} 秒`);
      }
    }
  });
  listen(runtime.permissionButton, 'click', () => {
    const bridge = getNativeCachitoBridge();
    if (!bridge || typeof bridge.requestCachitoPermissions !== 'function') return;
    bridge.requestCachitoPermissions();
    setStatus('checking', '等待手机授权…');
    setTimeout(() => void refreshStatus(), 1200);
  });
  listen(document, 'keydown', (event) => {
    if (event.key === 'Escape' && runtime.open) setPanelOpen(false);
  });
  listen(document, 'visibilitychange', () => {
    if (!document.hidden) enforceRoleDeadline();
  });
  listen(window, 'pageshow', enforceRoleDeadline);
  listen(window, 'focus', enforceRoleDeadline);
  listen(window, 'resize', reclampUi);
  if (window.visualViewport) listen(window.visualViewport, 'resize', reclampUi);
}

function mount() {
  if (runtime.mounted) return;
  getContext();
  const stale = document.getElementById('yuzuki-cachito-root');
  if (stale) stale.remove();
  buildUi();
  if (!bindRoleControl()) {
    runtime.roleToggle.disabled = true;
    runtime.roleMaxSlider.disabled = true;
    runtime.roleDurationMode.disabled = true;
    runtime.roleDurationSeconds.disabled = true;
    setStatus('offline', '当前酒馆版本缺少角色消息事件 · 仅可手动控制');
  }
  runtime.mounted = true;
}

function destroy({ stopDevice = true } = {}) {
  if (!runtime.mounted) return;
  runtime.roleControlEpoch += 1;
  clearTimeout(runtime.trailingTimer);
  clearInterval(runtime.statusTimer);
  clearRolePattern();
  runtime.trailingTimer = null;
  runtime.statusTimer = null;
  for (const controller of runtime.abortControllers) controller.abort();
  runtime.abortControllers.clear();
  if (stopDevice) {
    runtime.queuedCommand = { power: 0, successText: '已停止' };
    void pumpPowerQueue();
  }
  while (runtime.disposers.length) {
    try { runtime.disposers.pop()?.(); } catch (_) {}
  }
  runtime.root?.remove();
  runtime.root = null;
  runtime.button = null;
  runtime.panel = null;
  runtime.panelHeader = null;
  runtime.panelBody = null;
  runtime.minimizeButton = null;
  runtime.status = null;
  runtime.value = null;
  runtime.slider = null;
  runtime.permissionButton = null;
  runtime.roleToggle = null;
  runtime.roleToggleState = null;
  runtime.roleFeedback = null;
  runtime.roleMaxSlider = null;
  runtime.roleMaxValue = null;
  runtime.roleModeValue = null;
  runtime.roleDurationMode = null;
  runtime.roleDurationSecondsWrap = null;
  runtime.roleDurationSeconds = null;
  runtime.roleDurationHint = null;
  runtime.mounted = false;
  runtime.open = false;
  try {
    const context = getContext();
    context.setExtensionPrompt?.(ROLE_PROMPT_ID, '', -1, 0, false, 0);
  } catch (_) {}
}

export function onActivate() {
  queueMicrotask(() => {
    try { mount(); } catch (error) { console.error(`[${MODULE_ID}]`, error); }
  });
}

export function onDisable() {
  destroy();
}

export function onClean() {
  destroy();
}

export function onDelete() {
  destroy();
}
