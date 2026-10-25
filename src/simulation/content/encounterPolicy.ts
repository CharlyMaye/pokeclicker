import { dataObject, safeInteger } from '../combat/input';
import { SimulationInputError } from '../combat/model';

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

export function finiteRuleNumber(value: unknown, label: string, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new SimulationInputError('invalid-input', `${label} must be finite and within the supported numeric range`);
    }
    return value;
}
function positive(value: unknown, label: string): number {
    const result = finiteRuleNumber(value, label);
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
    const moneyBase = finiteRuleNumber(Math.max(policy.moneyMinimum, policy.moneyLinear * route + policy.moneyScale * Math.pow(route, policy.moneyExponent) + deviation), 'base money');
    const tokenBase = finiteRuleNumber(Math.max(policy.tokenMinimum, policy.tokenScale * Math.pow(route * policy.tokenRouteScale / (policy.tokenDivisor / (1 + region / policy.tokenRegionDivisor)), policy.tokenExponent)), 'base tokens');
    const baseChance = finiteRuleNumber(Math.floor(Math.pow(finiteRuleNumber(data.baseCatchRate, 'baseCatchRate'), policy.catchExponent)) + catchVariation, 'base chance', -Number.MAX_SAFE_INTEGER);
    // Percent-to-probability conversion is a representation rule, not a balance default.
    const clampedBaseChance = Math.max(0, Math.min(100, baseChance));
    const ballChance = finiteRuleNumber(clampedBaseChance + finiteRuleNumber(data.pokeballBonus, 'pokeballBonus', -Number.MAX_SAFE_INTEGER), 'ball chance', -Number.MAX_SAFE_INTEGER);
    const totalChance = finiteRuleNumber(ballChance + finiteRuleNumber(data.oakBonus, 'oakBonus', -Number.MAX_SAFE_INTEGER), 'total chance', -Number.MAX_SAFE_INTEGER);
    return Object.freeze({
        // Amount rounds the factory reward before Wallet multiplies and floors.
        moneyReward: safeInteger(Math.floor(finiteRuleNumber(safeInteger(Math.round(moneyBase), 'base money amount', 1) * finiteRuleNumber(data.moneyMultiplier, 'moneyMultiplier'), 'money reward')), 'money reward'),
        // Battle.gainTokens rounds up before Wallet applies its bonus and rounds down.
        dungeonTokenReward: safeInteger(Math.floor(finiteRuleNumber(Math.ceil(tokenBase / policy.tokenCurrencyRate * policy.tokenCurrencyRate) * finiteRuleNumber(data.tokenMultiplier, 'tokenMultiplier'), 'token reward')), 'token reward'),
        captureProbability: Math.max(0, Math.min(100, totalChance)) / 100,
        captureDurationMs: safeInteger(data.captureDurationMs, 'captureDurationMs', 1),
    });
}
