import { CombatScenario, OpponentDefinition, RandomStep, SimulationInputError } from './model';

// Algorithm representation limit, not a gameplay setting.
export const MAX_RANDOM_STATE = 2 ** 32 - 1;

export function safeInteger(value: unknown, label: string, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
        throw new SimulationInputError('invalid-input', `${label} must be a safe integer >= ${minimum}`);
    }
    return value;
}

function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
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

function opponent(value: unknown): OpponentDefinition {
    const data = object(value, [
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

export function validateScenario(value: unknown): CombatScenario {
    const data = object(value, ['location', 'opponents', 'clickAttackDamage', 'clickAttacksAllowed', 'initialPokeballs'], 'scenario');
    const location = object(data.location, ['region', 'route'], 'location');
    if (!Array.isArray(data.opponents) || data.opponents.length === 0 || typeof data.clickAttacksAllowed !== 'boolean') {
        throw new SimulationInputError('invalid-input', 'Expected a nonempty opponent list and boolean clickAttacksAllowed');
    }
    const opponents = Array.from(data.opponents, opponent);
    if (new Set(opponents.map(entry => entry.pokemonId)).size !== opponents.length) {
        throw new SimulationInputError('invalid-input', 'Opponent catalog IDs must be unique');
    }
    return Object.freeze({
        location: Object.freeze({ region: safeInteger(location.region, 'region'), route: safeInteger(location.route, 'route', 1) }),
        opponents: Object.freeze(opponents),
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
