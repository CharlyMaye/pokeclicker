import { describe, expect, it, vi } from 'vitest';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import { parseCombatCheckpoint } from '../../src/simulation/combat/checkpoint';
import { validateScenario, xorshift32 } from '../../src/simulation/combat/validation';
import { prepareSampledRouteSession } from '../../src/simulation/content/prepareSampledRouteSession';
import { applyEncounterSnapshot } from '../../src/simulation/content/encounterRules';
import content from '../fixtures/simulation/route-content.json';
import damage from '../fixtures/simulation/damage-snapshot.json';
import profiles from '../fixtures/simulation/spawn-profiles.json';
import weighted from '../fixtures/simulation/weighted-encounters.json';
import healthPolicy from '../../public/config/route-health.json';
import policy from '../../public/config/encounter-rules.json';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
const configuration = { combat, simulation };
const definition = () => prepareSampledRouteSession({ content, damage, healthPolicy, spawnRules: { policy, opponents: profiles } });
const create = (scenario = definition(), random, checkpoint) => new RouteCombatSimulation('spawn', configuration, scenario, 123, random, checkpoint);
const click = (sequence, atMs) => ({ protocolVersion: 1, sessionId: 'spawn', sequence, atMs, type: 'ClickAttack' });
function prepared() {
    const game = create();
    [50, 100, 150].forEach((atMs, i) => game.submit(click(i + 1, atMs)));
    game.submit({ ...click(4, 200), type: 'ChangeRoute', destination: { region: 0, route: 2 } });
    return game;
}

