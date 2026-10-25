import { CombatCommand, CombatSnapshot, validateSessionId } from '../../contracts/combat-protocol';
import type { CancelScheduled, WakeScheduler } from '../../contracts/scheduling';
import type { AdvanceResult } from '../../simulation/combat/RouteCombatSimulation';
import { CombatInput, parseInput, parseResponse, parseSession, RequestPayload, WorkerResult, WorkerSession, WORKER_PROTOCOL_VERSION } from './protocol';
import type { CombatTransport } from './transport';

interface PendingRequest {
    readonly id: number;
    readonly payload: RequestPayload;
    readonly resolve: (result: WorkerResult) => void;
    readonly reject: (error: Error) => void;
    cancel?: CancelScheduled;
}

export interface WorkerCombatOptions {
    readonly sessionId: string;
    readonly session: WorkerSession;
    /** Required deployment policy; no hidden deadline or retry default. */
    readonly requestTimeoutMs: number;
    readonly deadlines: WakeScheduler;
    readonly transport: CombatTransport;
    readonly onOutputAvailable?: () => void;
}

/** Main-thread proxy and snapshot source. It owns no engine, rewards or simulation clock. */
export class WorkerCombatHost {
    private readonly sessionId: string;
    private readonly session: WorkerSession;
    private readonly detach: () => void;
    private pending: PendingRequest | null = null;
    private snapshot: CombatSnapshot | null = null;
    private output: AdvanceResult | null = null;
    private requestId = 0;
    private acceptedSequence = 0;
    private acceptedAtMs = 0;
    private eventSequence = 0;
    private eventAtMs = 0;
    private outcomeSequence = 0;
    private outcomeAtMs = 0;
    private failure: Error | null = null;
    private disconnected = false;
    private lifecycle: 'new' | 'stopped' | 'running' | 'disposed' = 'new';

