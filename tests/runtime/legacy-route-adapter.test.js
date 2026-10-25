import { describe, expect, it, vi } from 'vitest';
import createInput from '../fixtures/runtime/legacy-route-source.cjs';
import { captureRouteCatalog } from '../../src/runtime/legacy/captureRouteCatalog';
import { prepareLegacyRouteSession } from '../../src/runtime/legacy/prepareLegacyRouteSession';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import { validateScenario } from '../../src/simulation/combat/validation';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
const capture = input => captureRouteCatalog(input.registry, input.pokemonList, input.session.routes.map(r => r.location));
const create = (scenario, checkpoint) => new RouteCombatSimulation('legacy', { combat, simulation }, scenario, 123, undefined, checkpoint);

describe('historical route catalog capture', () => {
    it('captures class records as detached immutable JSON without evaluating requirements', () => {
        const input = createInput(), captured = capture(input);
        expect(captured[0].catalog.map(p => p.pokemonId)).toEqual([16, 16.01, 16.02]);
        expect(captured[0].pools.special[1].pokemonIds).toEqual([16]);
        expect(captured[0].pools.special[2].pokemonIds).toEqual([16.02]);
        expect(captured[0].healthOverride).toBe(30);
        expect(Object.isFrozen(captured[0].catalog[0])).toBe(true);
        expect(Object.isFrozen(captured[0].pools.special[0].pokemonIds)).toBe(true);
        expect(JSON.parse(JSON.stringify(captured))).toEqual(captured);
        input.pokemonList[0].base.hitpoints = 999;
        input.registry[0].pokemon.land.push('not a species');
        expect(captured[0].catalog[0].baseHealth).toBe(40); expect(captured[0].pools.land).toEqual([16]);
    });
    it('normalizes the entire registry before selecting routes and skips ignored entries only after matching', () => {
        const input = createInput(); input.registry[1].ignoreRouteInCalculations = true;
        input.session.routes = [input.session.routes[4], input.session.routes[2], input.session.routes[1]];
        expect(capture(input).map(r => r.normalizedRoute)).toEqual([4, 2, 2]);
    });
    it('preserves all pool order and duplicates while keeping one catalog record per species', () => {
        const input = createInput();
        input.registry[0].pokemon.water = ['Fixture species 16.02', 'Fixture species 16'];
        input.registry[0].pokemon.headbutt = ['Fixture species 16.01'];
        const route = capture(input)[0];
        expect(route.pools.water).toEqual([16.02, 16]);
        expect(route.catalog.map(p => p.pokemonId)).toEqual([16, 16.02, 16.01]);
    });
    it('represents an omitted health override explicitly as null', () => {
        const input = createInput(); delete input.registry[0].routeHealth;
        expect(capture(input)[0].healthOverride).toBe(null);
    });
    it.each([
        ['unknown selected route', i => { i.session.routes[0].location.route = 999; }],
        ['duplicate selected route', i => { i.session.routes[1].location = i.session.routes[0].location; }],
        ['duplicate registry identity', i => { i.registry.push(i.registry[0]); }],
        ['missing calculation flag', i => { delete i.registry[0].ignoreRouteInCalculations; }],
        ['unknown name in unavailable pool', i => { i.registry[0].pokemon.special[2].pokemon[0] = 'Missing species'; }],
        ['duplicate catalog name', i => { i.pokemonList.push(i.pokemonList[0]); }],
        ['ambiguous catalog ID', i => { i.pokemonList[1].id = i.pokemonList[0].id; }],
        ['nonpositive base health', i => { i.pokemonList[2].base.hitpoints = 0; }],
        ['nonfinite catch rate', i => { i.pokemonList[2].catchRate = Infinity; }],
        ['invalid health override', i => { i.registry[0].routeHealth = 0; }],
        ['negative special weight', i => { i.registry[0].pokemon.special[2].weight = -1; }],
        ['sparse pool', i => { delete i.registry[0].pokemon.special[0].pokemon[0]; }],
    ])('rejects %s', (_label, mutate) => { const input = createInput(); mutate(input); expect(() => capture(input)).toThrow(); });
    it('rejects accessors without invoking them, while ignoring unrelated legacy fields', () => {
        const input = createInput(), get = vi.fn(() => 40);
        Object.defineProperty(input.pokemonList[0], 'evolutions', { get });
        capture(input); expect(get).not.toHaveBeenCalled();
        Object.defineProperty(input.pokemonList[0].base, 'hitpoints', { get });
        expect(() => capture(input)).toThrow('data property'); expect(get).not.toHaveBeenCalled();
    });
});

