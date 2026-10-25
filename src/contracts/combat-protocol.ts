// Wire-format version, independent of game balance and configuration versions.
export const COMBAT_PROTOCOL_VERSION = 1;

export interface MessageHeader {
    readonly protocolVersion: typeof COMBAT_PROTOCOL_VERSION;
    readonly sessionId: string;
    readonly sequence: number;
    readonly atMs: number;
}

export interface RouteReference {
    readonly region: number;
    readonly route: number;
}

export type CombatCommand = MessageHeader & (
    { readonly type: 'ClickAttack' }
    | { readonly type: 'ChangeRoute'; readonly destination: RouteReference }
);

export interface EnemyProjection {
    readonly encounterId: number;
    readonly pokemonId: number;
    readonly health: number;
    readonly maxHealth: number;
}

export type EncounterProjection =
    { readonly phase: 'idle' }
    | { readonly phase: 'fighting'; readonly enemy: EnemyProjection }
    | { readonly phase: 'capturing'; readonly enemy: EnemyProjection; readonly resolvesAtMs: number };

export interface CombatSnapshot extends MessageHeader {
    readonly type: 'CombatSnapshot';
    readonly location: RouteReference;
    readonly encounter: EncounterProjection;
}

export type CombatEvent = MessageHeader & (
    { readonly type: 'EnemyDefeated'; readonly encounterId: number; readonly pokemonId: number }
    | { readonly type: 'CaptureResolved'; readonly encounterId: number; readonly pokemonId: number; readonly caught: boolean }
);

export type ProtocolErrorCode = 'invalid-payload' | 'unsupported-version' | 'wrong-session' | 'sequence' | 'time';

export class ProtocolError extends Error {
    constructor(public readonly code: ProtocolErrorCode, public readonly path: string, detail: string) {
        super(`${path}: ${detail}`);
        this.name = 'ProtocolError';
    }
}

function invalid(path: string, detail: string): never {
    throw new ProtocolError('invalid-payload', path, detail);
}

function record(value: unknown, path: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        return invalid(path, 'Expected a plain data object');
    }
    // Worker messages are structured-cloned data. Reject accessors in direct hosts too.
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value')) {
            return invalid(path, 'Expected string-keyed data properties');
        }
    }
    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
    const actual = Object.getOwnPropertyNames(value);
    if (actual.length !== expected.length || !expected.every(key => Object.prototype.hasOwnProperty.call(value, key))) {
        invalid(path, `Expected exactly: ${expected.join(', ')}`);
    }
}

function number(value: unknown, path: string, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
        return invalid(path, `Expected a finite number >= ${minimum}`);
    }
    return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
    const result = number(value, path, minimum);
    if (!Number.isSafeInteger(result)) {
        return invalid(path, 'Expected a safe integer');
    }
    return result;
}

export function validateSessionId(value: unknown): string {
    if (typeof value !== 'string' || !value.length || value.trim() !== value) {
        return invalid('sessionId', 'Expected a nonempty identifier without surrounding whitespace');
    }
    return value;
}

const HEADER_KEYS = ['protocolVersion', 'sessionId', 'sequence', 'atMs', 'type'];

function header(value: Record<string, unknown>, firstSequence: number): MessageHeader {
    if (value.protocolVersion !== COMBAT_PROTOCOL_VERSION) {
        throw new ProtocolError('unsupported-version', 'protocolVersion', 'Unsupported combat protocol version');
    }
    return {
        protocolVersion: COMBAT_PROTOCOL_VERSION,
        sessionId: validateSessionId(value.sessionId),
        sequence: integer(value.sequence, 'sequence', firstSequence),
        atMs: integer(value.atMs, 'atMs'),
    };
}

function route(value: unknown, path: string): RouteReference {
    const data = record(value, path);
    keys(data, ['region', 'route'], path);
    return Object.freeze({ region: integer(data.region, `${path}.region`), route: integer(data.route, `${path}.route`, 1) });
}

function pokemonId(value: unknown, path: string): number {
    const result = number(value, path);
    // Legacy form IDs can be fractional; membership is checked by the catalog owner.
    if (result === 0 || result > Number.MAX_SAFE_INTEGER) {
        return invalid(path, 'Expected a positive catalog identifier within the safe numeric range');
    }
    return result;
}

