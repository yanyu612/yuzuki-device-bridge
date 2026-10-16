package com.wenxu.cachitobridge;

/** Monotonic deadline: later pattern updates can shorten a command, never renew it. */
final class CommandWindow {
    private long deadline;

    synchronized long accept(long now, long timeoutMs, boolean startNew) {
        if (!BridgePolicy.validTimeout(timeoutMs)) throw new IllegalArgumentException("无效截止时间");
        if (!startNew && deadline <= now) throw new IllegalArgumentException("控制指令已过期，请重新发起");
        long requested = now + timeoutMs;
        deadline = startNew ? requested : Math.min(deadline, requested);
        return deadline;
    }

    synchronized long remaining(long now) { return Math.max(0, deadline - now); }
    synchronized void clear() { deadline = 0; }
}
