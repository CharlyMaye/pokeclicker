import { describe, expect, it, vi } from 'vitest';
import { applyEncounterSnapshot, calculateEncounterRules, parseEncounterRulesPolicy } from '../../src/simulation/content/encounterRules';
import { prepareRouteSession } from '../../src/simulation/content/prepareRouteSession';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import encounterPolicy from '../../public/config/encounter-rules.json';
import healthPolicy from '../../public/config/route-health.json';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import content from '../fixtures/simulation/route-content.json';
import damage from '../fixtures/simulation/damage-snapshot.json';
import encounters from '../fixtures/simulation/encounter-snapshot.json';
import scenario from '../fixtures/simulation/weighted-encounters.json';
const policy = parseEncounterRulesPolicy(encounterPolicy);
const inputs = () => structuredClone(encounters.opponents[0].inputs);
const preparation = () => structuredClone({ content, healthPolicy, damage, encounters, encounterPolicy });

describe('resolved encounter rules', () => {
    it('calculates route money, normal capture tokens and final catch probability', () => {
        expect(calculateEncounterRules(inputs(), 0, policy)).toEqual({ moneyReward: 15, dungeonTokenReward: 6, captureProbability: 0.38, captureDurationMs: 200 });
    });
    it('rounds the Amount base before applying the wallet bonus', () => {
        expect(calculateEncounterRules({ ...inputs(), normalizedRoute: 10, moneyDeviation: -25 }, 0, policy).moneyReward).toBe(114);
    });
    it('clamps catch rate before adding bonuses, and clamps again after bonuses', () => {
        expect(calculateEncounterRules({ ...inputs(), baseCatchRate: 0, catchVariation: -3, pokeballBonus: 5, oakBonus: 0 }, 0, policy).captureProbability).toBe(0.05);
        expect(calculateEncounterRules({ ...inputs(), baseCatchRate: 10000, pokeballBonus: -5, oakBonus: 0 }, 0, policy).captureProbability).toBe(0.95);
        expect(calculateEncounterRules({ ...inputs(), pokeballBonus: 100 }, 0, policy).captureProbability).toBe(1);
        expect(calculateEncounterRules({ ...inputs(), pokeballBonus: -100 }, 0, policy).captureProbability).toBe(0);
    });
    it('accepts zero wallet bonuses and preserves fractional catch bonuses', () => {
        const result = calculateEncounterRules({ ...inputs(), moneyMultiplier: 0, tokenMultiplier: 0, pokeballBonus: 0.5, oakBonus: 0.25 }, 0, policy);
        expect(result.moneyReward).toBe(0); expect(result.dungeonTokenReward).toBe(0); expect(result.captureProbability).toBe(0.3175);
    });
    it.each([
        ['missing variation', x => { delete x.catchVariation; }],
        ['out-of-range catch variation', x => { x.catchVariation = 4; }],
        ['fractional variation', x => { x.catchVariation = 0.5; }],
        ['out-of-range money deviation', x => { x.moneyDeviation = -26; }],
        ['invalid route', x => { x.normalizedRoute = 0; }],
        ['negative base rate', x => { x.baseCatchRate = -1; }],
        ['negative wallet bonus', x => { x.moneyMultiplier = -1; }],
        ['infinite wallet bonus', x => { x.tokenMultiplier = Infinity; }],
        ['overflow before bonus cancellation', x => { x.pokeballBonus = Number.MAX_SAFE_INTEGER; x.oakBonus = -Number.MAX_SAFE_INTEGER; }],
        ['NaN ball bonus', x => { x.pokeballBonus = NaN; }],
        ['missing duration', x => { delete x.captureDurationMs; }],
        ['zero duration', x => { x.captureDurationMs = 0; }],
        ['fractional duration', x => { x.captureDurationMs = 0.5; }],
        ['extra input', x => { x.random = 0.5; }],
        ['route growth overflow', x => { x.normalizedRoute = Number.MAX_SAFE_INTEGER; }],
        ['wallet multiplication overflow', x => { x.moneyMultiplier = Number.MAX_SAFE_INTEGER; }],
    ])('rejects %s without mutating the input', (_name, mutate) => {
        const input = inputs(); mutate(input); const original = structuredClone(input);
        expect(() => calculateEncounterRules(input, 0, policy)).toThrow(); expect(input).toEqual(original);
    });
    it('rejects accessors without invoking them', () => {
        const input = inputs(); const get = vi.fn(() => 0);
        Object.defineProperty(input, 'moneyDeviation', { get });
        expect(() => calculateEncounterRules(input, 0, policy)).toThrow(); expect(get).not.toHaveBeenCalled();
    });
    it.each([
        ['version', p => { p.schemaVersion = 2; }],
        ['missing coefficient', p => { delete p.tokenExponent; }],
        ['zero divisor', p => { p.tokenDivisor = 0; }],
        ['negative coefficient', p => { p.catchExponent = -1; }],
        ['infinite coefficient', p => { p.moneyScale = Infinity; }],
        ['reversed range', p => { p.catchVariationMin = 4; }],
        ['fractional range', p => { p.moneyDeviationMax = 1.5; }],
    ])('rejects policy %s', (_name, mutate) => {
        const input = structuredClone(encounterPolicy); mutate(input); expect(() => parseEncounterRulesPolicy(input)).toThrow();
    });
});