describe('historical session preparation', () => {
    it('produces a serializable sampled scenario with explicit bonuses and eligible profiles only', () => {
        const scenario = prepareLegacyRouteSession(createInput());
        expect(scenario.formatVersion).toBe(3);
        expect(scenario.routes[0].encounters).toEqual([{ pokemonId: 16, weight: 1 }, { pokemonId: 16.01, weight: 2.5 }, { pokemonId: 16, weight: 0.5 }]);
        expect(scenario.routes[0].opponents.map(p => p.pokemonId)).toEqual([16, 16.01]);
        expect(scenario.routes[0].opponents[0].health).toBe(29); // Unavailable HP=100 remains in the average.
        expect(scenario.spawnRules.opponents).toHaveLength(10);
        expect(scenario.spawnRules.opponents.at(-1).inputs.normalizedRoute).toBe(5);
        expect(validateScenario(JSON.parse(JSON.stringify(scenario)))).toEqual(scenario);
    });
    it('uses explicit eligibility and ordinary weight and keeps species health stable', () => {
        const input = createInput(), before = prepareLegacyRouteSession(input);
        input.session.ordinaryWeight = 2;
        input.session.routes[0].specialAvailability[2] = true;
        const after = prepareLegacyRouteSession(input);
        expect(after.routes[0].opponents[0].health).toBe(before.routes[0].opponents[0].health);
        expect(after.routes[0].opponents.map(p => p.pokemonId)).toEqual([16, 16.01, 16.02]);
        expect(after.routes[0].encounters[0].weight).toBe(2);
        expect(after.spawnRules.opponents).toHaveLength(11);
    });
    it('includes water without a rod when land is empty', () => {
        const input = createInput(); input.registry[0].pokemon.water = input.registry[0].pokemon.land; input.registry[0].pokemon.land = [];
        expect(prepareLegacyRouteSession(input).routes[0].encounters[0].pokemonId).toBe(16);
    });
    it('replays a detached scenario through a source-route capture without legacy records', () => {
        const input = createInput(), scenario = prepareLegacyRouteSession(input), game = create(scenario);
        [50, 100, 150].forEach((atMs, i) => game.submit({ protocolVersion: 1, sessionId: 'legacy', sequence: i + 1, atMs, type: 'ClickAttack' }));
        game.submit({ protocolVersion: 1, sessionId: 'legacy', sequence: 4, atMs: 200, type: 'ChangeRoute', destination: { region: 0, route: 2 } });
        game.advanceTo(300); const checkpoint = JSON.parse(JSON.stringify(game.checkpoint()));
        expect(checkpoint.sourceLocation.route).toBe(1); expect(checkpoint.snapshot.location.route).toBe(2);
        expect(checkpoint.snapshot.encounter.phase).toBe('capturing');
        input.registry.length = 0; input.pokemonList.length = 0; input.session.routes.length = 0;
        const resumed = create(checkpoint.scenario, checkpoint);
        for (let time = 400; time <= 10000; time += 100) expect(resumed.advanceTo(time)).toEqual(game.advanceTo(time));
        expect(resumed.checkpoint()).toEqual(game.checkpoint());
    });
    it('requires explicit compatibility or migration when recaptured content changes', () => {
        const input = createInput(), saved = create(prepareLegacyRouteSession(input)).checkpoint();
        input.pokemonList[0].base.hitpoints = 1000;
        expect(() => create(prepareLegacyRouteSession(input), saved)).toThrow('scenario');
    });
    it.each([
        ['unknown version', i => { i.session.formatVersion = 2; }],
        ['implicit ordinary weight', i => { delete i.session.ordinaryWeight; }],
        ['extra session field', i => { i.session.seed = 1; }],
        ['missing availability', i => { i.session.routes[0].specialAvailability.pop(); }],
        ['nonboolean availability', i => { i.session.routes[0].specialAvailability[0] = 1; }],
        ['extra availability', i => { i.session.routes[0].specialAvailability.push(true); }],
        ['missing unavailable profile', i => { i.session.routes[0].opponents.pop(); }],
        ['duplicate profile', i => { i.session.routes[0].opponents[1] = i.session.routes[0].opponents[0]; }],
        ['unknown profile', i => { i.session.routes[0].opponents[0].pokemonId = 999; }],
        ['invalid inactive bonus', i => { i.session.routes[3].opponents[2].moneyMultiplier = -1; }],
        ['overflowing inactive reward', i => { i.session.routes[3].opponents[2].moneyMultiplier = Number.MAX_SAFE_INTEGER; }],
        ['implicit click permission', i => { delete i.session.clickAttacksAllowed; }],
        ['locked initial route', i => { i.session.routes[0].unlocked = false; }],
    ])('rejects %s', (_label, mutate) => { const input = createInput(); mutate(input); expect(() => prepareLegacyRouteSession(input)).toThrow(); });
});
