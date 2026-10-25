import { describe, expect, it } from 'vitest';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import { SimulationFault, SimulationInputError } from '../../src/simulation/combat/model';
import { xorshift32 } from '../../src/simulation/combat/validation';
import { CombatEventReceiver, CombatSnapshotReceiver } from '../../src/contracts/combat-streams';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import scenario from '../fixtures/simulation/route-combat.json';

const configuration = { combat, simulation };
const fixedRandom = value => state => ({ state: state + 1, value });
const create = (definition = scenario, config = configuration, random = fixedRandom(0.25)) => new RouteCombatSimulation('combat-test', config, definition, 1, random);
const click = (sequence, atMs) => ({ protocolVersion: 1, sessionId: 'combat-test', sequence, atMs, type: 'ClickAttack' });

describe('headless route combat', () => {
    it('keeps the seeded random sequence stable for replay', () => {
        let state = 1;
        for (const expected of [270369, 67634689, 2647435461, 307599695, 2398689233]) {
            const result = xorshift32(state);
            expect(result).toEqual({ state: expected, value: expected / (2 ** 32) });
            state = result.state;
        }
    });

    it('automatically attacks, rewards defeat, captures and resets the next enemy cadence', () => {
        const game = create();
        expect(game.snapshot.encounter.enemy.health).toBe(30);
        expect(game.advanceTo(999).snapshot.encounter.enemy.health).toBe(30);
        expect(game.advanceTo(1000).snapshot.encounter.enemy.health).toBe(20);
        expect(game.advanceTo(2000).snapshot.encounter.enemy.health).toBe(10);
        const defeated = game.advanceTo(3000);
        expect(defeated.events).toMatchObject([{ type: 'EnemyDefeated', sequence: 1, atMs: 3000, encounterId: 1 }]);
        expect(defeated.snapshot.encounter).toMatchObject({ phase: 'capturing', resolvesAtMs: 3200, enemy: { health: 0 } });
        expect(game.progress).toMatchObject({ money: 10, experience: 12, defeats: 1, pokeballs: 1, dungeonTokens: 0 });
        expect(game.advanceTo(3100).events).toEqual([]);
        const captured = game.advanceTo(3200);
        expect(captured.events).toMatchObject([{ type: 'CaptureResolved', sequence: 2, atMs: 3200, caught: true }]);
        expect(game.progress).toMatchObject({ dungeonTokens: 2, captured: [{ pokemonId: 16, count: 1 }] });
        expect(captured.snapshot.encounter.enemy).toMatchObject({ encounterId: 2, health: 30 });
        expect(game.advanceTo(4000).snapshot.encounter.enemy.health).toBe(30);
        expect(game.advanceTo(4100).snapshot.encounter.enemy.health).toBe(20);
    });

    it('preserves cooldown boundaries and two clicks in one fixed step', () => {
        const game = create();
        [49, 50, 99, 100].forEach((atMs, index) => game.submit(click(index + 1, atMs)));
        const result = game.advanceTo(100);
        expect(result.commands.map(command => command.result)).toEqual(['cooldown', 'applied', 'cooldown', 'applied']);
        expect(game.progress.clickAttacks).toBe(2);
        expect(result.snapshot.encounter.enemy.health).toBe(10);
    });

    it('consumes the cooldown with no target and resolves capture before same-time clicks', () => {
        const game = create();
        [50, 100, 150, 200, 349, 350, 399].forEach((time, index) => game.submit(click(index + 1, time)));
        const result = game.advanceTo(400);
        expect(result.events.map(event => [event.type, event.atMs])).toEqual([['EnemyDefeated', 150], ['CaptureResolved', 350]]);
        expect(result.commands.map(command => command.result)).toEqual(['applied', 'applied', 'applied', 'no-target', 'no-target', 'cooldown', 'applied']);
        expect(game.snapshot.encounter.enemy).toMatchObject({ encounterId: 2, health: 20 });
        expect(game.progress.clickAttacks).toBe(4);
    });

    it.each([[0.25, true], [0.75, false], [0.5, true]])('resolves capture once for random draw %s', (draw, caught) => {
        const game = create(scenario, configuration, fixedRandom(draw));
        const result = game.advanceTo(3200);
        expect(result.events[1]).toMatchObject({ type: 'CaptureResolved', caught });
        expect(game.progress).toMatchObject({ money: 10, experience: 12, pokeballs: 1, dungeonTokens: caught ? 2 : 0 });
        expect(game.advanceTo(3200).events).toEqual([]);
        expect(game.progress.defeats).toBe(1);
    });

    it('preserves the legacy inclusive zero-draw comparison', () => {
        const data = structuredClone(scenario);
        data.opponents[0].captureProbability = 0;
        const game = create(data, configuration, fixedRandom(0));
        expect(game.advanceTo(3200).events[1].caught).toBe(true);
    });

    it('clamps overkill, grants one reward and immediately respawns when no ball remains', () => {
        const game = create({ ...scenario, initialPokeballs: 0, clickAttackDamage: 100 });
        game.submit(click(1, 50));
        const result = game.advanceTo(100);
        expect(result.events).toMatchObject([{ type: 'EnemyDefeated', encounterId: 1 }]);
        expect(game.progress).toMatchObject({ defeats: 1, money: 10, experience: 12, pokeballs: 0 });
        expect(game.snapshot.encounter).toMatchObject({ phase: 'fighting', enemy: { encounterId: 2, health: 30 } });
    });

    it('reports disabled clicks and unavailable routes without blocking later commands', () => {
        const game = create({ ...scenario, clickAttacksAllowed: false });
        game.submit({ ...click(1, 50), type: 'ChangeRoute', destination: { region: 0, route: 2 } });
        game.submit({ ...click(2, 50), type: 'ChangeRoute', destination: scenario.location });
        game.submit(click(3, 100));
        expect(game.advanceTo(100).commands.map(command => command.result)).toEqual(['route-unavailable', 'route-unchanged', 'disabled']);
        expect(game.progress.clickAttacks).toBe(0);
    });

    it('retains partial-step time and bounds catch-up without discarding debt', () => {
        const config = { ...configuration, simulation: { ...simulation, maxStepsPerAdvance: 2 } };
        const game = create(scenario, config);
        expect(game.advanceTo(49)).toMatchObject({ snapshot: { atMs: 0, sequence: 0 }, remainingMs: 49 });
        expect(game.advanceTo(1050)).toMatchObject({ snapshot: { atMs: 200, sequence: 2 }, remainingMs: 850 });
        for (let i = 0; i < 4; i++) game.advanceTo(1050);
        expect(game.snapshot.atMs).toBe(1000);
        expect(game.advanceTo(1050).remainingMs).toBe(50);
    });

    it('has identical outcomes for batched or incremental advances and arbitrary display reads', () => {
        const data = structuredClone(scenario);
        data.opponents.push({ ...data.opponents[0], pokemonId: 19.01, health: 20 });
        const batch = new RouteCombatSimulation('combat-test', configuration, data, 123);
        const stepped = new RouteCombatSimulation('combat-test', configuration, data, 123);
        const fastDisplay = new CombatSnapshotReceiver('combat-test');
        const slowDisplay = new CombatSnapshotReceiver('combat-test');
        const receiver = new CombatEventReceiver('combat-test');
        const batched = batch.advanceTo(10000);
        const events = [];
        for (let time = 100; time <= 10000; time += 100) {
            const result = stepped.advanceTo(time);
            events.push(...result.events);
            result.events.forEach(event => expect(receiver.receive(event)).toEqual(event));
            fastDisplay.receive(stepped.snapshot);
            if (time % 1000 === 0) slowDisplay.receive(stepped.snapshot);
            expect(stepped.snapshot).toEqual(result.snapshot);
        }
        expect(events).toEqual(batched.events);
        expect(stepped.snapshot).toEqual(batch.snapshot);
        expect(fastDisplay.latest).toEqual(slowDisplay.latest);
        expect(stepped.progress).toEqual(batch.progress);
        expect(stepped.randomState).toBe(batch.randomState);
    });

    it('copies configuration and scenario inputs and exposes immutable projections', () => {
        const data = structuredClone(scenario);
        const config = structuredClone(configuration);
        const game = create(data, config);
        data.opponents[0].moneyReward = 999;
        config.combat.autoAttackIntervalMs = 100;
        const initial = game.snapshot;
        const progress = game.progress;
        expect(Object.isFrozen(initial.encounter.enemy)).toBe(true);
        expect(Object.isFrozen(progress.captured)).toBe(true);
        game.advanceTo(3200);
        expect(initial.encounter.enemy.health).toBe(30);
        expect(progress.money).toBe(0);
        expect(game.progress.money).toBe(10);
    });
});

