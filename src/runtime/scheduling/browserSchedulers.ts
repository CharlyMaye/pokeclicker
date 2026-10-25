import type { FrameScheduler, WakeScheduler } from '../../contracts/scheduling';

// Browser timer representation limit, not a gameplay setting.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export const browserWakeScheduler: WakeScheduler = {
    schedule(callback, delayMs) {
        if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_TIMEOUT_MS) {
            throw new Error('Wake delay exceeds the browser timer range');
        }
        const handle = globalThis.setTimeout(callback, delayMs);
        return () => globalThis.clearTimeout(handle);
    },
};

export const browserFrameScheduler: FrameScheduler = {
    request(callback) {
        const handle = globalThis.requestAnimationFrame(callback);
        return () => globalThis.cancelAnimationFrame(handle);
    },
};

export const browserMonotonicTime = (): number => globalThis.performance.now();
