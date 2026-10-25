import type { CombatSnapshot } from '../../contracts/combat-protocol';
import { validateConfiguration } from '../../contracts/configuration';
import type { Configuration } from '../../contracts/configuration-types';
import type { CancelScheduled, WakeScheduler } from '../../contracts/scheduling';
import { RouteCombatSimulation, AdvanceResult } from '../../simulation/combat/RouteCombatSimulation';
import type { RandomStep } from '../../simulation/combat/model';

export interface DirectCombatHostOptions {
    readonly sessionId: string;
    readonly configuration: Configuration;
    readonly scenario: unknown;
    readonly seed: number;
    /** A finite, nonnegative monotonic clock in milliseconds. It may contain fractions. */
    readonly now: () => number;
    readonly scheduler: WakeScheduler;
    readonly random?: RandomStep;
    /** Synchronous runtime notification; consume/acknowledge FIFO output independently of rendering. */
    readonly onOutputAvailable?: () => void;
}

interface PendingWake { cancel?: CancelScheduled; requesting: boolean; inline: boolean }

/** Owns one direct engine and a bounded, explicitly acknowledged output queue. */
export class DirectCombatHost {
    private readonly engine: RouteCombatSimulation;
    private readonly configuration: Configuration;
    private readonly now: () => number;
    private readonly scheduler: WakeScheduler;
    private readonly onOutputAvailable?: () => void;
    private readonly outputs: AdvanceResult[] = [];
    private snapshot: CombatSnapshot;
    private pending: PendingWake | null = null;
    private running = false;
    private disposed = false;
    private busy = false;
    private failure: Error | null = null;
    private previousClock = 0;
    private anchor = 0;
    private elapsedMs = 0;

    constructor(options: DirectCombatHostOptions) {
        this.configuration = validateConfiguration(options.configuration);
        this.now = options.now;
        this.scheduler = options.scheduler;
        this.onOutputAvailable = options.onOutputAvailable;
        this.engine = new RouteCombatSimulation(options.sessionId, this.configuration, options.scenario, options.seed, options.random);
        this.snapshot = this.engine.snapshot;
    }

    get latest(): CombatSnapshot {
        return this.snapshot;
    }
    get progress() {
        return this.engine.progress;
    }
    get fault(): Error | null {
        return this.failure;
    }
    get pendingOutput(): AdvanceResult | null {
        return this.outputs[0] ?? null;
    }
    get pendingOutputCount(): number {
        return this.outputs.length;
    }
    get sampledTimeMs(): number {
        return Math.floor(this.elapsedMs);
    }
    get state(): 'stopped' | 'running' | 'blocked' | 'faulted' | 'disposed' {
        if (this.disposed) {
            return 'disposed';
        }
        if (this.failure) {
            return 'faulted';
        }
        if (!this.running) {
            return 'stopped';
        }
        return this.full ? 'blocked' : 'running';
    }

    private get full(): boolean {
        return this.outputs.length >= this.configuration.simulation.maxPendingOutputs;
    }

    private requireUsable(): void {
        if (this.disposed) {
            throw new Error('Combat host is disposed');
        }
        if (this.failure) {
            throw this.failure;
        }
        if (this.busy) {
            throw new Error('Combat host calls cannot be reentered');
        }
    }

    private readClock(): number {
        const value = this.now();
        if (!Number.isFinite(value) || value < this.previousClock || value > Number.MAX_SAFE_INTEGER) {
            throw new Error('Combat clock must be finite, nonnegative and monotonic within the safe range');
        }
        this.previousClock = value;
        return value;
    }

    private sampleTime(): number {
        const value = this.readClock();
        const elapsed = this.elapsedMs + (value - this.anchor);
        if (!Number.isFinite(elapsed) || elapsed > Number.MAX_SAFE_INTEGER) {
            throw new Error('Active simulation time exceeds the safe range');
        }
        this.elapsedMs = elapsed;
        this.anchor = value;
        return Math.floor(elapsed);
    }

    /** Sample the active timeline for an input adapter, without rounding to a fixed step. */
    inputTimeMs(): number {
        this.requireUsable();
        if (!this.running) {
            return this.sampledTimeMs;
        }
        this.busy = true;
        try {
            return this.sampleTime();
        } catch (error) {
            this.fail(error);
            throw this.failure;
        } finally {
            this.busy = false;
        }
    }

