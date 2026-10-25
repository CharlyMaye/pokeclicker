/** Cancellation is idempotent; a canceled callback may still arrive and must be ignored. */
export type CancelScheduled = () => void;

/** Schedule once, asynchronously. Never invoke callback before schedule returns. */
export interface WakeScheduler {
    schedule(callback: () => void, delayMs: number): CancelScheduled;
}

/** Request one presentation frame, asynchronously and independently of simulation time. */
export interface FrameScheduler {
    request(callback: () => void): CancelScheduled;
}
