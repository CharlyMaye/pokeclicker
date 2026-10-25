import { describe, expect, it } from 'vitest';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import { SimulationFault, SimulationInputError } from '../../src/simulation/combat/model';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import scenario from '../fixtures/simulation/route-transitions.json';

const configuration = { combat, simulation };
const random = state => ({ state: state + 1, value: 0.25 });
const create = (data = scenario, rng = random, config = configuration) => new RouteCombatSimulation('routes', config, data, 1, rng);
const click = (sequence, atMs) => ({ protocolVersion: 1, sessionId: 'routes', sequence, atMs, type: 'ClickAttack' });
const move = (sequence, atMs, route, region = 0) => ({ ...click(sequence, atMs), type: 'ChangeRoute', destination: { region, route } });
const stateOf = game => ({ snapshot: game.snapshot, progress: game.progress, randomState: game.randomState });

describe('route transitions', () => {
    it('replaces an undefeated opponent without rewards and resets only the automatic counter', () => {
        const game = create();
        [click(1, 100), move(2, 150, 2), click(3, 150)].forEach(command => game.submit(command));
        const result = game.advanceTo(200);
        expect(result.commands.map(command => command.result)).toEqual(['applied', 'applied', 'applied']);
        expect(result.events).toEqual([]);
        expect(result.snapshot).toMatchObject({ location: { region: 0, route: 2 }, encounter: { enemy: { encounterId: 2, pokemonId: 19, health: 30 } } });
        expect(game.progress).toMatchObject({ money: 0, defeats: 0, clickAttacks: 2, routes: [] });
        expect(game.advanceTo(1000).snapshot.encounter.enemy.health).toBe(30);
        expect(game.advanceTo(1100).snapshot.encounter.enemy.health).toBe(10);
    });

    it('keeps the click cooldown across route changes', () => {
        const game = create();
        [click(1, 50), move(2, 99, 2), click(3, 99), click(4, 100)].forEach(command => game.submit(command));
        expect(game.advanceTo(100).commands.map(command => command.result)).toEqual(['applied', 'applied', 'cooldown', 'applied']);
        expect(game.snapshot.encounter.enemy.health).toBe(30);
    });

    it('ignores same-route requests and rejects unknown, locked and cross-region destinations without drawing randomness', () => {
        const game = create();
        [click(1, 50), move(2, 50, 1), move(3, 50, 999), move(4, 50, 4), move(5, 50, 1, 1)].forEach(command => game.submit(command));
        expect(game.advanceTo(100).commands.map(command => command.result)).toEqual(['applied', 'route-unchanged', 'route-unavailable', 'route-unavailable', 'route-unavailable']);
        expect(game.snapshot).toMatchObject({ location: { region: 0, route: 1 }, encounter: { enemy: { encounterId: 1, health: 20 } } });
        expect(game.randomState).toBe(2);
        expect(game.fault).toBe(null);
    });

    it('keeps a pending capture on its source route, then spawns on the latest selected route', () => {
        const game = create();
        [click(1, 50), click(2, 100), click(3, 150), move(4, 200, 2)].forEach(command => game.submit(command));
        const pending = game.advanceTo(300);
        expect(pending.snapshot).toMatchObject({ location: { route: 2 }, encounter: { phase: 'capturing', resolvesAtMs: 350, enemy: { encounterId: 1, pokemonId: 16 } } });
        expect(game.progress.routes).toEqual([{ location: { region: 0, route: 1 }, defeats: 1, captures: 0 }]);
        const resolved = game.advanceTo(400);
        expect(resolved.events).toMatchObject([{ type: 'CaptureResolved', encounterId: 1, caught: true, atMs: 350 }]);
        expect(resolved.snapshot.encounter.enemy).toMatchObject({ encounterId: 2, pokemonId: 19, health: 40 });
        expect(game.progress).toMatchObject({ money: 10, experience: 12, dungeonTokens: 2, pokeballs: 1,
            routes: [{ location: { region: 0, route: 1 }, defeats: 1, captures: 1 }] });

        [click(5, 450), click(6, 500), click(7, 550), click(8, 600), move(9, 650, 1), move(10, 700, 3)].forEach(command => game.submit(command));
        expect(game.advanceTo(1000).snapshot).toMatchObject({ location: { route: 3 }, encounter: { phase: 'capturing', resolvesAtMs: 1050, enemy: { pokemonId: 19 } } });
        const failed = game.advanceTo(1100);
        expect(failed.events).toMatchObject([{ type: 'CaptureResolved', caught: false, atMs: 1050 }]);
        expect(failed.snapshot.encounter.enemy).toMatchObject({ encounterId: 3, pokemonId: 16, health: 50 });
        expect(game.progress).toMatchObject({ money: 35, experience: 30, dungeonTokens: 2, pokeballs: 0,
            routes: [{ location: { region: 0, route: 1 }, defeats: 1, captures: 1 }, { location: { region: 0, route: 2 }, defeats: 1, captures: 0 }] });
    });

    it('resolves capture before a same-time route change and click', () => {
        const game = create({ ...scenario, clickAttackDamage: 30 });
        [click(1, 50), move(2, 250, 2), click(3, 250)].forEach(command => game.submit(command));
        const result = game.advanceTo(300);
        expect(result.events.map(event => [event.type, event.atMs])).toEqual([['EnemyDefeated', 50], ['CaptureResolved', 250]]);
        expect(result.snapshot.encounter.enemy).toMatchObject({ encounterId: 3, pokemonId: 19, health: 10 });
        // Initial spawn, capture draw, old-route spawn, then destination spawn.
        expect(game.randomState).toBe(5);
        expect(game.progress.routes).toEqual([{ location: { region: 0, route: 1 }, defeats: 1, captures: 1 }]);
    });

    it('honors command order when a click and route change share a timestamp', () => {
        const clickFirst = create({ ...scenario, clickAttackDamage: 30 });
        clickFirst.submit(click(1, 50));
        clickFirst.submit(move(2, 50, 2));
        expect(clickFirst.advanceTo(100).snapshot.encounter.phase).toBe('capturing');
        expect(clickFirst.progress.defeats).toBe(1);
        const moveFirst = create({ ...scenario, clickAttackDamage: 30 });
        moveFirst.submit(move(1, 50, 2));
        moveFirst.submit(click(2, 50));
        expect(moveFirst.advanceTo(100).snapshot.encounter.enemy.health).toBe(10);
        expect(moveFirst.progress.defeats).toBe(0);
    });

    it('uses the current selection when returning to a previous route before another defeat', () => {
        const game = create();
        [move(1, 50, 2), move(2, 100, 1)].forEach(command => game.submit(command));
        expect(game.advanceTo(100).snapshot.encounter.enemy).toMatchObject({ encounterId: 3, pokemonId: 16, health: 30 });
        expect(game.progress.defeats).toBe(0);
    });

    it('does not refund consumed balls or cancel capture after moving away and back', () => {
        const game = create({ ...scenario, clickAttackDamage: 30 });
        [click(1, 50), move(2, 100, 2), move(3, 150, 1), move(4, 200, 1)].forEach(command => game.submit(command));
        expect(game.advanceTo(200).snapshot.encounter).toMatchObject({ phase: 'capturing', resolvesAtMs: 250, enemy: { encounterId: 1 } });
        expect(game.progress.pokeballs).toBe(1);
        expect(game.randomState).toBe(2);
        expect(game.advanceTo(300).snapshot.encounter.enemy).toMatchObject({ encounterId: 2, pokemonId: 16 });
        expect(game.progress.pokeballs).toBe(1);
    });

    it('credits defeats without balls and never retains the abandoned enemy', () => {
        const game = create({ ...scenario, initialPokeballs: 0, clickAttackDamage: 40 });
        [move(1, 50, 2), click(2, 50), move(3, 100, 3)].forEach(command => game.submit(command));
        const result = game.advanceTo(100);
        expect(result.events).toMatchObject([{ type: 'EnemyDefeated', pokemonId: 19 }]);
        expect(result.snapshot.encounter.enemy).toMatchObject({ encounterId: 4, pokemonId: 16, health: 50 });
        expect(game.progress.routes).toEqual([{ location: { region: 0, route: 2 }, defeats: 1, captures: 0 }]);
    });

    it('keeps results identical across batching and display reads while changing routes', () => {
        const batch = new RouteCombatSimulation('routes', configuration, scenario, 123);
        const stepped = new RouteCombatSimulation('routes', configuration, scenario, 123);
        const commands = [click(1, 50), click(2, 100), click(3, 150), move(4, 200, 2), move(5, 700, 3), click(6, 750), move(7, 1000, 1)];
        for (const game of [batch, stepped]) commands.forEach(command => game.submit(command));
        const result = batch.advanceTo(10000);
        const events = [], outcomes = [];
        for (let time = 100; time <= 10000; time += 100) {
            const step = stepped.advanceTo(time);
            events.push(...step.events);
            outcomes.push(...step.commands);
            expect(stepped.snapshot.atMs).toBe(time);
        }
        expect(events).toEqual(result.events);
        expect(outcomes).toEqual(result.commands);
        expect(stateOf(stepped)).toEqual(stateOf(batch));
    });
});

