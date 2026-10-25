import { catalogId, dataArray, dataObject, safeInteger } from '../combat/input';
import { CombatScenario, SimulationInputError } from '../combat/model';
import { routeKey } from '../combat/routes';
import { validateLocation, validateScenario } from '../combat/validation';

export interface EncounterRulesPolicy {
    readonly schemaVersion: 1;
    readonly moneyMinimum: number;
    readonly moneyLinear: number;
    readonly moneyScale: number;
    readonly moneyExponent: number;
    readonly moneyDeviationMin: number;
    readonly moneyDeviationMax: number;
    readonly tokenCurrencyRate: number;
    readonly tokenMinimum: number;
    readonly tokenScale: number;
    readonly tokenRouteScale: number;
    readonly tokenDivisor: number;
    readonly tokenRegionDivisor: number;
    readonly tokenExponent: number;
    readonly catchExponent: number;
    readonly catchVariationMin: number;
    readonly catchVariationMax: number;
}

function finite(value: unknown, label: string, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new SimulationInputError('invalid-input', `${label} must be finite and within the supported numeric range`);
    }
    return value;
}
function positive(value: unknown, label: string): number {
    const result = finite(value, label);
    if (result === 0) {
        throw new SimulationInputError('invalid-input', `${label} must be positive`);
    }
    return result;
}
function signedInteger(value: unknown, label: string): number {
    return safeInteger(value, label, -Number.MAX_SAFE_INTEGER);
}

export function parseEncounterRulesPolicy(value: unknown): EncounterRulesPolicy {
    const data = dataObject(value, [
        'schemaVersion', 'moneyMinimum', 'moneyLinear', 'moneyScale', 'moneyExponent', 'moneyDeviationMin', 'moneyDeviationMax',
        'tokenCurrencyRate', 'tokenMinimum', 'tokenScale', 'tokenRouteScale', 'tokenDivisor', 'tokenRegionDivisor', 'tokenExponent',
        'catchExponent', 'catchVariationMin', 'catchVariationMax',
    ], 'encounter rules policy');
    if (data.schemaVersion !== 1) {
        throw new SimulationInputError('invalid-input', 'Unsupported encounter rules policy version');
    }
    const policy = {
        schemaVersion: 1 as const,
        moneyMinimum: positive(data.moneyMinimum, 'moneyMinimum'), moneyLinear: positive(data.moneyLinear, 'moneyLinear'),
        moneyScale: positive(data.moneyScale, 'moneyScale'), moneyExponent: positive(data.moneyExponent, 'moneyExponent'),
        moneyDeviationMin: signedInteger(data.moneyDeviationMin, 'moneyDeviationMin'), moneyDeviationMax: signedInteger(data.moneyDeviationMax, 'moneyDeviationMax'),
        tokenCurrencyRate: positive(data.tokenCurrencyRate, 'tokenCurrencyRate'),
        tokenMinimum: positive(data.tokenMinimum, 'tokenMinimum'), tokenScale: positive(data.tokenScale, 'tokenScale'),
        tokenRouteScale: positive(data.tokenRouteScale, 'tokenRouteScale'), tokenDivisor: positive(data.tokenDivisor, 'tokenDivisor'),
        tokenRegionDivisor: positive(data.tokenRegionDivisor, 'tokenRegionDivisor'), tokenExponent: positive(data.tokenExponent, 'tokenExponent'),
        catchExponent: positive(data.catchExponent, 'catchExponent'),
        catchVariationMin: signedInteger(data.catchVariationMin, 'catchVariationMin'), catchVariationMax: signedInteger(data.catchVariationMax, 'catchVariationMax'),
    };
    if (policy.moneyDeviationMin > policy.moneyDeviationMax || policy.catchVariationMin > policy.catchVariationMax) {
        throw new SimulationInputError('invalid-input', 'Variation ranges must be ordered');
    }
    return Object.freeze(policy);
}

function variation(value: unknown, minimum: number, maximum: number, label: string): number {
    const result = signedInteger(value, label);
    if (result < minimum || result > maximum) {
        throw new SimulationInputError('invalid-input', `${label} is outside the configured range`);
    }
    return result;
}

