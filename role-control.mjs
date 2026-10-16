const MARKER_PATTERN = /<!--\s*yuzuki-toy\s*:\s*(?:(steady|wave|pulse)\s*:\s*(\d{1,3})|(stop)|(\d{1,3}))\s*-->/gi;
const CONTROL_COMMENT_PATTERN = /<!--\s*yuzuki-toy\b[\s\S]*?-->/gi;
const CONTROL_INTENT_PATTERN = /<!--\s*yuzuki-toy\b/gi;
const PHONE_ROLE_APP_IDS = new Set(['wechat', 'phone_sms', 'phone_online']);
const ROLE_MODES = new Set(['steady', 'wave', 'pulse']);

export const DEFAULT_ROLE_CONTROL_DURATION_SECONDS = 60;
export const MIN_ROLE_CONTROL_DURATION_SECONDS = 1;
export const MAX_ROLE_CONTROL_DURATION_SECONDS = 1800;
export const CONTINUOUS_ROLE_CONTROL_HARD_LIMIT_SECONDS = 1800;

export function normalizeRoleDurationMode(value) {
  return value === 'until-next' ? 'until-next' : 'timed';
}

export function normalizeRoleDurationSeconds(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(
      MAX_ROLE_CONTROL_DURATION_SECONDS,
      Math.max(MIN_ROLE_CONTROL_DURATION_SECONDS, Math.round(numeric)),
    )
    : DEFAULT_ROLE_CONTROL_DURATION_SECONDS;
}

export function resolveRoleDuration(mode, seconds) {
  const normalizedMode = normalizeRoleDurationMode(mode);
  const configuredSeconds = normalizeRoleDurationSeconds(seconds);
  return {
    mode: normalizedMode,
    configuredSeconds,
    stopAfterSeconds: normalizedMode === 'until-next'
      ? CONTINUOUS_ROLE_CONTROL_HARD_LIMIT_SECONDS
      : configuredSeconds,
    continuesUntilNext: normalizedMode === 'until-next',
  };
}

export function normalizeRoleMaxPower(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(100, Math.max(2, Math.round(numeric))) : 40;
}

export function parseRoleControl(text, maxPower = 100) {
  if (typeof text !== 'string') return null;
  let match = null;
  let current;
  MARKER_PATTERN.lastIndex = 0;
  while ((current = MARKER_PATTERN.exec(text)) !== null) match = current;
  if (!match) return null;

  if (match[3] === 'stop') {
    return { mode: 'stop', requestedPower: 0, power: 0 };
  }

  const mode = ROLE_MODES.has(match[1]) ? match[1] : 'steady';
  const requestedPower = Math.min(100, Math.max(0, Number(match[2] ?? match[4])));
  const boundedPower = Math.min(requestedPower, normalizeRoleMaxPower(maxPower));
  return {
    mode: boundedPower < 2 ? 'stop' : mode,
    requestedPower,
    power: boundedPower < 2 ? 0 : boundedPower,
  };
}

export function classifyRoleControl(text, maxPower = 100) {
  if (typeof text !== 'string') return { kind: 'none', command: null };

  let lastIntentIndex = -1;
  let current;
  CONTROL_INTENT_PATTERN.lastIndex = 0;
  while ((current = CONTROL_INTENT_PATTERN.exec(text)) !== null) lastIntentIndex = current.index;
  if (lastIntentIndex < 0) return { kind: 'none', command: null };

  let lastComment = null;
  CONTROL_COMMENT_PATTERN.lastIndex = 0;
  while ((current = CONTROL_COMMENT_PATTERN.exec(text)) !== null) {
    if (current.index === lastIntentIndex) lastComment = current[0];
  }

  const command = lastComment ? parseRoleControl(lastComment, maxPower) : null;
  return command
    ? { kind: 'command', command }
    : { kind: 'invalid', command: null };
}

export function rolePatternPower(mode, peakPower, step) {
  const peak = Math.min(100, Math.max(2, Math.round(Number(peakPower) || 2)));
  const low = Math.max(2, Math.round(peak * 0.3));
  const middle = Math.max(low, Math.round(peak * 0.62));
  const index = Math.max(0, Math.floor(Number(step) || 0));
  if (mode === 'wave') return [low, middle, peak, middle][index % 4];
  if (mode === 'pulse') return [low, peak, low, peak][index % 4];
  return peak;
}

export function stripRoleControlMarkers(text) {
  if (typeof text !== 'string') return text;
  CONTROL_COMMENT_PATTERN.lastIndex = 0;
  return text.replace(CONTROL_COMMENT_PATTERN, '').trim();
}

export function shouldHandleVirtualPhoneRoleCall(messages, options = {}) {
  if (!Array.isArray(messages) || !PHONE_ROLE_APP_IDS.has(String(options?.appId || ''))) return false;
  const last = [...messages].reverse().find((message) => message?.role === 'user');
  if (!last || last.isPhoneMessage !== true || typeof last.content !== 'string') return false;
  const content = last.content.trim();
  if (!content || /^判断\s+.+\s+是否接听\s+.+\s+的电话[。.!！]?$/u.test(content)) return false;
  return messages.some((message) => message?.isPhoneMessage === true && message?.role === 'system');
}

export function appendVirtualPhoneRolePrompt(messages, maxPower = 40, durationOptions = {}) {
  const cloned = messages.map((message) => ({ ...message }));
  const prompt = {
    role: 'system',
    name: 'SYSTEM (柚月玩具)',
    content: buildRoleControlPrompt(maxPower, durationOptions),
    isPhoneMessage: true,
  };
  const lastUserIndex = cloned.findLastIndex((message) => message?.role === 'user');
  if (lastUserIndex < 0) return [...cloned, prompt];
  cloned.splice(lastUserIndex, 0, prompt);
  return cloned;
}

export function buildRoleControlPrompt(maxPower = 40, durationOptions = {}) {
  const safeMax = normalizeRoleMaxPower(maxPower);
  const duration = resolveRoleDuration(durationOptions.mode, durationOptions.seconds);
  const durationInstruction = duration.continuesUntilNext
    ? `A non-stop command remains active until the next valid control command or local manual change. While this page is running, a ${CONTINUOUS_ROLE_CONTROL_HARD_LIMIT_SECONDS}-second local safety limit also applies.`
    : `Every non-stop command runs locally for ${duration.configuredSeconds} seconds and remains clamped to the user maximum.`;
  return [
    '[Yuzuki local toy control]',
    `The first item of the raw response, before any XML tag, dialogue, or narration, MUST be exactly one hidden HTML comment chosen from: <!--yuzuki-toy:steady:NN-->, <!--yuzuki-toy:wave:NN-->, <!--yuzuki-toy:pulse:NN-->, or <!--yuzuki-toy:stop-->. NN is an integer from 2 to ${safeMax}.`,
    'Choose steady for a fixed level, wave for a smooth low-to-high rhythm, pulse for a more distinct alternating rhythm, and stop when control is not contextually appropriate.',
    durationInstruction,
    'Do not mention, quote, explain, or place the marker inside a code block. It will be removed locally before the reply is shown; continue with the app\'s required response format immediately after it.',
  ].join('\n');
}
