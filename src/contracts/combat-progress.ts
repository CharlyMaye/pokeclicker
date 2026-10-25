import { CombatSnapshot, RouteReference, parseCombatSnapshot } from './combat-protocol';

export const PROGRESS_TOTAL_FIELDS = ['money', 'experience', 'dungeonTokens', 'defeats', 'clickAttacks', 'pokeballs'] as const;
export type ProgressTotalField = typeof PROGRESS_TOTAL_FIELDS[number];
export interface CombatProgress extends Readonly<Record<ProgressTotalField, number>> {
    readonly captured: readonly Readonly<{ pokemonId: number; count: number }>[];
    readonly routes: readonly Readonly<{ location: RouteReference; defeats: number; captures: number }>[];
}
/** Combat and progression describe one committed simulation step. Neither is an event to apply. */
export interface CombatFrame {
    readonly snapshot: CombatSnapshot;
    readonly progress: CombatProgress;
}
export interface ProgressLimits {
    readonly maxCaptured: number;
    readonly maxRoutes: number;
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).length !== fields.length
        || !fields.every(key => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return descriptor && 'value' in descriptor;
        })) {
        throw new Error(`Progress data must contain exactly: ${fields.join(', ')}`);
    }
    return value as Record<string, unknown>;
}
function integer(value: unknown, name: string, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${name} must be a safe integer >= ${minimum}`);
    }
    return value;
}
function array(value: unknown, limit: number): readonly unknown[] {
    if (!Array.isArray(value) || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new Error('Progress list exceeds its catalog bound or contains non-data properties');
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) {
            throw new Error('Progress lists must be dense data arrays');
        }
        result.push(descriptor.value);
    }
    return result;
}
function sum(values: readonly number[]): number {
    return values.reduce((total, value) => integer(total + value, 'progress sum'), 0);
}
export function parseProgressLimits(value: unknown): ProgressLimits {
    const data = object(value, ['maxCaptured', 'maxRoutes']);
    return Object.freeze({ maxCaptured: integer(data.maxCaptured, 'maxCaptured'), maxRoutes: integer(data.maxRoutes, 'maxRoutes') });
}
export function parseCombatProgress(value: unknown, suppliedLimits: ProgressLimits): CombatProgress {
    const limits = parseProgressLimits(suppliedLimits);
    const data = object(value, [...PROGRESS_TOTAL_FIELDS, 'captured', 'routes']);
    const totals = Object.fromEntries(PROGRESS_TOTAL_FIELDS.map(key => [key, integer(data[key], key)])) as Record<ProgressTotalField, number>;
    const captured = array(data.captured, limits.maxCaptured).map(value => {
        const entry = object(value, ['pokemonId', 'count']);
        if (typeof entry.pokemonId !== 'number' || !Number.isFinite(entry.pokemonId) || entry.pokemonId <= 0 || entry.pokemonId > Number.MAX_SAFE_INTEGER) {
            throw new Error('Invalid captured Pokemon identifier');
        }
        return Object.freeze({ pokemonId: entry.pokemonId, count: integer(entry.count, 'capture count', 1) });
    }).sort((a, b) => a.pokemonId - b.pokemonId);
    const routes = array(data.routes, limits.maxRoutes).map(value => {
        const entry = object(value, ['location', 'defeats', 'captures']);
        const location = object(entry.location, ['region', 'route']);
        const defeats = integer(entry.defeats, 'route defeats', 1), captures = integer(entry.captures, 'route captures');
        if (captures > defeats) {
            throw new Error('Route captures exceed defeats');
        }
        return Object.freeze({ location: Object.freeze({ region: integer(location.region, 'region'), route: integer(location.route, 'route', 1) }), defeats, captures });
    }).sort((a, b) => a.location.region - b.location.region || a.location.route - b.location.route);
    if (new Set(captured.map(entry => entry.pokemonId)).size !== captured.length
        || new Set(routes.map(entry => `${entry.location.region}:${entry.location.route}`)).size !== routes.length
        || sum(routes.map(entry => entry.defeats)) !== totals.defeats
        || sum(routes.map(entry => entry.captures)) !== sum(captured.map(entry => entry.count))) {
        throw new Error('Progress records are duplicated or totals are inconsistent');
    }
    return Object.freeze({ ...totals, captured: Object.freeze(captured), routes: Object.freeze(routes) });
}
export function parseCombatFrame(value: unknown, limits: ProgressLimits): CombatFrame {
    const data = object(value, ['snapshot', 'progress']);
    return Object.freeze({ snapshot: parseCombatSnapshot(data.snapshot), progress: parseCombatProgress(data.progress, limits) });
}