/** Pure calculation for explicitly sampled inputs and a validated policy; consumes no randomness. */
export function calculateEncounterRules(value: unknown, region: number, policy: EncounterRulesPolicy) {
    safeInteger(region, 'region');
    const data = dataObject(value, [
        'normalizedRoute', 'baseCatchRate', 'catchVariation', 'moneyDeviation', 'pokeballBonus', 'oakBonus',
        'captureDurationMs', 'moneyMultiplier', 'tokenMultiplier',
    ], 'encounter rule inputs');
    const route = safeInteger(data.normalizedRoute, 'normalizedRoute', 1);
    const deviation = variation(data.moneyDeviation, policy.moneyDeviationMin, policy.moneyDeviationMax, 'moneyDeviation');
    const catchVariation = variation(data.catchVariation, policy.catchVariationMin, policy.catchVariationMax, 'catchVariation');
    const moneyBase = finite(Math.max(policy.moneyMinimum, policy.moneyLinear * route + policy.moneyScale * Math.pow(route, policy.moneyExponent) + deviation), 'base money');
    const tokenBase = finite(Math.max(policy.tokenMinimum, policy.tokenScale * Math.pow(route * policy.tokenRouteScale / (policy.tokenDivisor / (1 + region / policy.tokenRegionDivisor)), policy.tokenExponent)), 'base tokens');
    const baseChance = finite(Math.floor(Math.pow(finite(data.baseCatchRate, 'baseCatchRate'), policy.catchExponent)) + catchVariation, 'base chance', -Number.MAX_SAFE_INTEGER);
    // Percent-to-probability conversion is a representation rule, not a balance default.
    const clampedBaseChance = Math.max(0, Math.min(100, baseChance));
    const ballChance = finite(clampedBaseChance + finite(data.pokeballBonus, 'pokeballBonus', -Number.MAX_SAFE_INTEGER), 'ball chance', -Number.MAX_SAFE_INTEGER);
    const totalChance = finite(ballChance + finite(data.oakBonus, 'oakBonus', -Number.MAX_SAFE_INTEGER), 'total chance', -Number.MAX_SAFE_INTEGER);
    return Object.freeze({
        // Amount rounds the factory reward before Wallet multiplies and floors.
        moneyReward: safeInteger(Math.floor(finite(safeInteger(Math.round(moneyBase), 'base money amount', 1) * finite(data.moneyMultiplier, 'moneyMultiplier'), 'money reward')), 'money reward'),
        // Battle.gainTokens rounds up before Wallet applies its bonus and rounds down.
        dungeonTokenReward: safeInteger(Math.floor(finite(Math.ceil(tokenBase / policy.tokenCurrencyRate * policy.tokenCurrencyRate) * finite(data.tokenMultiplier, 'tokenMultiplier'), 'token reward')), 'token reward'),
        captureProbability: Math.max(0, Math.min(100, totalChance)) / 100,
        captureDurationMs: safeInteger(data.captureDurationMs, 'captureDurationMs', 1),
    });
}

export function applyEncounterSnapshot(scenarioValue: unknown, snapshotValue: unknown, policyValue: unknown): CombatScenario {
    const scenario = validateScenario(scenarioValue);
    const policy = parseEncounterRulesPolicy(policyValue);
    const snapshot = dataObject(snapshotValue, ['formatVersion', 'opponents'], 'encounter snapshot');
    if (snapshot.formatVersion !== 1) {
        throw new SimulationInputError('invalid-input', 'Unsupported encounter snapshot version');
    }
    const profiles = new Map<string, ReturnType<typeof calculateEncounterRules>>();
    const key = (location: { region: number; route: number }, id: number) => `${routeKey(location)}:${id}`;
    for (const input of dataArray(snapshot.opponents, 'encounter profiles')) {
        const profile = dataObject(input, ['location', 'pokemonId', 'inputs'], 'encounter profile');
        const location = validateLocation(profile.location);
        const id = key(location, catalogId(profile.pokemonId));
        if (profiles.has(id)) {
            throw new SimulationInputError('invalid-input', 'Duplicate encounter profile');
        }
        profiles.set(id, calculateEncounterRules(profile.inputs, location.region, policy));
    }
    const routes = scenario.routes.map(route => ({ ...route, opponents: route.opponents.map(opponent => {
        const id = key(route.location, opponent.pokemonId);
        const rules = profiles.get(id);
        if (!rules) {
            throw new SimulationInputError('invalid-input', 'Missing encounter profile');
        }
        profiles.delete(id);
        return { ...opponent, ...rules };
    }) }));
    if (profiles.size) {
        throw new SimulationInputError('invalid-input', 'Unknown encounter profile');
    }
    return validateScenario({ ...scenario, routes });
}