describe('route session preparation', () => {
    it('combines health, damage and encounter rules without changing experience or route eligibility', () => {
        const input = preparation(); input.damage.opponents[0].party.multiplier = 2;
        const result = prepareRouteSession(input);
        expect(result.routes[0].opponents[0]).toMatchObject({ health: 29, autoAttackDamage: 20, moneyReward: 15, experienceReward: 12, dungeonTokenReward: 6, captureProbability: 0.38 });
        expect(result.routes[3].unlocked).toBe(false);
        expect(Object.isFrozen(result.routes[0].opponents[0])).toBe(true);
        input.encounters.opponents[0].inputs.pokeballBonus = 100;
        expect(result.routes[0].opponents[0].captureProbability).toBe(0.38);
    });
    it.each([
        ['snapshot version', s => { s.formatVersion = 2; }],
        ['missing profile', s => { s.opponents.pop(); }],
        ['duplicate profile', s => { s.opponents.push(s.opponents[0]); }],
        ['unknown species', s => { s.opponents[0].pokemonId = 999; }],
        ['unknown route', s => { s.opponents[0].location.route = 999; }],
    ])('rejects %s without changing the source scenario', (_name, mutate) => {
        const input = structuredClone(encounters); mutate(input); const original = structuredClone(scenario);
        expect(() => applyEncounterSnapshot(scenario, input, encounterPolicy)).toThrow(); expect(scenario).toEqual(original);
    });
    it('requires every preparation input and makes invalid later stages atomic', () => {
        const input = preparation(); input.encounters.opponents[0].inputs.captureDurationMs = 0;
        const original = structuredClone(input);
        expect(() => prepareRouteSession(input)).toThrow(); expect(input).toEqual(original);
        delete input.encounterPolicy; expect(() => prepareRouteSession(input)).toThrow();
    });
    it('restores prepared rules exactly and rejects changed rewards or chance', () => {
        const prepared = prepareRouteSession(preparation());
        const game = new RouteCombatSimulation('prepared', { combat, simulation }, prepared, 123);
        game.advanceTo(3000); const saved = game.checkpoint();
        const restored = new RouteCombatSimulation('prepared', { combat, simulation }, prepared, 123, undefined, saved);
        for (let t = 3100; t <= 10000; t += 100) expect(restored.advanceTo(t)).toEqual(game.advanceTo(t));
        const changed = preparation(); changed.encounters.opponents[0].inputs.moneyMultiplier++;
        expect(() => new RouteCombatSimulation('prepared', { combat, simulation }, prepareRouteSession(changed), 123, undefined, saved)).toThrow('scenario');
    });
});
