import type { CombatFrame } from '../../contracts/combat-progress';
import type { CombatCommand, CombatSnapshot, RouteReference } from '../../contracts/combat-protocol';
import type { FrameScheduler } from '../../contracts/scheduling';
import { CombatRenderer, PresentationLoop } from '../../client/combat/PresentationLoop';
import type { AdvanceResult } from '../../simulation/combat/RouteCombatSimulation';
import type { HostCheckpoint } from '../persistence/HostCheckpoint';
import type { StoredCheckpoint } from '../persistence/CheckpointStore';
import type { CombatInput } from '../worker/protocol';
import type { RendererKind } from './configuration';

export interface LabHost {
    readonly latest: CombatSnapshot | null;
    readonly latestFrame: CombatFrame | null;
    readonly pendingOutput: AdvanceResult | null;
    readonly fault: Error | null;
    readonly state: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    submit(input: CombatInput): Promise<CombatCommand>;
    acknowledge(sequence: number): Promise<void>;
    checkpoint(): Promise<HostCheckpoint>;
    dispose(): void;
}
export interface LabStore {
    read(): StoredCheckpoint | null;
    write(checkpoint: HostCheckpoint, expectedRevision: string | null): Promise<StoredCheckpoint>;
    recoverBackup(): Promise<StoredCheckpoint>;
}
export interface LabControllerOptions {
    readonly store: LabStore;
    readonly frames: FrameScheduler;
    readonly initialRenderer: RendererKind;
    readonly maxPendingOutputs: number;
    readonly newSessionId: () => string;
    readonly createHost: (sessionId: string, checkpoint: HostCheckpoint | undefined, output: () => void, fault: (error: Error) => void) => Promise<LabHost>;
    readonly createRenderer: (kind: RendererKind, sessionId: string) => CombatRenderer<CombatFrame>;
    readonly changed: () => void;
}

/** Owns RPC arbitration and session replacement; rendering never owns output acknowledgment. */
export class CombatLabController {
    private host: LabHost | null = null;
    private display: PresentationLoop<CombatFrame> | null = null;
    private revision: string | null = null;
    private sessionId = '';
    private working = false;
    private disposed = false;
    private visible = true;
    private pauseRequested = false;
    private outputRequested = false;
    private error: Error | null = null;
    private kind: RendererKind;

    constructor(private readonly options: LabControllerOptions) {
        if (!Number.isSafeInteger(options.maxPendingOutputs) || options.maxPendingOutputs <= 0) {
            throw new Error('Lab output budget must be a positive safe integer');
        }
        this.kind = options.initialRenderer;
    }

    get busy(): boolean {
        return this.working;
    }
    get rendererKind(): RendererKind {
        return this.kind;
    }
    get latest(): CombatSnapshot | null {
        return this.host?.latest ?? null;
    }
    get lastError(): Error | null {
        return this.error ?? this.host?.fault ?? this.display?.fault ?? null;
    }
    get state(): string {
        return this.disposed ? 'disposed' : this.host?.state ?? 'empty';
    }

    initialize(): Promise<void> {
        return this.run(async () => {
            if (this.host) {
                throw new Error('Lab session is already initialized');
            }
            await this.replace(this.options.store.read());
        });
    }
    start(): Promise<void> {
        return this.run(async () => {
            if (!this.visible) {
                throw new Error('Resume combat after returning to the page');
            }
            await this.requireHost().start();
        });
    }
    pause(): Promise<void> {
        return this.run(async () => {
            await this.requireHost().stop();
        });
    }
    attack(): Promise<void> {
        return this.run(async () => {
            await this.requireHost().submit({ type: 'ClickAttack' });
        });
    }
    changeRoute(destination: RouteReference): Promise<void> {
        return this.run(async () => {
            await this.requireHost().submit({ type: 'ChangeRoute', destination });
        });
    }
    save(): Promise<void> {
        return this.run(async () => {
            const checkpoint = await this.settle();
            const record = await this.options.store.write(checkpoint, this.revision);
            if (!this.disposed) {
                this.revision = record.revision;
            }
        });
    }
    load(): Promise<void> {
        return this.run(async () => {
            await this.stopForReplacement();
            const record = this.options.store.read();
            if (!record) {
                throw new Error('No saved checkpoint is available');
            }
            await this.replace(record);
        });
    }
    recover(): Promise<void> {
        return this.run(async () => {
            await this.stopForReplacement();
            await this.replace(await this.options.store.recoverBackup());
        });
    }
    switchRenderer(kind: RendererKind): Promise<void> {
        return this.run(async () => {
            if (!['dom', 'knockout'].includes(kind)) {
                throw new Error('Unknown renderer');
            }
            const next = this.createDisplay(this.requireHost(), this.sessionId, kind);
            this.display?.dispose(); this.display = next; this.kind = kind;
        });
    }

