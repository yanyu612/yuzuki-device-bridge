import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendVirtualPhoneRolePrompt,
  buildRoleControlPrompt,
  classifyRoleControl,
  CONTINUOUS_ROLE_CONTROL_HARD_LIMIT_SECONDS,
  DEFAULT_ROLE_CONTROL_DURATION_SECONDS,
  MAX_ROLE_CONTROL_DURATION_SECONDS,
  MIN_ROLE_CONTROL_DURATION_SECONDS,
  normalizeRoleMaxPower,
  normalizeRoleDurationMode,
  normalizeRoleDurationSeconds,
  parseRoleControl,
  resolveRoleDuration,
  rolePatternPower,
  shouldHandleVirtualPhoneRoleCall,
  stripRoleControlMarkers,
} from './role-control.mjs';

test('parses the last valid hidden marker', () => {
  assert.deepEqual(parseRoleControl('a <!--yuzuki-toy:10--> b <!-- yuzuki-toy:37 -->', 50), {
    mode: 'steady',
    requestedPower: 37,
    power: 37,
  });
});

test('clamps model output to the user maximum', () => {
  assert.deepEqual(parseRoleControl('<!--yuzuki-toy:100-->', 40), {
    mode: 'steady',
    requestedPower: 100,
    power: 40,
  });
});

test('treats zero and one as stop and rejects malformed markers', () => {
  assert.equal(parseRoleControl('<!--yuzuki-toy:1-->', 40)?.mode, 'stop');
  assert.deepEqual(parseRoleControl('<!--yuzuki-toy:stop-->', 40), {
    mode: 'stop', requestedPower: 0, power: 0,
  });
  assert.equal(parseRoleControl('<!--yuzuki-toy:-1-->', 40), null);
  assert.equal(parseRoleControl('no marker', 40), null);
});

test('distinguishes absent, valid, and malformed control intent', () => {
  assert.deepEqual(classifyRoleControl('普通角色回复，没有控制标记', 40), {
    kind: 'none', command: null,
  });
  assert.deepEqual(classifyRoleControl('<!--yuzuki-toy:wave:70-->', 35), {
    kind: 'command',
    command: { mode: 'wave', requestedPower: 70, power: 35 },
  });
  assert.deepEqual(classifyRoleControl('<!--yuzuki-toy:wave:abc-->', 40), {
    kind: 'invalid', command: null,
  });
  assert.deepEqual(classifyRoleControl('<!--yuzuki-toy:steady:22-->\n<!--yuzuki-toy:broken-->', 40), {
    kind: 'invalid', command: null,
  });
});

test('normalizes maximum power and writes it into the prompt', () => {
  assert.equal(normalizeRoleMaxPower(999), 100);
  assert.equal(normalizeRoleMaxPower('oops'), 40);
  assert.match(buildRoleControlPrompt(35), /2 to 35/);
  assert.match(buildRoleControlPrompt(35), /wave/);
  assert.match(buildRoleControlPrompt(35), /first item of the raw response/i);
  assert.match(buildRoleControlPrompt(35), /60 seconds/);
  assert.equal(DEFAULT_ROLE_CONTROL_DURATION_SECONDS, 60);
});

