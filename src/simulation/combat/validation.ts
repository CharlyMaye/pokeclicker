import type { RouteReference } from '../../contracts/combat-protocol';
import { CombatScenario, OpponentDefinition, RandomStep, SimulationInputError, UniformCombatRoute, WeightedCombatRoute } from './model';
import { findRoute, routeKey } from './routes';
import { catalogId, dataArray, dataObject, safeInteger } from './input';
import { validateEncounterTable } from './encounters';
export { dataArray, dataObject, safeInteger } from './input';

// Algorithm representation limit, not a gameplay setting.
export const MAX_RANDOM_STATE = 2 ** 32 - 1;

function opponent(value: unknown): OpponentDefinition {
    const data = dataObject(value, [
        'pokemonId', 'health', 'autoAttackDamage', 'moneyReward', 'experienceReward',
        'dungeonTokenReward', 'captureProbability', 'captureDurationMs',
    ], 'opponent');
    if (typeof data.captureProbability !== 'number' || !Number.isFinite(data.captureProbability)
        || data.captureProbability < 0 || data.captureProbability > 1) {
        throw new SimulationInputError('invalid-input', 'captureProbability must be between 0 and 1');
    }
    return Object.freeze({
        pokemonId: catalogId(data.pokemonId),
        health: safeInteger(data.health, 'health', 1),
        autoAttackDamage: safeInteger(data.autoAttackDamage, 'autoAttackDamage'),
        moneyReward: safeInteger(data.moneyReward, 'moneyReward'),
        experienceReward: safeInteger(data.experienceReward, 'experienceReward'),
        dungeonTokenReward: safeInteger(data.dungeonTokenReward, 'dungeonTokenReward'),
        captureProbability: data.captureProbability,
        captureDurationMs: safeInteger(data.captureDurationMs, 'captureDurationMs', 1),
    });
}

export function validateLocation(value: unknown): RouteReference {
    const data = dataObject(value, ['region', 'route'], 'location');
    return Object.freeze({ region: safeInteger(data.region, 'region'), route: safeInteger(data.route, 'route', 1) });
}

function route(value: unknown, weighted: true): WeightedCombatRoute;
function route(value: unknown, weighted: false): UniformCombatRoute;
function route(value: unknown, weighted: boolean): UniformCombatRoute | WeightedCombatRoute {
    const fields = ['location', 'opponents', 'unlocked'];
    const data = dataObject(value, weighted ? [...fields, 'encounters'] : fields, 'route');
    if (!Array.isArray(data.opponents) || data.opponents.length === 0 || typeof data.unlocked !== 'boolean') {
        throw new SimulationInputError('invalid-input', 'Expected a nonempty opponent list and boolean unlocked');
    }
    const opponents = Array.from(dataArray(data.opponents, 'opponents'), opponent);
    if (new Set(opponents.map(entry => entry.pokemonId)).size !== opponents.length) {
        throw new SimulationInputError('invalid-input', 'Opponent catalog IDs must be unique within a route');
    }
    const encounters = weighted ? validateEncounterTable(data.encounters, new Set(opponents.map(entry => entry.pokemonId))) : undefined;
    if (encounters && opponents.some(entry => !encounters.some(encounter => encounter.pokemonId === entry.pokemonId))) {
        throw new SimulationInputError('invalid-input', 'Every weighted route opponent must appear in its encounter table');
    }
    const selection = encounters ? { encounters } : {};
    return Object.freeze({
        ...selection,
        location: validateLocation(data.location),
        opponents: Object.freeze(opponents),
        unlocked: data.unlocked,
    });
}

export function validateScenario(value: unknown): CombatScenario {
    // Inspect a data descriptor without invoking untrusted getters.
    const version = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'formatVersion') : undefined;
    const weighted = version !== undefined;
    const fields = ['initialLocation', 'routes', 'clickAttackDamage', 'clickAttacksAllowed', 'initialPokeballs'];
    const data = dataObject(value, weighted ? [...fields, 'formatVersion'] : fields, 'scenario');
    if (weighted && data.formatVersion !== 2) {
        throw new SimulationInputError('invalid-input', 'Unsupported combat scenario formatVersion');
    }
    if (!Array.isArray(data.routes) || data.routes.length === 0 || typeof data.clickAttacksAllowed !== 'boolean') {
        throw new SimulationInputError('invalid-input', 'Expected a nonempty route list and boolean clickAttacksAllowed');
    }
    const input = dataArray(data.routes, 'routes');
    const selection = weighted
        ? { formatVersion: 2 as const, routes: Object.freeze(Array.from(input, entry => route(entry, true))) }
        : { routes: Object.freeze(Array.from(input, entry => route(entry, false))) };
    const { routes } = selection;
    if (new Set(routes.map(entry => routeKey(entry.location))).size !== routes.length) {
        throw new SimulationInputError('invalid-input', 'Route locations must be unique');
    }
    const initialLocation = validateLocation(data.initialLocation);
    if (!findRoute(routes, initialLocation)?.unlocked) {
        throw new SimulationInputError('invalid-input', 'Initial location must resolve to an unlocked route');
    }
    return Object.freeze({
        initialLocation,
        ...selection,
        clickAttackDamage: safeInteger(data.clickAttackDamage, 'clickAttackDamage'),
        clickAttacksAllowed: data.clickAttacksAllowed,
        initialPokeballs: safeInteger(data.initialPokeballs, 'initialPokeballs'),
    });
}

export function validateRandomState(state: unknown): number {
    const result = safeInteger(state, 'random state', 1);
    if (result > MAX_RANDOM_STATE) {
        throw new SimulationInputError('invalid-input', 'Random state exceeds the unsigned 32-bit range');
    }
    return result;
}

/** Xorshift32: all shifts and the divisor define the algorithm, not balance. */
export const xorshift32: RandomStep = (state) => {
    let next = state;
    next ^= next << 13;
    next ^= next >>> 17;
    next ^= next << 5;
    next >>>= 0;
    return { state: next, value: next / (MAX_RANDOM_STATE + 1) };
};

export function add(left: number, right: number, label: string): number {
    return safeInteger(left + right, label);
}