    submit(command: unknown): void {
        this.requireUsable();
        this.engine.submit(command);
    }

    start(): void {
        this.requireUsable();
        if (this.running) {
            return;
        }
        this.busy = true;
        try {
            // Exclude explicitly stopped time; preserve prior active-time debt and fractions.
            this.anchor = this.readClock();
            this.running = true;
            this.schedule();
        } catch (error) {
            this.fail(error);
            throw this.failure;
        } finally {
            this.busy = false;
        }
    }

    stop(): void {
        if (this.disposed || !this.running) {
            return;
        }
        this.requireUsable();
        this.busy = true;
        try {
            this.sampleTime();
            this.running = false;
            this.cancelPending();
        } catch (error) {
            this.fail(error);
            throw this.failure;
        } finally {
            this.busy = false;
        }
    }

    /** Acknowledge only the oldest delivered batch; snapshots alone do not acknowledge events. */
    acknowledge(snapshotSequence: number): void {
        if (this.disposed) {
            throw new Error('Combat host is disposed');
        }
        if (this.busy) {
            throw new Error('Combat host calls cannot be reentered');
        }
        const output = this.outputs[0];
        if (!Number.isSafeInteger(snapshotSequence) || !output || output.snapshot.sequence !== snapshotSequence) {
            throw new Error('Acknowledgment must match the oldest pending snapshot sequence');
        }
        this.busy = true;
        try {
            this.outputs.shift();
            // A faulted host can release delivered output, but cannot resume simulation.
            if (!this.failure) {
                this.schedule();
            }
        } catch (error) {
            this.fail(error);
            throw this.failure;
        } finally {
            this.busy = false;
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        if (this.busy) {
            throw new Error('Combat host calls cannot be reentered');
        }
        this.running = false;
        this.disposed = true;
        try {
            this.cancelPending();
        } catch (error) {
            this.fail(error);
        }
        // Retain bounded unread output and the last snapshot for diagnostics/recovery.
    }

    private cancelPending(): void {
        const pending = this.pending;
        this.pending = null;
        pending?.cancel?.();
    }

    private fail(error: unknown): void {
        this.failure ??= error instanceof Error ? error : new Error('Unknown combat host failure');
        this.running = false;
        try {
            this.cancelPending();
        } catch { /* Keep the original diagnostic; late callbacks are already invalidated. */ }
    }

    private schedule(): void {
        if (!this.running || this.pending || this.full) {
            return;
        }
        const pending: PendingWake = { requesting: true, inline: false };
        this.pending = pending;
        pending.cancel = this.scheduler.schedule(() => {
            if (pending.requesting) {
                pending.inline = true; return;
            }
            if (this.pending !== pending || !this.running) {
                return;
            }
            this.pending = null;
            this.wake();
        }, this.configuration.simulation.stepMs);
        pending.requesting = false;
        if (pending.inline || typeof pending.cancel !== 'function') {
            throw new Error('Wake scheduler must return cancellation and invoke callbacks asynchronously');
        }
    }

    private wake(): void {
        this.busy = true;
        let published = false;
        try {
            const target = this.sampleTime();
            if (target - this.snapshot.atMs >= this.configuration.simulation.stepMs) {
                const output = this.engine.advanceTo(target);
                this.outputs.push(output);
                this.snapshot = output.snapshot;
                published = true;
            }
        } catch (error) {
            this.fail(error);
        } finally {
            this.busy = false;
        }
        if (this.failure) {
            return;
        }
        try {
            // Delivery follows commit. A failure here retains unread output, not a rollback of the world.
            if (published) {
                const notification: unknown = this.onOutputAvailable?.();
                if (notification && typeof (notification as PromiseLike<unknown>).then === 'function') {
                    // The callback is not awaited: prevent overlapping consumers and unhandled rejection.
                    Promise.resolve(notification).catch(() => {});
                    throw new Error('Output notification must be synchronous; acknowledge asynchronous delivery separately');
                }
            }
            this.busy = true;
            this.schedule();
        } catch (error) {
            this.fail(error);
        } finally {
            this.busy = false;
        }
    }
}