    constructor(private readonly options: WorkerCombatOptions) {
        this.sessionId = validateSessionId(options.sessionId);
        this.session = parseSession(options.session);
        if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
            throw new Error('Worker requestTimeoutMs must be a positive safe integer');
        }
        this.detach = options.transport.listen(value => this.receive(value), error => this.fail(error));
    }

    get latest(): CombatSnapshot | null {
        return this.snapshot;
    }
    get pendingOutput(): AdvanceResult | null {
        return this.output;
    }
    get fault(): Error | null {
        return this.failure;
    }
    /** Running describes the requested lifecycle; output backpressure remains worker-owned. */
    get state() {
        return this.lifecycle === 'disposed' ? 'disposed' : this.failure ? 'faulted' : this.lifecycle;
    }

    async initialize(): Promise<void> {
        if (this.lifecycle !== 'new') {
            throw new Error('Worker proxy is already initialized');
        }
        await this.request({ type: 'initialize', session: this.session });
    }

    async start(): Promise<void> {
        await this.request({ type: 'start' });
    }
    async stop(): Promise<void> {
        await this.request({ type: 'stop' });
    }
    async submit(input: CombatInput): Promise<CombatCommand> {
        const result = await this.request({ type: 'input', input: parseInput(input) });
        if (result.type !== 'accepted') {
            throw new Error('Expected an accepted command');
        }
        return result.command;
    }
    async acknowledge(sequence: number): Promise<void> {
        if (!this.output || sequence !== this.output.snapshot.sequence) {
            throw new Error('Acknowledge the oldest delivered output');
        }
        await this.request({ type: 'acknowledge', sequence });
    }

    dispose(): void {
        if (this.lifecycle === 'disposed') {
            return;
        }
        this.lifecycle = 'disposed';
        this.shutdown(new Error('Worker proxy is disposed'));
    }

    private shutdown(error: Error): void {
        if (this.disconnected) {
            return;
        }
        this.disconnected = true;
        const pending = this.pending;
        this.pending = null;
        try {
            pending?.cancel?.();
        } catch { /* Preserve the original error. */ }
        pending?.reject(error);
        try {
            this.detach();
        } catch { /* Termination must still happen. */ }
        try {
            this.options.transport.close();
        } catch { /* Retain last received data for diagnosis. */ }
    }

    private fail(error: unknown): void {
        if (this.failure || this.lifecycle === 'disposed') {
            return;
        }
        this.failure = error instanceof Error ? error : new Error('Unknown worker transport failure');
        this.shutdown(this.failure);
    }

    private request(payload: RequestPayload): Promise<WorkerResult> {
        if (this.failure || this.lifecycle === 'disposed') {
            return Promise.reject(this.failure ?? new Error('Worker proxy is disposed'));
        }
        if (this.pending) {
            return Promise.reject(new Error('Await the pending worker request before sending another'));
        }
        if (payload.type !== 'initialize' && this.lifecycle === 'new') {
            return Promise.reject(new Error('Initialize the worker before use'));
        }
        if (!Number.isSafeInteger(this.requestId + 1)) {
            return Promise.reject(new Error('Worker request sequence exhausted'));
        }
        return new Promise((resolve, reject) => {
            const pending: PendingRequest = { id: ++this.requestId, payload, resolve, reject };
            this.pending = pending;
            let scheduling = true;
            let inline = false;
            try {
                pending.cancel = this.options.deadlines.schedule(() => {
                    if (scheduling) {
                        inline = true; return;
                    }
                    if (this.pending === pending) {
                        this.fail(new Error('Worker request deadline exceeded; outcome may be unknown'));
                    }
                }, this.options.requestTimeoutMs);
                scheduling = false;
                if (inline || typeof pending.cancel !== 'function') {
                    throw new Error('Worker deadlines require asynchronous callbacks and cancellation');
                }
                this.options.transport.send({ version: WORKER_PROTOCOL_VERSION, sessionId: this.sessionId, requestId: pending.id, payload });
            } catch (error) {
                this.fail(error);
            }
        });
    }

    private receive(value: unknown): void {
        if (this.failure || this.lifecycle === 'disposed') {
            return;
        }
        try {
            const response = parseResponse(value, this.sessionId, this.session.configuration);
            if (response.type === 'fault') {
                throw new Error(response.message);
            }
            if (response.type === 'reply') {
                this.reply(response.requestId, response.result);
            } else {
                this.acceptOutput(response.batch);
            }
        } catch (error) {
            this.fail(error);
        }
    }

    private reply(requestId: number, result: WorkerResult): void {
        const pending = this.pending;
        if (!pending || pending.id !== requestId) {
            throw new Error('Unexpected or duplicate worker reply');
        }
        const { payload } = pending;
        if (result.type !== 'rejected') {
            const expected = payload.type === 'initialize' ? 'ready' : payload.type === 'input' ? 'accepted' : 'done';
            if (result.type !== expected) {
                throw new Error('Worker reply does not match the pending operation');
            }
            if (result.type === 'accepted') {
                const command = result.command;
                if (payload.type !== 'input' || command.sequence !== this.acceptedSequence + 1 || command.atMs < this.acceptedAtMs
                    || command.type !== payload.input.type
                    || (command.type === 'ChangeRoute' && payload.input.type === 'ChangeRoute'
                        && (command.destination.region !== payload.input.destination.region || command.destination.route !== payload.input.destination.route))) {
                    throw new Error('Worker acceptance does not match the input stream');
                }
            }
        }
        pending.cancel?.();
        this.pending = null;
        if (result.type === 'rejected') {
            pending.reject(new Error(result.message)); return;
        }
        if (result.type === 'ready') {
            this.snapshot = result.snapshot;
            this.lifecycle = 'stopped';
        } else if (result.type === 'accepted') {
            this.acceptedSequence = result.command.sequence;
            this.acceptedAtMs = result.command.atMs;
        } else if (payload.type === 'acknowledge') {
            this.output = null;
        } else if (payload.type === 'start' || payload.type === 'stop') {
            this.lifecycle = payload.type === 'start' ? 'running' : 'stopped';
        }
        pending.resolve(result);
    }

    private acceptOutput(batch: AdvanceResult): void {
        const previous = this.snapshot;
        const limits = this.session.configuration.simulation;
        if (!previous || this.output || batch.snapshot.sequence <= previous.sequence
            || batch.snapshot.sequence - previous.sequence > limits.maxStepsPerAdvance
            || batch.snapshot.atMs - previous.atMs !== (batch.snapshot.sequence - previous.sequence) * limits.stepMs) {
            throw new Error('Worker output violates snapshot ordering or delivery capacity');
        }
        // Validate the whole batch before committing any stream cursors or display state.
        let eventSequence = this.eventSequence, eventAtMs = this.eventAtMs;
        for (const event of batch.events) {
            if (event.sequence !== eventSequence + 1 || event.atMs < eventAtMs || event.atMs < previous.atMs) {
                throw new Error('Worker event stream contains a gap or time regression');
            }
            eventSequence = event.sequence; eventAtMs = event.atMs;
        }
        let outcomeSequence = this.outcomeSequence, outcomeAtMs = this.outcomeAtMs;
        for (const command of batch.commands) {
            if (command.sequence !== outcomeSequence + 1 || command.sequence > this.acceptedSequence || command.atMs < outcomeAtMs || command.atMs < previous.atMs) {
                throw new Error('Worker outcome stream contains a gap or unknown command');
            }
            outcomeSequence = command.sequence; outcomeAtMs = command.atMs;
        }
        this.eventSequence = eventSequence; this.eventAtMs = eventAtMs;
        this.outcomeSequence = outcomeSequence; this.outcomeAtMs = outcomeAtMs;
        this.snapshot = batch.snapshot; this.output = batch;
        const notification: unknown = this.options.onOutputAvailable?.();
        if (notification && typeof (notification as PromiseLike<unknown>).then === 'function') {
            Promise.resolve(notification).catch(() => {});
            throw new Error('Output notification must be synchronous; acknowledge asynchronous handling separately');
        }
    }
}
