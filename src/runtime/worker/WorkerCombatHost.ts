import { verifyPartyFrame } from './party';
import { createPartyState, projectPartyState } from '../../simulation/experience/partyExperience';
import { verifySessionProgress, verifyProgressAdvance } from './progress';
import { CombatFrame, CombatProgress, ProgressLimits, parseCombatProgress } from '../../contracts/combat-progress';
import { HostCheckpoint, parseHostCheckpoint } from '../persistence/HostCheckpoint';
import { sameData } from '../../simulation/combat/checkpoint';
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
    readonly onFault?: (error: Error) => void;
}

/** Main-thread proxy and snapshot source. It owns no engine, rewards or simulation clock. */
export class WorkerCombatHost {
    private readonly sessionId: string;
    private readonly session: WorkerSession;
    private readonly detach: () => void;
    private pending: PendingRequest | null = null;
    private frame: CombatFrame | null = null;
    private get snapshot(): CombatSnapshot | null {
        return this.frame?.snapshot ?? null;
    }
    private readonly progressLimits: ProgressLimits;
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
        this.progressLimits = Object.freeze({ maxCaptured: new Set(this.session.scenario.routes.flatMap(route => route.opponents.map(opponent => opponent.pokemonId))).size,
            maxRoutes: this.session.scenario.routes.length,
            ...(this.session.scenario.formatVersion === 4 ? { maxParty: this.session.scenario.party.members.length } : {}) });
        if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
            throw new Error('Worker requestTimeoutMs must be a positive safe integer');
        }
        this.detach = options.transport.listen(value => this.receive(value), error => this.fail(error));
    }

    get latest(): CombatSnapshot | null {
        return this.snapshot;
    }
    get latestFrame(): CombatFrame | null {
        return this.frame;
    }
    get progress(): CombatProgress | null {
        return this.frame?.progress ?? null;
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
    async checkpoint(): Promise<HostCheckpoint> {
        if (this.lifecycle !== 'stopped' || this.output) {
            throw new Error('Stop combat and acknowledge all output before saving');
        }
        const result = await this.request({ type: 'checkpoint' });
        if (result.type !== 'checkpoint') {
            throw new Error('Expected a checkpoint response');
        }
        return result.checkpoint;
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
        try {
            this.options.onFault?.(this.failure);
        } catch { /* Preserve the transport failure and terminated state. */ }
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
            const response = parseResponse(value, this.sessionId, this.session.configuration, this.progressLimits);
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
            const expected = payload.type === 'initialize' ? 'ready' : payload.type === 'input' ? 'accepted' : payload.type === 'checkpoint' ? 'checkpoint' : 'done';
            if (result.type !== expected) {
                throw new Error('Worker reply does not match the pending operation');
            }
            if (result.type === 'ready') {
                const saved = this.session.checkpoint?.combat;
                const expectedProgress = saved ? { ...saved.progress, pokeballs: saved.pokeballs }
                    : { money: 0, experience: 0, dungeonTokens: 0, defeats: 0, clickAttacks: 0, pokeballs: this.session.scenario.initialPokeballs, captured: [], routes: [] };
                if (!sameData(result.progress, parseCombatProgress(expectedProgress, this.progressLimits))) {
                    throw new Error('Worker did not initialize the requested progress');
                }
                verifyPartyFrame(result, this.session.scenario);
                const expectedParty = saved?.formatVersion === 3 ? saved.party : this.session.scenario.formatVersion === 4
                    ? projectPartyState(createPartyState(this.session.scenario.party)) : undefined;
                if (!sameData(result.party ?? null, expectedParty ?? null)) {
                    throw new Error('Worker did not initialize the requested party');
                }
                verifySessionProgress(result.progress, result.snapshot, this.session.scenario, result.cursors.eventSequence, result.cursors.outcomeSequence);
                const expectedCursors = saved ? { commandSequence: saved.commandSequence, commandAtMs: saved.commandAtMs,
                    eventSequence: saved.eventSequence, outcomeSequence: saved.commandSequence - saved.commands.length }
                    : { commandSequence: 0, commandAtMs: 0, eventSequence: 0, outcomeSequence: 0 };
                if (!sameData(result.cursors, expectedCursors) || (saved
                    ? !sameData(result.snapshot, { ...saved.snapshot, sessionId: this.sessionId })
                    : result.snapshot.atMs !== 0 || result.snapshot.sequence !== 0)) {
                    throw new Error('Worker did not initialize the requested checkpoint');
                }
            }
            if (result.type === 'checkpoint') {
                const saved = parseHostCheckpoint(result.checkpoint, this.session.configuration, this.session.scenario).combat;
                if (!sameData(parseCombatProgress({ ...saved.progress, pokeballs: saved.pokeballs }, this.progressLimits), this.progress) || !sameData(saved.snapshot, this.snapshot) || saved.commandSequence !== this.acceptedSequence
                    || !sameData(saved.formatVersion === 3 ? saved.party : null, this.frame?.party ?? null)
                    || saved.commandAtMs !== this.acceptedAtMs || saved.eventSequence !== this.eventSequence
                    || saved.commandSequence - saved.commands.length !== this.outcomeSequence) {
                    throw new Error('Worker checkpoint disagrees with delivered state');
                }
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
            this.frame = Object.freeze({ snapshot: result.snapshot, progress: result.progress, ...(result.party ? { party: result.party } : {}) });
            this.acceptedSequence = result.cursors.commandSequence;
            this.acceptedAtMs = result.cursors.commandAtMs;
            this.eventSequence = result.cursors.eventSequence;
            this.outcomeSequence = result.cursors.outcomeSequence;
            this.eventAtMs = result.snapshot.atMs;
            this.outcomeAtMs = result.snapshot.atMs;
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
        const previousProgress = this.progress;
        if (!previousProgress) {
            throw new Error('Worker output preceded initial progress');
        }
        verifySessionProgress(batch.progress, batch.snapshot, this.session.scenario, eventSequence, outcomeSequence);
        verifyProgressAdvance(previousProgress, batch);
        verifyPartyFrame(batch, this.session.scenario, this.frame ?? undefined);
        this.eventSequence = eventSequence; this.eventAtMs = eventAtMs;
        this.outcomeSequence = outcomeSequence; this.outcomeAtMs = outcomeAtMs;
        this.frame = Object.freeze({ snapshot: batch.snapshot, progress: batch.progress, ...(batch.party ? { party: batch.party } : {}) }); this.output = batch;
        const notification: unknown = this.options.onOutputAvailable?.();
        if (notification && typeof (notification as PromiseLike<unknown>).then === 'function') {
            Promise.resolve(notification).catch(() => {});
            throw new Error('Output notification must be synchronous; acknowledge asynchronous handling separately');
        }
    }
}
