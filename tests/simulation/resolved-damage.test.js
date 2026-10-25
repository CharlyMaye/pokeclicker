import { describe, expect, it, vi } from 'vitest';
import { applyDamageSnapshot, calculateClickDamage, calculatePartyDamage } from '../../src/simulation/damage/resolveDamage';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import snapshot from '../fixtures/simulation/damage-snapshot.json';
import scenario from '../fixtures/simulation/weighted-encounters.json';
import uniform from '../fixtures/simulation/route-transitions.json';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
const party = () => structuredClone(snapshot.opponents[0].party);
const member = () => party().contributors[0];

describe('resolved damage calculations', () => {
    it('sums fractional contributions before multiplying and rounding the party total', () => {
        const input = party(); input.multiplier = 1.5;
        input.contributors = [1, 2].map(pokemonId => ({ ...member(), pokemonId, attack: 1, typeMultiplier: 0.3 }));
        expect(calculatePartyDamage(input)).toBe(1);
    });
    it('applies type, region, weather, flute and Z-move multipliers in order', () => {
        const input = party(); input.multiplier = 1.1;
        input.contributors[0] = { ...member(), attack: 100, typeMultiplier: 2, regionMultiplier: 0.2, weatherMultipliers: [1.1, 1.3], fluteMultipliers: [1.5, 1.5], zMoveMultiplier: 1.2 };
        expect(calculatePartyDamage(input)).toBe(Math.round(100 * 2 * 0.2 * 1.1 * 1.3 * 1.5 * 1.5 * 1.2 * 1.1));
        input.includeTempBonuses = false;
        expect(calculatePartyDamage(input)).toBe(Math.round(100 * 2 * 0.2 * 1.1 * 1.3 * 1.1));
    });
    it.each([[false, false, false, 0], [true, true, false, 0], [true, true, true, 10], [true, false, false, 10]])(
        'handles active=%s, breeding=%s, includeBreeding=%s', (active, breeding, includeBreeding, expected) => {
            const input = party(); Object.assign(input.contributors[0], { active, breeding, includeBreeding });
            expect(calculatePartyDamage(input)).toBe(expected);
        },
    );
    it('supports immunity, empty parties, zero bonuses and fractional catalog IDs', () => {
        expect(calculatePartyDamage({ ...party(), contributors: [] })).toBe(0);
        expect(calculatePartyDamage({ ...party(), multiplier: 0 })).toBe(0);
        const input = party(); input.contributors[0].pokemonId = 19.01; input.contributors[0].typeMultiplier = 0;
        expect(calculatePartyDamage(input)).toBe(0);
    });
    it('floors click damage after applying its explicit multiplier', () => {
        expect(calculateClickDamage({ baseAttack: 10.9, multiplier: 1.5 })).toBe(16);
        expect(calculateClickDamage({ baseAttack: 0, multiplier: 2 })).toBe(0);
    });
    it.each([
        ['negative attack', p => { p.contributors[0].attack = -1; }],
        ['NaN factor', p => { p.contributors[0].weatherMultipliers = [NaN]; }],
        ['infinite factor', p => { p.multiplier = Infinity; }],
        ['string factor', p => { p.multiplier = '2'; }],
        ['missing factor', p => { delete p.contributors[0].regionMultiplier; }],
        ['extra factor', p => { p.contributors[0].extraMultiplier = 2; }],
        ['duplicate member', p => { p.contributors.push(p.contributors[0]); }],
        ['nonboolean activity', p => { p.contributors[0].active = 1; }],
        ['sparse factors', p => { p.contributors[0].fluteMultipliers = new Array(2); }],
        ['invalid inactive member', p => { p.contributors[0].active = false; p.contributors[0].attack = NaN; }],
        ['invalid skipped bonus', p => { p.includeTempBonuses = false; p.contributors[0].zMoveMultiplier = -1; }],
        ['intermediate overflow', p => { p.contributors[0].attack = Number.MAX_SAFE_INTEGER; p.contributors[0].typeMultiplier = 2; }],
        ['sum overflow', p => { p.contributors = [1, 2].map(pokemonId => ({ ...member(), pokemonId, attack: Number.MAX_SAFE_INTEGER })); }],
    ])('rejects %s without mutating data', (_label, mutate) => {
        const input = party(); mutate(input); const original = structuredClone(input);
        expect(() => calculatePartyDamage(input)).toThrow(); expect(input).toEqual(original);
    });
    it('rejects accessors without invoking them', () => {
        const input = party(); const get = vi.fn(() => 10);
        Object.defineProperty(input.contributors[0], 'attack', { get });
        expect(() => calculatePartyDamage(input)).toThrow(); expect(get).not.toHaveBeenCalled();
    });
    it.each([-1, NaN, Infinity, '10'])('rejects invalid click input %s', baseAttack => {
        expect(() => calculateClickDamage({ baseAttack, multiplier: 1 })).toThrow();
    });
});

describe('complete scenario damage snapshots', () => {
    it('preserves weighted scenario data and detaches inputs', () => {
        const input = structuredClone(snapshot); const output = applyDamageSnapshot(scenario, input);
        expect(output).toEqual(scenario); input.opponents[0].party.multiplier = 999;
        expect(output).toEqual(scenario); expect(Object.isFrozen(output.routes[0].opponents[0])).toBe(true);
    });
    it('preserves the unversioned uniform scenario format', () => {
        const input = { ...snapshot, opponents: snapshot.opponents.filter(p => uniform.routes.some(r => r.location.region === p.location.region && r.location.route === p.location.route && r.opponents.some(o => o.pokemonId === p.pokemonId))) };
        expect(applyDamageSnapshot(uniform, input)).toEqual(uniform);
    });
    it.each([
        ['unknown version', s => { s.formatVersion = 2; }],
        ['missing profile', s => { s.opponents.pop(); }],
        ['duplicate profile', s => { s.opponents.push(s.opponents[0]); }],
        ['unknown opponent', s => { s.opponents[0].pokemonId = 999; }],
        ['unknown route', s => { s.opponents[0].location.route = 999; }],
    ])('rejects %s before replacing any damage', (_name, mutate) => {
        const input = structuredClone(snapshot); mutate(input); const original = structuredClone(scenario);
        expect(() => applyDamageSnapshot(scenario, input)).toThrow(); expect(scenario).toEqual(original);
    });
    it('retains resolved damage across save/restore and rejects changed damage', () => {
        const input = structuredClone(snapshot); input.opponents[0].party.multiplier = 2;
        const resolved = applyDamageSnapshot(scenario, input);
        const game = new RouteCombatSimulation('damage', { combat, simulation }, resolved, 123);
        game.advanceTo(1000); expect(game.snapshot.encounter.enemy.health).toBe(10);
        const saved = game.checkpoint();
        const resumed = new RouteCombatSimulation('damage', { combat, simulation }, resolved, 123, undefined, saved);
        for (let t = 1100; t <= 5000; t += 100) expect(resumed.advanceTo(t)).toEqual(game.advanceTo(t));
        expect(() => new RouteCombatSimulation('damage', { combat, simulation }, scenario, 123, undefined, saved)).toThrow('scenario');
    });
});
