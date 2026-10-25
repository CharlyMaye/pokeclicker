import { describe, expect, it, vi } from 'vitest';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import { validateScenario } from '../../src/simulation/combat/validation';
import { resolveRouteEncounterPools, validateEncounterTable } from '../../src/simulation/combat/encounters';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import weighted from '../fixtures/simulation/weighted-encounters.json';
import uniform from '../fixtures/simulation/route-transitions.json';
import pools from '../fixtures/simulation/encounter-pools.json';

const config = { combat, simulation };
const create = (scenario = weighted, random, checkpoint) => new RouteCombatSimulation('weighted', config, scenario, 123, random, checkpoint);
const access = { waterUnlocked: true, includeHeadbutt: true };

describe('versioned encounter selection', () => {
    it.each([[0, 16], [0.25, 16], [0.25 + Number.EPSILON, 16.01], [0.875, 16.01], [0.875 + Number.EPSILON, 16], [1 - Number.EPSILON, 16]])(
        'selects the expected ordered interval for draw %s', (value, pokemonId) => {
            const random = vi.fn(state => ({ state, value }));
            expect(create(weighted, random).snapshot.encounter.enemy.pokemonId).toBe(pokemonId);
            expect(random).toHaveBeenCalledTimes(1);
        },
    );

    it('preserves uniform floor selection and unversioned serialized data', () => {
        const input = structuredClone(uniform);
        input.routes[0].opponents = weighted.routes[0].opponents;
        expect(validateScenario(input)).toEqual(input);
        expect(Object.hasOwn(validateScenario(input), 'formatVersion')).toBe(false);
        expect(create(input, state => ({ state, value: 0.5 })).snapshot.encounter.enemy.pokemonId).toBe(16.01);
        const game = create(input);
        expect(create(input, undefined, JSON.parse(JSON.stringify(game.checkpoint()))).checkpoint()).toEqual(game.checkpoint());
    });

    it('retains the legacy inclusive zero-weight boundary at a zero draw', () => {
        const input = structuredClone(weighted);
        input.routes[0].encounters = [{ pokemonId: 16, weight: 0 }, { pokemonId: 16.01, weight: 1 }];
        expect(create(input, state => ({ state, value: 0 })).snapshot.encounter.enemy.pokemonId).toBe(16);
        expect(create(input, state => ({ state, value: Number.EPSILON })).snapshot.encounter.enemy.pokemonId).toBe(16.01);
    });

    it('copies and freezes tables without merging duplicate intervals', () => {
        const input = structuredClone(weighted);
        const parsed = validateScenario(input);
        input.routes[0].encounters[0].weight = 999;
        expect(parsed).toEqual(weighted);
        expect(Object.isFrozen(parsed.routes[0].encounters)).toBe(true);
        expect(Object.isFrozen(parsed.routes[0].encounters[0])).toBe(true);
        expect(parsed.routes[0].encounters.map(entry => entry.pokemonId)).toEqual([16, 16.01, 16]);
    });

    it.each([
        ['unknown version', s => { s.formatVersion = 3; }],
        ['missing version', s => { delete s.formatVersion; }],
        ['missing table', s => { delete s.routes[0].encounters; }],
        ['empty table', s => { s.routes[0].encounters = []; }],
        ['unknown ID', s => { s.routes[0].encounters[0].pokemonId = 999; }],
        ['unused definition', s => { s.routes[0].encounters = [{ pokemonId: 16, weight: 1 }]; }],
        ['negative weight', s => { s.routes[0].encounters[0].weight = -1; }],
        ['infinite weight', s => { s.routes[0].encounters[0].weight = Infinity; }],
        ['NaN weight', s => { s.routes[0].encounters[0].weight = NaN; }],
        ['string weight', s => { s.routes[0].encounters[0].weight = '1'; }],
        ['all zero weights', s => { s.routes[0].encounters.forEach(e => { e.weight = 0; }); }],
        ['overflow', s => { s.routes[0].encounters.forEach(e => { e.weight = Number.MAX_VALUE; }); }],
        ['lost positive interval', s => { s.routes[0].encounters[0].weight = Number.MAX_VALUE; }],
        ['sparse table', s => { delete s.routes[0].encounters[0]; }],
        ['extra entry field', s => { s.routes[0].encounters[0].chance = 1; }],
        ['extra scenario field', s => { s.defaultWeight = 1; }],
    ])('rejects %s before drawing random state', (_name, mutate) => {
        const input = structuredClone(weighted); mutate(input);
        const random = vi.fn(state => ({ state, value: 0 }));
        expect(() => create(input, random)).toThrow();
        expect(random).not.toHaveBeenCalled();
    });

    it('does not execute version or weight accessors', () => {
        for (const version of [true, false]) {
            const input = structuredClone(weighted);
            const getter = vi.fn(() => 2);
            Object.defineProperty(version ? input : input.routes[0].encounters[0], version ? 'formatVersion' : 'weight', { get: getter });
            expect(() => validateScenario(input)).toThrow();
            expect(getter).not.toHaveBeenCalled();
        }
    });

    it.each([0, 100, 200, 300, 400, 3000])('restores weighted RNG, pending capture and route commands at %i ms', time => {
        const game = create();
        [50, 100, 150].forEach((atMs, index) => game.submit({ protocolVersion: 1, sessionId: 'weighted', type: 'ClickAttack', sequence: index + 1, atMs }));
        game.submit({ protocolVersion: 1, sessionId: 'weighted', type: 'ChangeRoute', sequence: 4, atMs: 200, destination: { region: 0, route: 2 } });
        game.advanceTo(time);
        const checkpoint = JSON.parse(JSON.stringify(game.checkpoint()));
        const restored = create(weighted, undefined, checkpoint);
        for (let target = time + 100; target <= time + 15000; target += 100) {
            expect(restored.advanceTo(target)).toEqual(game.advanceTo(target));
        }
        expect(restored.checkpoint()).toEqual(game.checkpoint());
    });

    it('rejects changed weights, interval ordering and uniform/weighted checkpoint substitution', () => {
        const checkpoint = create().checkpoint();
        for (const mutate of [s => { s.routes[0].encounters[0].weight++; }, s => { s.routes[0].encounters.reverse(); }]) {
            const input = structuredClone(weighted); mutate(input);
            expect(() => create(input, undefined, checkpoint)).toThrow('scenario');
        }
        expect(() => create(uniform, undefined, checkpoint)).toThrow('scenario');
        expect(() => create(weighted, undefined, create(uniform).checkpoint())).toThrow('scenario');
    });
});