describe('defensive processing', () => {
    it('rejects queue overflow without consuming the sequence and permits retry after draining', () => {
        const game = create(scenario, { ...configuration, simulation: { ...simulation, maxQueuedCommands: 1 } });
        game.submit(click(1, 50));
        expect(() => game.submit(click(2, 100))).toThrow(SimulationInputError);
        game.advanceTo(100);
        game.submit(click(2, 150));
        expect(game.advanceTo(200).commands[0].sequence).toBe(2);
    });

    it('rejects late, distant and invalid commands without changing state or sequence', () => {
        const game = create();
        game.advanceTo(100);
        for (const time of [100, 99, simulation.maxCommandLeadMs + 101]) {
            expect(() => game.submit(click(1, time))).toThrow(SimulationInputError);
        }
        expect(() => game.submit({ ...click(1, 150), damage: 999 })).toThrow();
        game.submit(click(1, 150));
        expect(game.advanceTo(200).commands[0].sequence).toBe(1);
        expect(game.fault).toBe(null);
    });

    it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid advance target %s', target => {
        const game = create();
        expect(() => game.advanceTo(target)).toThrow(SimulationInputError);
        expect(game.fault).toBe(null);
        expect(game.snapshot.atMs).toBe(0);
    });

    it('rejects backwards advances without faulting the world', () => {
        const game = create();
        game.advanceTo(100);
        expect(() => game.advanceTo(99)).toThrow(SimulationInputError);
        expect(game.advanceTo(200).snapshot.atMs).toBe(200);
    });

    it('rolls back the whole advance on an invalid random result, then stops safely', () => {
        const random = state => ({ state: state + 1, value: state === 1 ? 0.25 : NaN });
        const game = create(scenario, configuration, random);
        const before = { snapshot: game.snapshot, progress: game.progress, randomState: game.randomState };
        expect(() => game.advanceTo(3200)).toThrow(SimulationFault);
        expect({ snapshot: game.snapshot, progress: game.progress, randomState: game.randomState }).toEqual(before);
        expect(game.fault.committedAtMs).toBe(0);
        expect(() => game.advanceTo(100)).toThrow(SimulationFault);
        expect(() => game.submit(click(1, 50))).toThrow(SimulationFault);
    });

    it('rolls back consumed commands and partial damage if the transition budget is exceeded', () => {
        const game = create(scenario, { ...configuration, simulation: { ...simulation, maxTransitionsPerStep: 1 } });
        game.submit(click(1, 50));
        expect(() => game.advanceTo(100)).toThrow(/transition budget/);
        expect(game.snapshot.encounter.enemy.health).toBe(30);
        expect(game.progress.clickAttacks).toBe(0);
    });

    it.each([0, -1, 1.5, 2 ** 32])('rolls back an invalid random state %s', invalidState => {
        const random = state => ({ state: state === 1 ? 2 : invalidState, value: 0.25 });
        const game = create(scenario, configuration, random);
        game.advanceTo(3000);
        const before = { snapshot: game.snapshot, progress: game.progress, randomState: game.randomState };
        expect(() => game.advanceTo(3200)).toThrow(SimulationFault);
        expect({ snapshot: game.snapshot, progress: game.progress, randomState: game.randomState }).toEqual(before);
    });

    it.each(['submit', 'advanceTo'])('rejects reentrant %s calls and preserves the last committed state', method => {
        let game;
        const random = state => {
            if (game) {
                if (method === 'submit') game.submit(click(1, 3250));
                else game.advanceTo(3300);
            }
            return { state: state + 1, value: 0.25 };
        };
        game = create(scenario, configuration, random);
        game.advanceTo(3000);
        const before = { snapshot: game.snapshot, progress: game.progress, randomState: game.randomState };
        expect(() => game.advanceTo(3200)).toThrow(/cannot be reentered/);
        expect({ snapshot: game.snapshot, progress: game.progress, randomState: game.randomState }).toEqual(before);
        expect(game.fault).toBeInstanceOf(SimulationFault);
    });

    it('rejects arithmetic overflow without leaving partial rewards', () => {
        const data = structuredClone(scenario);
        data.initialPokeballs = 0;
        data.opponents[0].health = 1;
        data.opponents[0].moneyReward = Number.MAX_SAFE_INTEGER;
        const game = create(data);
        game.advanceTo(1000);
        expect(() => game.advanceTo(2000)).toThrow(SimulationFault);
        expect(game.progress).toMatchObject({ defeats: 1, money: Number.MAX_SAFE_INTEGER, experience: 12 });
        expect(game.snapshot.atMs).toBe(1000);
    });

    it('does not accumulate old entities over many spawns', () => {
        const data = structuredClone(scenario);
        data.initialPokeballs = 0;
        data.opponents[0].health = 1;
        const game = create(data);
        let events = 0;
        for (let target = 10000; target <= 100000; target += 10000) {
            events += game.advanceTo(target).events.length;
        }
        expect(game.progress.defeats).toBe(100);
        expect(game.snapshot.encounter.enemy.encounterId).toBe(101);
        expect(events).toBe(100);
    });

    it.each([
        data => { data.opponents = []; },
        data => { data.opponents = new Array(1); },
        data => { data.opponents.push({ ...data.opponents[0] }); },
        data => { data.opponents[0].captureProbability = Infinity; },
        data => { data.opponents[0].captureDurationMs = 0; },
        data => { data.clickAttackDamage = -1; },
        data => { data.initialPokeballs = '2'; },
        data => { data.opponents[0].typo = 1; },
        data => { Object.setPrototypeOf(data.opponents[0], { extra: true }); },
        data => { Object.defineProperty(data.opponents[0], 'health', { get() { throw new Error('Must not execute'); } }); },
    ])('rejects malformed scenario input', change => {
        const data = structuredClone(scenario);
        change(data);
        expect(() => create(data)).toThrow(SimulationInputError);
    });

    it.each([0, -1, 1.5, 2 ** 32])('rejects invalid random seed %s', seed => {
        expect(() => new RouteCombatSimulation('combat-test', configuration, scenario, seed)).toThrow(SimulationInputError);
    });
});
