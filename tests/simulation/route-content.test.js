import { describe, expect, it, vi } from 'vitest';
import { compileRouteScenario } from '../../src/simulation/content/compileRouteScenario';
import { parseRouteHealthPolicy, calculateRouteHealth } from '../../src/simulation/content/routeHealth';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import content from '../fixtures/simulation/route-content.json';
import policy from '../../public/config/route-health.json';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';

const compile = value => compileRouteScenario(value, policy);

describe('route content compiler', () => {
    it('builds eligible weighted opponents using all unique pool species for average health', () => {
        const result = compile(content);
        expect(result.formatVersion).toBe(2);
        expect(result.routes[0].opponents.map(p => [p.pokemonId, p.health])).toEqual([[16, 29], [16.01, 29]]);
        expect(result.routes[0].encounters).toEqual([{ pokemonId: 16, weight: 1 }, { pokemonId: 16.01, weight: 2.5 }, { pokemonId: 16, weight: 0.5 }]);
        expect(result.routes[0].opponents[1].moneyReward).toBe(content.routes[0].catalog[1].combat.moneyReward);
        expect(Object.isFrozen(result.routes[0].opponents[0])).toBe(true);
    });
    it('keeps health stable when eligibility changes, while changing the weighted pool', () => {
        const changed = structuredClone(content); changed.routes[0].pools.special[2].available = true;
        expect(compile(changed).routes[0].opponents.slice(0, 2)).toEqual(compile(content).routes[0].opponents);
        expect(compile(changed).routes[0].opponents).toHaveLength(3);
    });
    it('deduplicates species for averages but retains every selection interval', () => {
        const changed = structuredClone(content); changed.routes[0].pools.land.push(16);
        expect(compile(changed).routes[0].opponents).toEqual(compile(content).routes[0].opponents);
        expect(compile(changed).routes[0].encounters).toHaveLength(4);
    });
    it('is independent of catalog order and does not retain caller data', () => {
        const changed = structuredClone(content); changed.routes[0].catalog.reverse();
        const result = compile(changed);
        expect(result.routes[0].opponents.map(p => p.health)).toEqual([29, 29]);
        changed.routes[0].catalog[0].baseHealth = 1;
        expect(result).toEqual(compile({ ...content, routes: content.routes.map((r, i) => i ? r : { ...r, catalog: [...r.catalog].reverse() }) }));
    });
    it('runs and resumes the compiled scenario without consulting source data again', () => {
        const scenario = compile(content);
        const game = new RouteCombatSimulation('content', { combat, simulation }, scenario, 123);
        game.advanceTo(3000);
        const saved = JSON.parse(JSON.stringify(game.checkpoint()));
        const restored = new RouteCombatSimulation('content', { combat, simulation }, scenario, 123, undefined, saved);
        for (let t = 3100; t <= 10000; t += 100) expect(restored.advanceTo(t)).toEqual(game.advanceTo(t));
        expect(restored.checkpoint()).toEqual(game.checkpoint());
    });
    it('rejects a compiled health revision when restoring a checkpoint', () => {
        const scenario = compile(content);
        const game = new RouteCombatSimulation('content', { combat, simulation }, scenario, 123);
        const changed = structuredClone(content); changed.routes[0].healthOverride++;
        expect(() => new RouteCombatSimulation('content', { combat, simulation }, compile(changed), 123, undefined, game.checkpoint())).toThrow('scenario');
    });
    it.each([
        ['version', s => { s.formatVersion = 2; }],
        ['missing policy input', s => { delete s.routes[0].healthOverride; }],
        ['zero override', s => { s.routes[0].healthOverride = 0; }],
        ['fractional override', s => { s.routes[0].healthOverride = 1.5; }],
        ['zero normalized route', s => { s.routes[0].normalizedRoute = 0; }],
        ['overflowing formula', s => { s.routes[0].normalizedRoute = Number.MAX_SAFE_INTEGER; s.routes[0].healthOverride = null; }],
        ['missing unavailable species', s => { s.routes[0].catalog.pop(); }],
        ['duplicate species', s => { s.routes[0].catalog.push(s.routes[0].catalog[0]); }],
        ['unreferenced species', s => { s.routes[0].catalog.push({ ...s.routes[0].catalog[0], pokemonId: 999 }); }],
        ['invalid unavailable combat stats', s => { s.routes[0].catalog[2].combat.moneyReward = -1; }],
        ['missing damage input', s => { delete s.routes[0].catalog[0].combat.autoAttackDamage; }],
        ['zero base health', s => { s.routes[0].catalog[0].baseHealth = 0; }],
        ['overflowing average sum', s => { s.routes[0].catalog.forEach(p => { p.baseHealth = Number.MAX_SAFE_INTEGER; }); }],
        ['nonboolean unlock', s => { s.routes[0].unlocked = 1; }],
        ['empty routes', s => { s.routes = []; }],
        ['unknown route property', s => { s.routes[0].health = 30; }],
    ])('rejects %s without modifying the input', (_name, mutate) => {
        const input = structuredClone(content); mutate(input); const before = structuredClone(input);
        expect(() => compile(input)).toThrow(); expect(input).toEqual(before);
    });
    it('rejects base stat accessors without invoking them', () => {
        const input = structuredClone(content); const getter = vi.fn(() => 40);
        Object.defineProperty(input.routes[0].catalog[0], 'baseHealth', { get: getter });
        expect(() => compile(input)).toThrow(); expect(getter).not.toHaveBeenCalled();
    });
});

describe('route health policy', () => {
    it.each([0, -1, NaN, Infinity, '10', null])('rejects invalid coefficient %s', value => {
        expect(() => parseRouteHealthPolicy({ ...policy, speciesDivisor: value })).toThrow();
    });
    it('requires an explicit exact supported policy and freezes it', () => {
        expect(() => parseRouteHealthPolicy({ ...policy, schemaVersion: 2 })).toThrow();
        expect(() => parseRouteHealthPolicy({ ...policy, extra: true })).toThrow();
        const input = { ...policy }; delete input.regionDivisor;
        expect(() => parseRouteHealthPolicy(input)).toThrow();
        expect(Object.isFrozen(parseRouteHealthPolicy(policy))).toBe(true);
    });
    it('uses overrides before exponential growth while rejecting invalid resolved positions', () => {
        expect(calculateRouteHealth(Number.MAX_SAFE_INTEGER, 0, 300, parseRouteHealthPolicy(policy))).toBe(300);
        expect(() => calculateRouteHealth(0, 0, 300, parseRouteHealthPolicy(policy))).toThrow();
    });
});