test('normalizes configurable duration and resolves both duration modes', () => {
  assert.equal(normalizeRoleDurationMode('until-next'), 'until-next');
  assert.equal(normalizeRoleDurationMode('unknown'), 'timed');
  assert.equal(normalizeRoleDurationSeconds('91'), 91);
  assert.equal(normalizeRoleDurationSeconds(0), MIN_ROLE_CONTROL_DURATION_SECONDS);
  assert.equal(normalizeRoleDurationSeconds(99999), MAX_ROLE_CONTROL_DURATION_SECONDS);
  assert.equal(normalizeRoleDurationSeconds('oops'), DEFAULT_ROLE_CONTROL_DURATION_SECONDS);
  assert.deepEqual(resolveRoleDuration('timed', 91), {
    mode: 'timed', configuredSeconds: 91, stopAfterSeconds: 91, continuesUntilNext: false,
  });
  assert.deepEqual(resolveRoleDuration('until-next', 91), {
    mode: 'until-next',
    configuredSeconds: 91,
    stopAfterSeconds: CONTINUOUS_ROLE_CONTROL_HARD_LIMIT_SECONDS,
    continuesUntilNext: true,
  });
  assert.match(buildRoleControlPrompt(35, { mode: 'timed', seconds: 91 }), /91 seconds/);
  assert.match(
    buildRoleControlPrompt(35, { mode: 'until-next', seconds: 91 }),
    new RegExp(`${CONTINUOUS_ROLE_CONTROL_HARD_LIMIT_SECONDS}-second local safety limit`),
  );
});

test('parses rhythmic modes and generates bounded pattern steps', () => {
  assert.deepEqual(parseRoleControl('<!--yuzuki-toy:wave:80-->', 35), {
    mode: 'wave', requestedPower: 80, power: 35,
  });
  assert.deepEqual(parseRoleControl('<!--yuzuki-toy:pulse:24-->', 40), {
    mode: 'pulse', requestedPower: 24, power: 24,
  });
  assert.deepEqual([0, 1, 2, 3].map((step) => rolePatternPower('wave', 40, step)), [12, 25, 40, 25]);
  assert.deepEqual([0, 1, 2, 3].map((step) => rolePatternPower('pulse', 40, step)), [12, 40, 12, 40]);
});

test('recognizes only conversational virtual-phone calls', () => {
  const conversation = [
    { role: 'system', content: '角色设定', isPhoneMessage: true },
    { role: 'user', content: '陪我玩', isPhoneMessage: true },
  ];
  assert.equal(shouldHandleVirtualPhoneRoleCall(conversation, { appId: 'wechat' }), true);
  assert.equal(shouldHandleVirtualPhoneRoleCall(conversation, { appId: 'diary' }), false);
  assert.equal(shouldHandleVirtualPhoneRoleCall([
    { role: 'system', content: '电话设定', isPhoneMessage: true },
    { role: 'user', content: '判断 角色 是否接听 用户 的电话。', isPhoneMessage: true },
  ], { appId: 'phone_online' }), false);
  assert.equal(shouldHandleVirtualPhoneRoleCall([
    { role: 'system', content: 'translate tags' },
    { role: 'user', content: '一只猫' },
  ], { appId: 'wechat' }), false);
});

test('appends a cloned phone prompt and removes its marker from the visible reply', () => {
  const original = [
    { role: 'system', content: '角色设定', isPhoneMessage: true },
    { role: 'user', content: '陪我玩', isPhoneMessage: true },
  ];
  const injected = appendVirtualPhoneRolePrompt(original, 35, { mode: 'until-next', seconds: 91 });
  assert.equal(original.length, 2);
  assert.equal(injected.length, 3);
  assert.equal(injected.at(-1).role, 'user');
  assert.equal(injected.at(-1).content, '陪我玩');
  assert.match(injected.at(-2).content, /2 to 35/);
  assert.match(injected.at(-2).content, /next valid control command/);
  assert.equal(stripRoleControlMarkers('<!--yuzuki-toy:wave:22-->\n<wechat>好。</wechat>'), '<wechat>好。</wechat>');
  assert.equal(stripRoleControlMarkers('<wechat><!--yuzuki-toy:wave:22-->好。</wechat>'), '<wechat>好。</wechat>');
  assert.equal(stripRoleControlMarkers('好。\n<!--yuzuki-toy:wave:abc-->'), '好。');
  assert.notEqual(injected[0], original[0]);
  assert.deepEqual(original, [
    { role: 'system', content: '角色设定', isPhoneMessage: true },
    { role: 'user', content: '陪我玩', isPhoneMessage: true },
  ]);
});
