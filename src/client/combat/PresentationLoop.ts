import type { CombatSnapshot } from '../../contracts/combat-protocol';
import type { CancelScheduled, FrameScheduler } from '../../contracts/scheduling';

export interface CombatSnapshotSource { readonly latest: CombatSnapshot | null }
export interface CombatRenderer {
    render(snapshot: CombatSnapshot): void;
    dispose(): void;
}

interface PendingFrame { cancel?: CancelScheduled; requesting: boolean; inline: boolean }

/** Reads snapshots at display cadence. It has no simulation or command dependency. */
export class PresentationLoop {
    private pending: PendingFrame | null = null;
    private running = false;
    private disposed = false;
    private failure: Error | null = null;
    private lifecycle = {};

    constructor(
        private readonly source: CombatSnapshotSource,
        private readonly frames: FrameScheduler,
        private readonly renderer: CombatRenderer
    ) {}

    get fault(): Error | null {
        return this.failure;
    }
    get state(): 'stopped' | 'running' | 'faulted' | 'disposed' {
        return this.disposed ? 'disposed' : this.failure ? 'faulted' : this.running ? 'running' : 'stopped';
    }

    start(): void {
        if (this.disposed) {
            throw new Error('Presentation loop is disposed');
        }
        if (this.failure) {
            throw this.failure;
        }
        if (this.running) {
            return;
        }
        this.lifecycle = {};
        this.running = true;
        try {
            this.schedule();
        } catch (error) {
            this.fail(error); throw this.failure;
        }
    }

    stop(): void {
        this.running = false;
        this.lifecycle = {};
        try {
            this.cancelPending();
        } catch (error) {
            this.fail(error);
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.stop();
        try {
            this.renderer.dispose();
        } catch (error) {
            this.fail(error);
        }
    }

    private cancelPending(): void {
        const pending = this.pending;
        this.pending = null;
        pending?.cancel?.();
    }

    private fail(error: unknown): void {
        this.failure ??= error instanceof Error ? error : new Error('Unknown presentation failure');
        this.running = false;
        try {
            this.cancelPending();
        } catch { /* Keep the original failure; late frames are already invalidated. */ }
    }

    private schedule(): void {
        if (!this.running || this.pending) {
            return;
        }
        const pending: PendingFrame = { requesting: true, inline: false };
        const lifecycle = this.lifecycle;
        this.pending = pending;
        pending.cancel = this.frames.request(() => {
            if (pending.requesting) {
                pending.inline = true; return;
            }
            if (this.pending !== pending || !this.running) {
                return;
            }
            this.pending = null;
            try {
                const snapshot = this.source.latest;
                if (this.lifecycle !== lifecycle || !this.running) {
                    return;
                }
                if (snapshot) {
                    this.renderer.render(snapshot);
                }
                if (this.lifecycle === lifecycle) {
                    this.schedule();
                }
            } catch (error) {
                this.fail(error);
            }
        });
        pending.requesting = false;
        if (pending.inline || typeof pending.cancel !== 'function') {
            throw new Error('Frame scheduler must return cancellation and invoke callbacks asynchronously');
        }
    }
}
