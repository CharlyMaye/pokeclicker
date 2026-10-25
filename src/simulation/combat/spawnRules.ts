import type { RouteReference } from '../../contracts/combat-protocol';
import { calculateEncounterRules, EncounterRulesPolicy, finiteRuleNumber, parseEncounterRulesPolicy } from '../content/encounterPolicy';
import { catalogId, dataArray, dataObject, safeInteger, validateLocation } from './input';
import { CombatRoute, CombatScenario, OpponentDefinition, SimulationInputError } from './model';
import { routeKey } from './routes';

export interface SpawnSample { readonly catchVariation: number; readonly moneyDeviation: number }
export interface SpawnInputs {
    readonly normalizedRoute: number; readonly baseCatchRate: number; readonly pokeballBonus: number;
    readonly oakBonus: number; readonly captureDurationMs: number; readonly moneyMultiplier: number; readonly tokenMultiplier: number;
}
export interface SpawnRules {
    readonly policy: EncounterRulesPolicy;
    readonly opponents: readonly Readonly<{ location: RouteReference; pokemonId: number; inputs: SpawnInputs }>[];
}
const key = (location: RouteReference, id: number) => `${routeKey(location)}:${id}`;

export function validateSpawnRules(value: unknown, routes: readonly CombatRoute[]): SpawnRules {
    const data = dataObject(value, ['policy', 'opponents'], 'spawn rules');
    const policy = parseEncounterRulesPolicy(data.policy);
    safeInteger(policy.catchVariationMax - policy.catchVariationMin + 1, 'catch variation interval', 1);
    safeInteger(policy.moneyDeviationMax - policy.moneyDeviationMin + 1, 'money deviation interval', 1);
    const required = new Set(routes.flatMap(route => route.opponents.map(p => key(route.location, p.pokemonId))));
    const opponents = Array.from(dataArray(data.opponents, 'spawn profiles', required.size), input => {
        const profile = dataObject(input, ['location', 'pokemonId', 'inputs'], 'spawn profile');
        const location = validateLocation(profile.location);
        const pokemonId = catalogId(profile.pokemonId);
        if (!required.delete(key(location, pokemonId))) {
            throw new SimulationInputError('invalid-input', 'Unknown or duplicate spawn profile');
        }
        const fields = dataObject(profile.inputs, ['normalizedRoute', 'baseCatchRate', 'pokeballBonus', 'oakBonus', 'captureDurationMs', 'moneyMultiplier', 'tokenMultiplier'], 'spawn inputs');
        const inputs = Object.freeze({
            normalizedRoute: safeInteger(fields.normalizedRoute, 'normalizedRoute', 1),
            baseCatchRate: finiteRuleNumber(fields.baseCatchRate, 'baseCatchRate'),
            pokeballBonus: finiteRuleNumber(fields.pokeballBonus, 'pokeballBonus', -Number.MAX_SAFE_INTEGER),
            oakBonus: finiteRuleNumber(fields.oakBonus, 'oakBonus', -Number.MAX_SAFE_INTEGER),
            captureDurationMs: safeInteger(fields.captureDurationMs, 'captureDurationMs', 1),
            moneyMultiplier: finiteRuleNumber(fields.moneyMultiplier, 'moneyMultiplier'),
            tokenMultiplier: finiteRuleNumber(fields.tokenMultiplier, 'tokenMultiplier'),
        });
        // Check both monotonic range endpoints before creating a world.
        calculateEncounterRules({ ...inputs, catchVariation: policy.catchVariationMin, moneyDeviation: policy.moneyDeviationMin }, location.region, policy);
        calculateEncounterRules({ ...inputs, catchVariation: policy.catchVariationMax, moneyDeviation: policy.moneyDeviationMax }, location.region, policy);
        return Object.freeze({ location, pokemonId, inputs });
    });
    if (required.size) {
        throw new SimulationInputError('invalid-input', 'Missing spawn profiles');
    }
    return Object.freeze({ policy, opponents: Object.freeze(opponents) });
}

export function validateSpawnSample(value: unknown, policy: EncounterRulesPolicy): SpawnSample {
    const data = dataObject(value, ['catchVariation', 'moneyDeviation'], 'spawn sample');
    const catchVariation = safeInteger(data.catchVariation, 'catchVariation', policy.catchVariationMin);
    const moneyDeviation = safeInteger(data.moneyDeviation, 'moneyDeviation', policy.moneyDeviationMin);
    if (catchVariation > policy.catchVariationMax || moneyDeviation > policy.moneyDeviationMax) {
        throw new SimulationInputError('invalid-input', 'Spawn sample exceeds its configured range');
    }
    return Object.freeze({ catchVariation, moneyDeviation });
}

/** The caller supplies validated draws; exactly two are consumed, even for singleton intervals. */
export function sampleSpawn(rules: SpawnRules, draw: () => number): SpawnSample {
    const p = rules.policy;
    return validateSpawnSample({
        catchVariation: Math.floor(draw() * (p.catchVariationMax - p.catchVariationMin + 1) + p.catchVariationMin),
        moneyDeviation: Math.floor(draw() * (p.moneyDeviationMax - p.moneyDeviationMin + 1) + p.moneyDeviationMin),
    }, p);
}

export function resolveSpawnDefinition(scenario: CombatScenario, location: RouteReference, template: OpponentDefinition, sample: SpawnSample): OpponentDefinition {
    if ((scenario.formatVersion !== 3 && scenario.formatVersion !== 4)) {
        throw new SimulationInputError('invalid-input', 'Spawn samples require a sampled scenario');
    }
    const profile = scenario.spawnRules.opponents.find(entry => key(entry.location, entry.pokemonId) === key(location, template.pokemonId));
    if (!profile) {
        throw new SimulationInputError('invalid-input', 'Missing encounter spawn profile');
    }
    return Object.freeze({ ...template, ...calculateEncounterRules({ ...profile.inputs, ...validateSpawnSample(sample, scenario.spawnRules.policy) }, location.region, scenario.spawnRules.policy) });
}
