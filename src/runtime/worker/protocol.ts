import { HostCheckpoint, parseHostCheckpoint } from '../persistence/HostCheckpoint';
import { COMBAT_PROTOCOL_VERSION, CombatCommand, CombatSnapshot, parseCombatCommand, parseCombatEvent, parseCombatSnapshot, validateSessionId } from '../../contracts/combat-protocol';
import type { Configuration } from '../../contracts/configuration-types';
import { validateConfiguration } from '../../contracts/configuration';
import type { AdvanceResult } from '../../simulation/combat/RouteCombatSimulation';
import { validateScenario, validateRandomState, safeInteger } from '../../simulation/combat/validation';
import type { CombatScenario, CommandOutcome } from '../../simulation/combat/model';

// Transport version is independent of the combat and configuration versions.
export const WORKER_PROTOCOL_VERSION = 2;
export type CombatInput = Readonly<{ type: 'ClickAttack' }> | Readonly<{ type: 'ChangeRoute'; destination: { region: number; route: number } }>;
export interface WorkerSession {
    readonly configuration: Configuration;
    readonly scenario: CombatScenario;
    readonly seed: number;
    readonly checkpoint?: HostCheckpoint;
}
export type RequestPayload =
    | { readonly type: 'initialize'; readonly session: WorkerSession }
    | { readonly type: 'start' | 'stop' | 'checkpoint' }
    | { readonly type: 'input'; readonly input: CombatInput }
    | { readonly type: 'acknowledge'; readonly sequence: number };
export interface WorkerRequest {
    readonly version: typeof WORKER_PROTOCOL_VERSION;
    readonly sessionId: string;
    readonly requestId: number;
    readonly payload: RequestPayload;
}
export interface WorkerCursors {
    readonly commandSequence: number;
    readonly commandAtMs: number;
    readonly eventSequence: number;
    readonly outcomeSequence: number;
}

export type WorkerResult =
    | { readonly type: 'ready'; readonly snapshot: CombatSnapshot; readonly cursors: WorkerCursors }
    | { readonly type: 'checkpoint'; readonly checkpoint: HostCheckpoint }
    | { readonly type: 'accepted'; readonly command: CombatCommand }
    | { readonly type: 'done' }
    | { readonly type: 'rejected'; readonly message: string };
export type WorkerResponse = { readonly version: typeof WORKER_PROTOCOL_VERSION; readonly sessionId: string } & (
    | { readonly type: 'reply'; readonly requestId: number; readonly result: WorkerResult }
    | { readonly type: 'output'; readonly batch: AdvanceResult }
    | { readonly type: 'fault'; readonly message: string }
);

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).length !== fields.length
        || !fields.every(key => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return descriptor && 'value' in descriptor;
        })) {
        throw new Error(`Worker data must contain exactly: ${fields.join(', ')}`);
    }
    return value as Record<string, unknown>;
}

function kind(value: unknown): string {
    if (!value || typeof value !== 'object') {
        throw new Error('Missing worker message type');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
        throw new Error('Missing worker message type');
    }
    return descriptor.value;
}

function header(data: Record<string, unknown>, sessionId: string): void {
    if (data.version !== WORKER_PROTOCOL_VERSION || validateSessionId(data.sessionId) !== sessionId) {
        throw new Error('Unsupported worker protocol version or foreign session');
    }
}

function message(value: unknown): string {
    if (typeof value !== 'string' || !value.length) {
        throw new Error('Expected a worker failure diagnostic');
    }
    return value;
}

export function parseInput(value: unknown): CombatInput {
    const type = kind(value);
    const data = object(value, type === 'ClickAttack' ? ['type'] : ['type', 'destination']);
    if (type !== 'ClickAttack' && type !== 'ChangeRoute') {
        throw new Error('Unsupported combat input');
    }
    // Reuse the combat contract's exact route validator without exposing timestamps to the UI.
    const command = parseCombatCommand({ ...data, protocolVersion: COMBAT_PROTOCOL_VERSION, sessionId: 'input-validation', sequence: 1, atMs: 0 });
    return command.type === 'ClickAttack' ? Object.freeze({ type: 'ClickAttack' })
        : Object.freeze({ type: 'ChangeRoute', destination: command.destination });
}

export function parseSession(value: unknown): WorkerSession {
    const hasCheckpoint = !!value && Object.prototype.hasOwnProperty.call(value, 'checkpoint');
    const data = object(value, ['configuration', 'scenario', 'seed', ...(hasCheckpoint ? ['checkpoint'] : [])]);
    const config = object(data.configuration, ['combat', 'simulation']);
    const configuration = validateConfiguration({ combat: config.combat, simulation: config.simulation });
    const scenario = validateScenario(data.scenario);
    return Object.freeze({ configuration, scenario, seed: validateRandomState(data.seed),
        ...(hasCheckpoint ? { checkpoint: parseHostCheckpoint(data.checkpoint, configuration, scenario) } : {}) });
}

