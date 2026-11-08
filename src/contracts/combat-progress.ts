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
    readonly party?: PartyProgress;
}
export interface PartyProgress {
    readonly grants: number;
    readonly shadowExperience: number;
    readonly members: readonly Readonly<{ pokemonId: number; experience: number; level: number }>[];
}
export interface ProgressLimits {
    readonly maxCaptured: number;
    readonly maxRoutes: number;
    /** Presence enables party frames, including an explicitly empty roster. */
    readonly maxParty?: number;
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
    const party = !!value && Object.prototype.hasOwnProperty.call(value, 'maxParty');
    const data = object(value, ['maxCaptured', 'maxRoutes', ...(party ? ['maxParty'] : [])]);
    return Object.freeze({ maxCaptured: integer(data.maxCaptured, 'maxCaptured'), maxRoutes: integer(data.maxRoutes, 'maxRoutes'),
        ...(party ? { maxParty: integer(data.maxParty, 'maxParty') } : {}) });
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
    const bounds = parseProgressLimits(limits);
    const data = object(value, ['snapshot', 'progress', ...(bounds.maxParty === undefined ? [] : ['party'])]);
    const progress = parseCombatProgress(data.progress, bounds);
    return Object.freeze({ snapshot: parseCombatSnapshot(data.snapshot), progress,
        ...(bounds.maxParty === undefined ? {} : { party: parsePartyProgress(data.party, bounds.maxParty, progress.defeats) }) });
}

/** Presentation validation; curve and cap consistency require the initialized session. */
export function parsePartyProgress(value: unknown, maxMembers: number, defeats: number): PartyProgress {
    integer(maxMembers, 'maxParty'); integer(defeats, 'defeats');
    const data = object(value, ['grants', 'shadowExperience', 'members']);
    const grants = integer(data.grants, 'party grants');
    const nonnegative = (value: unknown): number => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
            throw new Error('Party experience must be finite, nonnegative and within the supported range');
        }
        return value;
    };
    const shadowExperience = nonnegative(data.shadowExperience);
    const members = array(data.members, maxMembers).map(value => {
        const member = object(value, ['pokemonId', 'experience', 'level']);
        const pokemonId = nonnegative(member.pokemonId), experience = nonnegative(member.experience);
        if (pokemonId === 0 || experience === Number.MAX_SAFE_INTEGER) {
            throw new Error('Invalid party identifier or experience sentinel');
        }
        return Object.freeze({ pokemonId, experience, level: integer(member.level, 'party level', 1) });
    });
    if (grants !== defeats || (!grants && shadowExperience !== 0)
        || new Set(members.map(member => member.pokemonId)).size !== members.length) {
        throw new Error('Party grants, identities or shadow experience are inconsistent');
    }
    return Object.freeze({ grants, shadowExperience, members: Object.freeze(members) });
}