describe('versioned spawn sampling', () => {
    it('consumes opponent, catch variation and money draws in order on every spawn', () => {
        const input = structuredClone(definition()); input.initialPokeballs = 0; input.clickAttackDamage = 100;
        const draws = [0, 0, 1 - Number.EPSILON, 0, 1 - Number.EPSILON, 0];
        const random = vi.fn(state => ({ state: state + 1, value: draws.shift() }));
        const game = create(input, random);
        expect(random).toHaveBeenCalledTimes(3); expect(game.randomState).toBe(126);
        game.submit(click(1, 50)); game.advanceTo(100);
        expect(game.progress.money).toBe(49); expect(random).toHaveBeenCalledTimes(6);
        expect(game.randomState).toBe(129);
    });
    it('records exactly the first three seeded draws and restores without drawing again', () => {
        const game = create(); const first = xorshift32(123), second = xorshift32(first.state), third = xorshift32(second.state);
        const saved = game.checkpoint();
        expect(saved.formatVersion).toBe(2);
        expect(saved.spawnSample).toEqual({ catchVariation: Math.floor(second.value * 7 - 3), moneyDeviation: Math.floor(third.value * 51 - 25) });
        expect(saved.randomState).toBe(third.state);
        expect(create(definition(), undefined, saved).checkpoint()).toEqual(saved);
    });
    it('still consumes two draws for singleton variation intervals', () => {
        const input = structuredClone(definition());
        Object.assign(input.spawnRules.policy, { catchVariationMin: 0, catchVariationMax: 0, moneyDeviationMin: 2, moneyDeviationMax: 2 });
        const random = vi.fn(state => ({ state: state + 1, value: 0.25 }));
        create(input, random); expect(random).toHaveBeenCalledTimes(3);
    });
    it('keeps legacy weighted sampling and checkpoint shape unchanged', () => {
        const game = create(weighted); const saved = game.checkpoint();
        expect(saved.formatVersion).toBe(1); expect(Object.hasOwn(saved, 'spawnSample')).toBe(false);
        expect(saved.randomState).toBe(xorshift32(123).state);
        expect(create(weighted, undefined, saved).checkpoint()).toEqual(saved);
    });
    it('freezes copied rules, profiles and saved samples', () => {
        const input = structuredClone(definition()); const game = create(input); const saved = game.checkpoint();
        input.spawnRules.opponents[0].inputs.baseCatchRate = 0;
        expect(saved.scenario.spawnRules.opponents[0].inputs.baseCatchRate).toBe(100);
        expect(Object.isFrozen(saved.spawnSample)).toBe(true); expect(Object.isFrozen(saved.scenario.spawnRules.policy)).toBe(true);
    });
    it('rejects resolved snapshot application instead of silently ignoring it', () => {
        expect(() => applyEncounterSnapshot(definition(), {}, policy)).toThrow('sampled');
    });
    it.each([0, 100, 200, 300, 400, 1000, 3000])('continues identically after checkpointing at %i ms', time => {
        const game = prepared(); game.advanceTo(time); const saved = JSON.parse(JSON.stringify(game.checkpoint()));
        const resumed = create(definition(), undefined, saved);
        if (time === 300) {
            expect(saved.snapshot.encounter.phase).toBe('capturing'); expect(saved.sourceLocation.route).toBe(1); expect(saved.snapshot.location.route).toBe(2);
        }
        for (let target = time + 100; target <= time + 15000; target += 100) expect(resumed.advanceTo(target)).toEqual(game.advanceTo(target));
        expect(resumed.checkpoint()).toEqual(game.checkpoint());
    });
    it('uses sampled profile duration when validating and restoring a pending capture', () => {
        const input = structuredClone(definition()); input.spawnRules.opponents[0].inputs.captureDurationMs = 1250;
        const game = create(input); [50, 100, 150].forEach((t, i) => game.submit(click(i + 1, t))); game.advanceTo(300);
        const saved = game.checkpoint(); expect(saved.snapshot.encounter.resolvesAtMs).toBe(1400);
        expect(create(input, undefined, saved).checkpoint()).toEqual(saved);
    });
    it('fails a step atomically if a later spawn draw is invalid', () => {
        const input = structuredClone(definition()); input.initialPokeballs = 0; input.clickAttackDamage = 100;
        let calls = 0; const random = state => ({ state: state + 1, value: ++calls === 6 ? NaN : 0.5 });
        const game = create(input, random); const before = game.snapshot, progress = game.progress, state = game.randomState;
        game.submit(click(1, 50)); expect(() => game.advanceTo(100)).toThrow('Simulation stopped');
        expect(game.snapshot).toEqual(before); expect(game.progress).toEqual(progress); expect(game.randomState).toBe(state);
    });
    it.each([
        ['missing rules', s => { delete s.spawnRules; }],
        ['wrong version', s => { s.formatVersion = 2; }],
        ['missing profile', s => { s.spawnRules.opponents.pop(); }],
        ['duplicate profile', s => { s.spawnRules.opponents[1] = s.spawnRules.opponents[0]; }],
        ['unknown opponent', s => { s.spawnRules.opponents[0].pokemonId = 999; }],
        ['pre-sampled field', s => { s.spawnRules.opponents[0].inputs.catchVariation = 1; }],
        ['overflowing interval', s => { s.spawnRules.policy.moneyDeviationMin = -Number.MAX_SAFE_INTEGER; s.spawnRules.policy.moneyDeviationMax = Number.MAX_SAFE_INTEGER; }],
        ['invalid inactive route profile', s => { s.spawnRules.opponents[6].inputs.moneyMultiplier = -1; }],
    ])('rejects %s before drawing', (_name, mutate) => {
        const input = structuredClone(definition()); mutate(input); const random = vi.fn(state => ({ state, value: 0 }));
        expect(() => create(input, random)).toThrow(); expect(random).not.toHaveBeenCalled();
    });
    it.each([
        ['missing sample', s => { delete s.spawnSample; }],
        ['extra sample field', s => { s.spawnSample.draw = 0.5; }],
        ['out-of-range money', s => { s.spawnSample.moneyDeviation = 26; }],
        ['fractional catch variation', s => { s.spawnSample.catchVariation = 0.5; }],
        ['downgraded version', s => { s.formatVersion = 1; }],
        ['mismatched scenario', s => { s.scenario = weighted; }],
    ])('rejects checkpoint %s', (_name, mutate) => {
        const saved = JSON.parse(JSON.stringify(create().checkpoint())); mutate(saved);
        expect(() => parseCombatCheckpoint(saved)).toThrow();
    });
    it('rejects changed policy or profile when restoring without a migration', () => {
        const saved = create().checkpoint(); const input = structuredClone(definition()); input.spawnRules.policy.moneyDeviationMax++;
        expect(() => create(input, undefined, saved)).toThrow('scenario');
        expect(() => create(definition(), undefined, create(weighted).checkpoint())).toThrow('scenario');
    });
    it('rejects sample and rules accessors without executing them', () => {
        const get = vi.fn(() => 0); const saved = JSON.parse(JSON.stringify(create().checkpoint()));
        Object.defineProperty(saved.spawnSample, 'catchVariation', { get });
        expect(() => parseCombatCheckpoint(saved)).toThrow(); expect(get).not.toHaveBeenCalled();
        const input = structuredClone(definition()); Object.defineProperty(input, 'spawnRules', { get });
        expect(() => validateScenario(input)).toThrow(); expect(get).not.toHaveBeenCalled();
    });
});