export function parseRequest(value: unknown, sessionId: string): WorkerRequest {
    const data = object(value, ['version', 'sessionId', 'requestId', 'payload']);
    header(data, sessionId);
    const requestId = safeInteger(data.requestId, 'requestId', 1);
    const type = kind(data.payload);
    let payload: RequestPayload;
    switch (type) {
        case 'initialize': {
            const content = object(data.payload, ['type', 'session']);
            payload = { type, session: parseSession(content.session) }; break;
        }
        case 'input': {
            const content = object(data.payload, ['type', 'input']);
            payload = { type, input: parseInput(content.input) }; break;
        }
        case 'acknowledge': {
            const content = object(data.payload, ['type', 'sequence']);
            payload = { type, sequence: safeInteger(content.sequence, 'acknowledgment sequence', 1) }; break;
        }
        case 'start': case 'stop': case 'checkpoint':
            object(data.payload, ['type']); payload = { type }; break;
        default: throw new Error('Unsupported worker request');
    }
    return Object.freeze({ version: WORKER_PROTOCOL_VERSION, sessionId, requestId, payload: Object.freeze(payload) });
}

function parseResult(value: unknown, sessionId: string): WorkerResult {
    const type = kind(value);
    switch (type) {
        case 'ready': {
            const data = object(value, ['type', 'snapshot', 'cursors']);
            const snapshot = parseCombatSnapshot(data.snapshot);
            if (snapshot.sessionId !== sessionId) {
                throw new Error('Worker initialization belongs to a foreign session');
            }
            const cursor = object(data.cursors, ['commandSequence', 'commandAtMs', 'eventSequence', 'outcomeSequence']);
            const cursors = Object.freeze({ commandSequence: safeInteger(cursor.commandSequence, 'commandSequence'),
                commandAtMs: safeInteger(cursor.commandAtMs, 'commandAtMs'), eventSequence: safeInteger(cursor.eventSequence, 'eventSequence'),
                outcomeSequence: safeInteger(cursor.outcomeSequence, 'outcomeSequence') });
            if (cursors.outcomeSequence > cursors.commandSequence || (!cursors.commandSequence && cursors.commandAtMs)) {
                throw new Error('Invalid restored worker cursors');
            }
            return Object.freeze({ type, snapshot, cursors });
        }
        case 'checkpoint': return Object.freeze({ type, checkpoint: parseHostCheckpoint(object(value, ['type', 'checkpoint']).checkpoint) });
        case 'accepted': {
            const data = object(value, ['type', 'command']);
            const command = parseCombatCommand(data.command);
            if (command.sessionId !== sessionId) {
                throw new Error('Foreign accepted command');
            }
            return Object.freeze({ type, command });
        }
        case 'done': object(value, ['type']); return Object.freeze({ type });
        case 'rejected': return Object.freeze({ type, message: message(object(value, ['type', 'message']).message) });
        default: throw new Error('Unsupported worker reply');
    }
}

function outcome(value: unknown): CommandOutcome {
    const data = object(value, ['sequence', 'atMs', 'result']);
    if (!['applied', 'cooldown', 'disabled', 'no-target', 'route-unchanged', 'route-unavailable'].includes(data.result as string)) {
        throw new Error('Unknown command outcome');
    }
    return Object.freeze({ sequence: safeInteger(data.sequence, 'command sequence', 1), atMs: safeInteger(data.atMs, 'command time'), result: data.result as CommandOutcome['result'] });
}

export function parseResponse(value: unknown, sessionId: string, configuration: Configuration): WorkerResponse {
    const type = kind(value);
    const fields = ['version', 'sessionId', 'type'];
    const data = object(value, [...fields, ...(type === 'reply' ? ['requestId', 'result'] : type === 'output' ? ['batch'] : ['message'])]);
    header(data, sessionId);
    const common = { version: WORKER_PROTOCOL_VERSION, sessionId } as const;
    switch (type) {
        case 'reply': return Object.freeze({ ...common, type, requestId: safeInteger(data.requestId, 'requestId', 1), result: parseResult(data.result, sessionId) });
        case 'fault': return Object.freeze({ ...common, type, message: message(data.message) });
        case 'output': {
            const batch = object(data.batch, ['snapshot', 'events', 'commands', 'remainingMs']);
            const limits = configuration.simulation;
            // Each transition can emit at most two combat events; check lengths before mapping.
            const eventLimit = limits.maxStepsPerAdvance * limits.maxTransitionsPerStep * 2;
            if (!Array.isArray(batch.events) || batch.events.length > eventLimit
                || !Array.isArray(batch.commands) || batch.commands.length > limits.maxQueuedCommands) {
                throw new Error('Worker output exceeds the configured batch limits');
            }
            const snapshot = parseCombatSnapshot(batch.snapshot);
            const events = Object.freeze(Array.from(batch.events, parseCombatEvent));
            const commands = Object.freeze(Array.from(batch.commands, outcome));
            if (snapshot.sessionId !== sessionId || events.some(event => event.sessionId !== sessionId || event.atMs > snapshot.atMs)
                || commands.some(command => command.atMs > snapshot.atMs)) {
                throw new Error('Worker batch contains foreign or future records');
            }
            return Object.freeze({ ...common, type, batch: Object.freeze({ snapshot, events, commands, remainingMs: safeInteger(batch.remainingMs, 'remainingMs') }) });
        }
        default: throw new Error('Unsupported worker response');
    }
}