describe('resolved route encounter pools', () => {
    it('keeps land, water, headbutt and special order, duplicate IDs and explicit weights', () => {
        expect(resolveRouteEncounterPools(pools, access)).toEqual([
            { pokemonId: 16, weight: 1 }, { pokemonId: 19, weight: 1 },
            { pokemonId: 129, weight: 1 }, { pokemonId: 16, weight: 1 }, { pokemonId: 10, weight: 1 },
            { pokemonId: 19, weight: 0.5 }, { pokemonId: 19.01, weight: 0.5 },
        ]);
    });

    it('uses water without a rod only when the land pool is empty', () => {
        const restricted = { waterUnlocked: false, includeHeadbutt: false };
        expect(resolveRouteEncounterPools(pools, restricted).map(e => e.pokemonId)).toEqual([16, 19, 19, 19.01]);
        expect(resolveRouteEncounterPools({ ...pools, land: [] }, restricted).map(e => e.pokemonId)).toEqual([129, 16, 19, 19.01]);
    });

    it('does not retain mutable pool inputs or default missing eligibility', () => {
        const input = structuredClone(pools);
        const resolved = resolveRouteEncounterPools(input, access);
        input.land[0] = 99; input.special[0].weight = 99;
        expect(resolved).toEqual(resolveRouteEncounterPools(pools, access));
        expect(Object.isFrozen(resolved[0])).toBe(true);
        expect(() => resolveRouteEncounterPools(pools, { waterUnlocked: true })).toThrow();
    });

    it.each([
        ['missing ordinary weight', p => { delete p.ordinaryWeight; }],
        ['invalid unavailable group', p => { p.special[1].weight = NaN; }],
        ['invalid unavailable ID', p => { p.special[1].pokemonIds = [-1]; }],
        ['nonboolean availability', p => { p.special[0].available = 1; }],
        ['executable requirement', p => { p.special[0].req = () => true; }],
        ['empty eligible pool', p => { p.land = []; p.water = []; p.headbutt = []; p.special = []; }],
    ])('rejects %s', (_name, mutate) => {
        const input = structuredClone(pools); mutate(input);
        expect(() => resolveRouteEncounterPools(input, access)).toThrow();
    });

    it('accepts finite fractional weights and catalog forms', () => {
        expect(validateEncounterTable([{ pokemonId: 19.01, weight: 0.25 }])).toEqual([{ pokemonId: 19.01, weight: 0.25 }]);
    });
});
