import { describe, it, expect, vi } from 'vitest';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import { parseCombatCheckpoint } from '../../src/simulation/combat/checkpoint';
import { CombatCommandReceiver } from '../../src/contracts/combat-streams';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import scenario from '../fixtures/simulation/route-transitions.json';

const configuration = { combat, simulation };
const create = (checkpoint, sessionId = 'save', settings = configuration) => new RouteCombatSimulation(sessionId, settings, scenario, 123, undefined, checkpoint);
const click = (sequence, atMs, sessionId = 'save') => ({ protocolVersion: 1, sessionId, type: 'ClickAttack', sequence, atMs });
function prepared() {
    const engine = create();
    [click(1, 50), click(2, 100), click(3, 150), { ...click(4, 200), type: 'ChangeRoute', destination: { region: 0, route: 2 } }, click(5, 650)]
        .forEach(command => engine.submit(command));
    return engine;
}

describe('versioned combat checkpoints', () => {
    it.each([0, 100, 200, 300, 400, 700, 3000, 12000])('resumes exactly after saving at %i ms', time => {
        const original = prepared();
        original.advanceTo(time);
        const saved = JSON.parse(JSON.stringify(original.checkpoint()));
        const restored = create(saved);
        expect(restored.snapshot).toEqual(original.snapshot);
        expect(restored.progress).toEqual(original.progress);
        expect(restored.randomState).toEqual(original.randomState);
        expect(restored.cursors).toEqual(original.cursors);
        for (let target = time + 100; target <= time + 15000; target += 100) {
            expect(restored.advanceTo(target)).toEqual(original.advanceTo(target));
        }
        expect(restored.progress).toEqual(original.progress);
        expect(restored.randomState).toEqual(original.randomState);
        expect(restored.checkpoint()).toEqual(original.checkpoint());
    });

    it('restores a new session and rebinds queued commands without replaying delivered events', () => {
        const original = prepared();
        original.advanceTo(300);
        const saved = original.checkpoint();
        expect(saved.snapshot.encounter.phase).toBe('capturing');
        expect(saved.sourceLocation.route).toBe(1);
        expect(saved.snapshot.location.route).toBe(2);
        const restored = create(saved, 'replacement');
        expect(restored.snapshot.sessionId).toBe('replacement');
        restored.submit(click(6, 750, 'replacement'));
        expect(() => restored.submit(click(7, 800))).toThrow('session');
        const output = restored.advanceTo(1000);
        expect(output.events.every(event => event.sessionId === 'replacement' && event.sequence > saved.eventSequence)).toBe(true);
        expect(output.commands.map(command => command.sequence)).toEqual([5, 6]);
        expect(saved.commands[0].sessionId).toBe('save');
        expect(Object.isFrozen(saved.commands[0])).toBe(true);
    });

    it('preserves cooldown when restarting between accepted clicks', () => {
        const original = create();
        original.submit(click(1, 90)); original.advanceTo(100);
        const restored = create(original.checkpoint());
        original.submit(click(2, 120)); restored.submit(click(2, 120));
        expect(restored.advanceTo(200)).toEqual(original.advanceTo(200));
        expect(restored.progress.clickAttacks).toBe(1);
    });

    it('preserves fractional catalog IDs', () => {
        const definition = structuredClone(scenario);
        definition.routes[0].opponents[0].pokemonId = 19.01;
        const engine = new RouteCombatSimulation('forms', configuration, definition, 123);
        const restored = new RouteCombatSimulation('forms', configuration, definition, 123, undefined, engine.checkpoint());
        expect(restored.snapshot.encounter.enemy.pokemonId).toBe(19.01);
    });

    it('does not retain mutable caller data', () => {
        const engine = prepared(); engine.advanceTo(300);
        const input = JSON.parse(JSON.stringify(engine.checkpoint()));
        const restored = create(input);
        input.commands[0].atMs = 9999;
        input.progress.money = 999;
        input.scenario.routes[0].opponents[0].health = 99;
        expect(restored.checkpoint()).toEqual(engine.checkpoint());
    });

    it('rejects rule changes and custom random functions rather than guessing migrations', () => {
        const saved = create().checkpoint();
        expect(() => create(saved, 'save', { combat: { ...combat, clickAttackCooldownMs: 51 }, simulation })).toThrow('configuration');
        const changed = structuredClone(scenario); changed.routes[0].opponents[0].health++;
        expect(() => new RouteCombatSimulation('save', configuration, changed, 123, undefined, saved)).toThrow('scenario');
        const random = state => ({ state, value: 0.5 });
        expect(() => new RouteCombatSimulation('save', configuration, scenario, 123, random).checkpoint()).toThrow('algorithm');
        expect(() => new RouteCombatSimulation('save', configuration, scenario, 123, random, saved)).toThrow('algorithm');
    });

    it('allows object property reordering without treating it as a rule change', () => {
        const saved = create().checkpoint();
        const reordered = { simulation, combat: Object.fromEntries(Object.entries(combat).reverse()) };
        expect(() => create(saved, 'save', reordered)).not.toThrow();
    });

    it.each([
        ['version', data => { data.formatVersion = 2; }],
        ['algorithm', data => { data.randomAlgorithm = 'Math.random'; }],
        ['extra field', data => { data.typo = true; }],
        ['missing field', data => { delete data.randomState; }],
        ['zero RNG', data => { data.randomState = 0; }],
        ['wrong step', data => { data.snapshot.atMs++; }],
        ['unknown source route', data => { data.sourceLocation.route = 999; }],
        ['locked selection', data => { data.snapshot.location.route = 4; }],
        ['health mismatch', data => { data.snapshot.encounter.enemy.maxHealth++; }],
        ['past capture', data => { data.snapshot.encounter.resolvesAtMs = 299; }],
        ['excessive capture delay', data => { data.snapshot.encounter.resolvesAtMs = 9999; }],
        ['identity mismatch', data => { data.nextEntity++; }],
        ['auto timer', data => { data.autoElapsedMs = 50; }],
        ['future cooldown', data => { data.lastClickAtMs = 1000; }],
        ['queue sequence gap', data => { data.commands[0].sequence++; }],
        ['past command', data => { data.commands[0].atMs = 300; data.commandAtMs = 300; }],
        ['future command', data => { data.commands[0].atMs = 999999; data.commandAtMs = 999999; }],
        ['foreign command', data => { data.commands[0].sessionId = 'other'; }],
        ['accepted input mismatch', data => { data.commandAtMs++; }],
        ['event cursor', data => { data.eventSequence++; }],
        ['ball count', data => { data.pokeballs++; }],
        ['non-finite reward', data => { data.progress.money = Infinity; }],
        ['unknown captured ID', data => { data.progress.captured = [{ pokemonId: 999, count: 1 }]; }],
        ['route totals', data => { data.progress.routes[0].defeats++; }],
        ['duplicate route', data => { data.progress.routes.push(data.progress.routes[0]); }],
        ['excessive clicks', data => { data.progress.clickAttacks = 999; }],
    ])('rejects %s before creating a replacement world', (_name, mutate) => {
        const original = prepared(); original.advanceTo(300);
        const saved = original.checkpoint();
        const invalid = structuredClone(saved); mutate(invalid);
        expect(() => create(invalid)).toThrow();
        expect(original.checkpoint()).toEqual(saved);
    });

    it('rejects accessors without evaluating them', () => {
        const getter = vi.fn();
        const invalid = { ...create().checkpoint(), get randomState() { getter(); return 123; } };
        expect(() => parseCombatCheckpoint(invalid)).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });

    it('rejects nested configuration and queued-command accessors without executing them', () => {
        const engine = prepared(); engine.advanceTo(300);
        const getter = vi.fn(() => 50);
        const configurationAccessor = structuredClone(engine.checkpoint());
        Object.defineProperty(configurationAccessor.configuration.combat, 'clickAttackCooldownMs', { enumerable: true, get: getter });
        expect(() => parseCombatCheckpoint(configurationAccessor)).toThrow();
        const queueAccessor = structuredClone(engine.checkpoint());
        Object.defineProperty(queueAccessor.commands, '0', { enumerable: true, get: getter });
        expect(() => parseCombatCheckpoint(queueAccessor)).toThrow();
        const scenarioAccessor = structuredClone(engine.checkpoint());
        Object.defineProperty(scenarioAccessor.scenario.routes, '0', { enumerable: true, get: getter });
        expect(() => parseCombatCheckpoint(scenarioAccessor)).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });

    it('validates restored command receiver cursors', () => {
        for (const cursor of [{ sequence: -1, atMs: 0 }, { sequence: 0, atMs: 1 }, { sequence: 1, atMs: NaN }]) {
            expect(() => new CombatCommandReceiver('save', cursor)).toThrow();
        }
        const receiver = new CombatCommandReceiver('save', { sequence: 5, atMs: 50 });
        expect(() => receiver.receive(click(5, 50))).toThrow();
        expect(() => receiver.receive(click(6, 49))).toThrow();
        expect(receiver.receive(click(6, 50)).sequence).toBe(6);
    });
});