function enemy(value: unknown): EnemyProjection {
    const data = record(value, 'encounter.enemy');
    keys(data, ['encounterId', 'pokemonId', 'health', 'maxHealth'], 'encounter.enemy');
    const maxHealth = number(data.maxHealth, 'encounter.enemy.maxHealth');
    const health = number(data.health, 'encounter.enemy.health');
    if (maxHealth === 0 || health > maxHealth) {
        return invalid('encounter.enemy.health', 'Expected 0 <= health <= maxHealth and maxHealth > 0');
    }
    return Object.freeze({
        encounterId: integer(data.encounterId, 'encounter.enemy.encounterId', 1),
        pokemonId: pokemonId(data.pokemonId, 'encounter.enemy.pokemonId'),
        health,
        maxHealth,
    });
}

export function parseCombatCommand(value: unknown): CombatCommand {
    const data = record(value, 'command');
    const common = header(data, 1);
    switch (data.type) {
        case 'ClickAttack':
            keys(data, HEADER_KEYS, 'command');
            return Object.freeze({ ...common, type: 'ClickAttack' });
        case 'ChangeRoute':
            keys(data, [...HEADER_KEYS, 'destination'], 'command');
            return Object.freeze({ ...common, type: 'ChangeRoute', destination: route(data.destination, 'destination') });
        default:
            return invalid('command.type', 'Unknown command');
    }
}

export function parseCombatSnapshot(value: unknown): CombatSnapshot {
    const data = record(value, 'snapshot');
    keys(data, [...HEADER_KEYS, 'location', 'encounter'], 'snapshot');
    if (data.type !== 'CombatSnapshot') {
        return invalid('snapshot.type', 'Expected CombatSnapshot');
    }
    const common = header(data, 0);
    const location = route(data.location, 'location');
    const state = record(data.encounter, 'encounter');
    let encounter: EncounterProjection;
    switch (state.phase) {
        case 'idle':
            keys(state, ['phase'], 'encounter');
            encounter = Object.freeze({ phase: 'idle' });
            break;
        case 'fighting': {
            keys(state, ['phase', 'enemy'], 'encounter');
            const target = enemy(state.enemy);
            if (target.health === 0) {
                return invalid('encounter.enemy.health', 'A fighting enemy must be alive');
            }
            encounter = Object.freeze({ phase: 'fighting', enemy: target });
            break;
        }
        case 'capturing': {
            keys(state, ['phase', 'enemy', 'resolvesAtMs'], 'encounter');
            const target = enemy(state.enemy);
            const resolvesAtMs = integer(state.resolvesAtMs, 'encounter.resolvesAtMs');
            if (target.health !== 0 || resolvesAtMs < common.atMs) {
                return invalid('encounter', 'Capture requires a defeated enemy and a non-past deadline');
            }
            encounter = Object.freeze({ phase: 'capturing', enemy: target, resolvesAtMs });
            break;
        }
        default:
            return invalid('encounter.phase', 'Unknown encounter phase');
    }
    return Object.freeze({ ...common, type: 'CombatSnapshot', location, encounter });
}

export function parseCombatEvent(value: unknown): CombatEvent {
    const data = record(value, 'event');
    const common = header(data, 1);
    const identity = {
        encounterId: integer(data.encounterId, 'encounterId', 1),
        pokemonId: pokemonId(data.pokemonId, 'pokemonId'),
    };
    switch (data.type) {
        case 'EnemyDefeated':
            keys(data, [...HEADER_KEYS, 'encounterId', 'pokemonId'], 'event');
            return Object.freeze({ ...common, ...identity, type: 'EnemyDefeated' });
        case 'CaptureResolved':
            keys(data, [...HEADER_KEYS, 'encounterId', 'pokemonId', 'caught'], 'event');
            if (typeof data.caught !== 'boolean') {
                return invalid('caught', 'Expected a boolean');
            }
            return Object.freeze({ ...common, ...identity, type: 'CaptureResolved', caught: data.caught });
        default:
            return invalid('event.type', 'Unknown event');
    }
}
