import { COMBAT_PROTOCOL_VERSION, validateSessionId } from '../../contracts/combat-protocol';
import type { WakeScheduler } from '../../contracts/scheduling';
import { DirectCombatHost } from '../combat/DirectCombatHost';
import { parseRequest, WorkerRequest, WorkerResponse, WorkerResult, WORKER_PROTOCOL_VERSION } from './protocol';
import type { CombatTransport } from './transport';

/** Worker-side owner. Only one unacknowledged batch crosses the channel at a time. */
export class CombatWorkerServer {
    private host: DirectCombatHost | null = null;
    private sessionId: string | null = null;
    private requestId = 0;
    private commandSequence = 0;
    private sentSequence: number | null = null;
    private closed = false;
    private readonly detach: () => void;

    constructor(private readonly transport: CombatTransport, private readonly now: () => number, private readonly scheduler: WakeScheduler) {
        this.detach = transport.listen(value => this.receive(value), error => this.fail(error));
    }

    dispose(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.host?.dispose();
        try {
            this.detach();
        } finally {
            this.transport.close();
        }
    }

    private send(response: WorkerResponse): void {
        this.transport.send(response);
    }

    private fail(error: unknown): void {
        if (this.closed) {
            return;
        }
        try {
            if (this.sessionId) {
                this.send({ version: WORKER_PROTOCOL_VERSION, sessionId: this.sessionId, type: 'fault', message: error instanceof Error ? error.message : 'Unknown worker failure' });
            }
        } catch {
            // A broken channel may also reject the diagnostic; still stop simulation.
        } finally {
            this.dispose();
        }
    }

    private pump(): void {
        if (this.closed || this.sentSequence !== null || !this.host?.pendingOutput) {
            return;
        }
        const batch = this.host.pendingOutput;
        this.sentSequence = batch.snapshot.sequence;
        this.send({ version: WORKER_PROTOCOL_VERSION, sessionId: batch.snapshot.sessionId, type: 'output', batch });
    }

    private receive(value: unknown): void {
        if (this.closed) {
            return;
        }
        try {
            if (!this.sessionId) {
                const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'sessionId') : undefined;
                this.sessionId = validateSessionId(descriptor && 'value' in descriptor ? descriptor.value : undefined);
            }
            const request = parseRequest(value, this.sessionId);
            if (request.requestId !== this.requestId + 1) {
                throw new Error('Worker requests must be contiguous and unique');
            }
            this.requestId = request.requestId;
            let result: WorkerResult;
            try {
                result = this.execute(request);
            } catch (error) {
                if (!this.host || this.host.fault) {
                    throw error;
                }
                result = { type: 'rejected', message: error instanceof Error ? error.message : 'Worker request rejected' };
            }
            this.send({ version: WORKER_PROTOCOL_VERSION, sessionId: this.sessionId, type: 'reply', requestId: request.requestId, result });
            // Reply before the next batch, so acknowledgment is committed at both endpoints first.
            this.pump();
        } catch (error) {
            this.fail(error);
        }
    }

    private execute(request: WorkerRequest): WorkerResult {
        const { payload, sessionId } = request;
        if (payload.type === 'initialize') {
            if (this.host) {
                throw new Error('Worker session is already initialized');
            }
            this.host = new DirectCombatHost({
                sessionId, ...payload.session, now: this.now,
                scheduler: { schedule: (callback, delay) => this.scheduler.schedule(() => {
                    try {
                        callback();
                        if (this.host?.fault) {
                            throw this.host.fault;
                        }
                    } catch (error) {
                        this.fail(error);
                    }
                }, delay) },
                onOutputAvailable: () => this.pump(),
            });
            return { type: 'ready', snapshot: this.host.latest };
        }
        const host = this.host;
        if (!host) {
            throw new Error('Initialize the worker before use');
        }
        switch (payload.type) {
            case 'start': host.start(); return { type: 'done' };
            case 'stop': host.stop(); return { type: 'done' };
            case 'acknowledge':
                if (this.sentSequence !== payload.sequence) {
                    throw new Error('Acknowledgment must match the delivered batch');
                }
                host.acknowledge(payload.sequence);
                this.sentSequence = null;
                return { type: 'done' };
            case 'input': {
                if (host.state !== 'running') {
                    throw new Error('Combat input requires a running worker with output capacity');
                }
                // Worker ingress owns time. A boundary already committed moves to its next millisecond.
                const atMs = Math.max(host.inputTimeMs(), host.latest.sequence ? host.latest.atMs + 1 : 0);
                const command = { ...payload.input, protocolVersion: COMBAT_PROTOCOL_VERSION, sessionId, sequence: this.commandSequence + 1, atMs } as const;
                host.submit(command);
                this.commandSequence++;
                return { type: 'accepted', command };
            }
        }
    }
}
