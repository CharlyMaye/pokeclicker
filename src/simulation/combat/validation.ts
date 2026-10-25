import type { RouteReference } from '../../contracts/combat-protocol';
import { CombatRoute, CombatScenario, OpponentDefinition, RandomStep, SimulationInputError } from './model';
import { findRoute, routeKey } from './routes';

// Algorithm representation limit, not a gameplay setting.
export const MAX_RANDOM_STATE = 2 ** 32 - 1;

export function safeInteger(value: unknown, label: string, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
        throw new SimulationInputError('invalid-input', `${label} must be a safe integer >= ${minimum}`);
    }
    return value;
}

export function dataObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new SimulationInputError('invalid-input', `${label} must be a plain data object`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || !fields.every(field => {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        return descriptor && 'value' in descriptor;
    })) {
        throw new SimulationInputError('invalid-input', `${label} must contain exactly ${fields.join(', ')}`);
    }
    return value as Record<string, unknown>;
}

export function dataArray(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): unknown[] {
    if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new SimulationInputError('invalid-input', `${label} must be a bounded dense array`);
    }
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) {
            throw new SimulationInputError('invalid-input', `${label} must contain data properties only`);
        }
    }
    return value;
}

function opponent(value: unknown): OpponentDefinition {
    const data = dataObject(value, [
        'pokemonId', 'health', 'autoAttackDamage', 'moneyReward', 'experienceReward',
        'dungeonTokenReward', 'captureProbability', 'captureDurationMs',
    ], 'opponent');
    if (typeof data.pokemonId !== 'number' || !Number.isFinite(data.pokemonId)
        || data.pokemonId <= 0 || data.pokemonId > Number.MAX_SAFE_INTEGER) {
        throw new SimulationInputError('invalid-input', 'pokemonId must be a positive finite catalog ID');
    }
    if (typeof data.captureProbability !== 'number' || !Number.isFinite(data.captureProbability)
        || data.captureProbability < 0 || data.captureProbability > 1) {
        throw new SimulationInputError('invalid-input', 'captureProbability must be between 0 and 1');
    }
    return Object.freeze({
        pokemonId: data.pokemonId,
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

function route(value: unknown): CombatRoute {
    const data = dataObject(value, ['location', 'opponents', 'unlocked'], 'route');
    if (!Array.isArray(data.opponents) || data.opponents.length === 0 || typeof data.unlocked !== 'boolean') {
        throw new SimulationInputError('invalid-input', 'Expected a nonempty opponent list and boolean unlocked');
    }
    const opponents = Array.from(dataArray(data.opponents, 'opponents'), opponent);
    if (new Set(opponents.map(entry => entry.pokemonId)).size !== opponents.length) {
        throw new SimulationInputError('invalid-input', 'Opponent catalog IDs must be unique within a route');
    }
    return Object.freeze({
        location: validateLocation(data.location),
        opponents: Object.freeze(opponents),
        unlocked: data.unlocked,
    });
}

export function validateScenario(value: unknown): CombatScenario {
    const data = dataObject(value, ['initialLocation', 'routes', 'clickAttackDamage', 'clickAttacksAllowed', 'initialPokeballs'], 'scenario');
    if (!Array.isArray(data.routes) || data.routes.length === 0 || typeof data.clickAttacksAllowed !== 'boolean') {
        throw new SimulationInputError('invalid-input', 'Expected a nonempty route list and boolean clickAttacksAllowed');
    }
    const routes = Array.from(dataArray(data.routes, 'routes'), route);
    if (new Set(routes.map(entry => routeKey(entry.location))).size !== routes.length) {
        throw new SimulationInputError('invalid-input', 'Route locations must be unique');
    }
    const initialLocation = validateLocation(data.initialLocation);
    if (!findRoute(routes, initialLocation)?.unlocked) {
        throw new SimulationInputError('invalid-input', 'Initial location must resolve to an unlocked route');
    }
    return Object.freeze({
        initialLocation,
        routes: Object.freeze(routes),
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