describe('route data and mutation boundaries', () => {
    it.each([
        data => { data.routes = []; },
        data => { data.routes = new Array(1); },
        data => { data.routes.push(structuredClone(data.routes[0])); },
        data => { data.initialLocation.route = 999; },
        data => { data.initialLocation.route = 4; },
        data => { data.routes[1].unlocked = 'true'; },
        data => { data.routes[1].location.route = 0; },
        data => { data.routes[1].unexpected = true; },
        data => { data.routes[1].opponents = []; },
        data => { data.routes[1].opponents[0].captureDurationMs = 0; },
    ])('rejects malformed or unresolved route data before startup', mutate => {
        const data = structuredClone(scenario);
        mutate(data);
        expect(() => create(data)).toThrow(SimulationInputError);
    });

    it('copies destination data and exposes frozen, detached route progress', () => {
        const data = structuredClone(scenario);
        const game = create(data);
        data.routes[1].opponents[0].moneyReward = 999;
        data.routes[1].unlocked = false;
        [move(1, 50, 2), click(2, 50), click(3, 100), click(4, 150), click(5, 200)].forEach(command => game.submit(command));
        game.advanceTo(200);
        const before = game.progress;
        expect(before.money).toBe(25);
        expect(Object.isFrozen(before.routes)).toBe(true);
        expect(Object.isFrozen(before.routes[0])).toBe(true);
        expect(Object.isFrozen(before.routes[0].location)).toBe(true);
        expect(() => { before.routes[0].defeats = 999; }).toThrow();
        game.advanceTo(2600);
        expect(before.routes[0].defeats).toBe(1);
        expect(game.progress.defeats).toBeGreaterThan(1);
    });

    it('rolls back selection and removed components when destination spawning fails', () => {
        const game = create(scenario, state => ({ state: state + 1, value: state === 1 ? 0.25 : NaN }));
        game.submit(move(1, 50, 2));
        const before = stateOf(game);
        expect(() => game.advanceTo(100)).toThrow(SimulationFault);
        expect(stateOf(game)).toEqual(before);
    });

    it('rolls back source-route capture counters if the following spawn fails', () => {
        const game = create(scenario, state => ({ state: state + 1, value: state === 3 ? NaN : 0.25 }));
        game.advanceTo(3000);
        game.submit(move(1, 3050, 2));
        game.advanceTo(3100);
        const before = stateOf(game);
        expect(() => game.advanceTo(3200)).toThrow(SimulationFault);
        expect(stateOf(game)).toEqual(before);
        expect(game.progress.routes[0].captures).toBe(0);
    });

    it('applies the transition budget to route commands and rolls back the whole call', () => {
        const game = create(scenario, random, { ...configuration, simulation: { ...simulation, maxTransitionsPerStep: 2 } });
        game.submit(move(1, 50, 2));
        game.submit(move(2, 100, 3));
        const before = stateOf(game);
        expect(() => game.advanceTo(100)).toThrow(/transition budget/);
        expect(stateOf(game)).toEqual(before);
    });
});