    setVisible(visible: boolean): void {
        if (this.disposed) {
            return;
        }
        this.visible = visible;
        if (!visible) {
            this.pauseRequested = true;
            this.display?.stop();
        } else {
            try {
                this.display?.start();
            } catch (error) {
                this.error = this.asError(error);
            }
        }
        this.pump(); this.notify();
    }
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.display?.dispose(); this.host?.dispose();
    }

    private notify(): void {
        if (!this.disposed) {
            try {
                this.options.changed();
            } catch (error) {
                this.error = this.asError(error); this.host?.dispose(); this.display?.stop();
            }
        }
    }
    private asError(error: unknown): Error {
        return error instanceof Error ? error : new Error('Unknown lab failure');
    }
    private requireHost(): LabHost {
        if (!this.host) {
            throw new Error('Initialize the lab before using combat');
        }
        if (this.host.fault) {
            throw this.host.fault;
        }
        return this.host;
    }
    private async run(operation: () => Promise<void>, background = false): Promise<void> {
        if (this.disposed) {
            throw new Error('Lab is disposed');
        }
        if (this.working) {
            throw new Error('Wait for the current operation');
        }
        this.working = true;
        if (!background) {
            this.error = null;
        }
        this.notify();
        try {
            await operation();
        } catch (error) {
            this.error = this.asError(error);
            if (background) {
                this.host?.dispose(); this.display?.stop();
            }
            throw error;
        } finally {
            this.working = false; this.notify(); this.pump();
        }
    }
    private pump(): void {
        if (this.disposed || this.working || !this.host || this.host.fault || this.host.state === 'disposed') {
            return;
        }
        if (this.pauseRequested) {
            this.pauseRequested = false;
            void this.run(async () => {
                await this.host?.stop();
            }, true).catch(() => {});
        } else if (this.outputRequested || this.host.pendingOutput) {
            this.outputRequested = false;
            void this.run(async () => {
                await this.drainVisible();
            }, true).catch(() => {
                this.host?.dispose(); this.display?.stop(); this.notify();
            });
        }
    }
    private async drainVisible(): Promise<void> {
        const host = this.requireHost();
        for (let count = 0; count < this.options.maxPendingOutputs && host.pendingOutput; count++) {
            // Prototype progression is already owned by the worker. No legacy reward bridge is active.
            await host.acknowledge(host.pendingOutput.snapshot.sequence);
            if (this.disposed) {
                throw new Error('Lab is disposed');
            }
        }
    }
    private async settle(): Promise<HostCheckpoint> {
        const host = this.requireHost();
        await host.stop();
        // Acknowledge replies precede the next posted batch. A checkpoint request provides a barrier.
        for (let attempt = 0; attempt <= this.options.maxPendingOutputs; attempt++) {
            await this.drainVisible();
            try {
                return await host.checkpoint();
            } catch (error) {
                if (!host.pendingOutput) {
                    throw error;
                }
            }
        }
        throw new Error('Stopped output did not settle within its configured bound');
    }
    private async stopForReplacement(): Promise<void> {
        if (this.host && !this.host.fault && this.host.state !== 'disposed') {
            await this.settle();
        }
    }
    private createDisplay(host: LabHost, sessionId: string, kind: RendererKind): PresentationLoop<CombatFrame> {
        const display = new PresentationLoop<CombatFrame>({ get latest() {
            return host.latestFrame;
        } }, this.options.frames, this.options.createRenderer(kind, sessionId));
        try {
            if (this.visible) {
                display.start();
            }
            return display;
        } catch (error) {
            display.dispose(); throw error;
        }
    }
    private async replace(record: StoredCheckpoint | null): Promise<void> {
        const sessionId = this.options.newSessionId();
        const candidate = await this.options.createHost(sessionId, record?.checkpoint, () => {
            if (this.sessionId === sessionId && !this.disposed) {
                this.outputRequested = true; this.pump();
            }
        }, error => {
            if (this.sessionId === sessionId && !this.disposed) {
                this.error = error; this.display?.stop(); this.notify();
            }
        });
        if (this.disposed) {
            candidate.dispose(); throw new Error('Lab is disposed');
        }
        let next: PresentationLoop<CombatFrame>;
        try {
            next = this.createDisplay(candidate, sessionId, this.kind);
        } catch (error) {
            candidate.dispose(); throw error;
        }
        this.display?.dispose(); this.host?.dispose();
        this.host = candidate; this.display = next; this.sessionId = sessionId;
        this.revision = record?.revision ?? null; this.outputRequested = false;
    }
}
