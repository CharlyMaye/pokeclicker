import { describe, expect, it, vi } from 'vitest';
import { parseCombatProgress, parseCombatFrame } from '../../src/contracts/combat-progress';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import { DirectCombatHost } from '../../src/runtime/combat/DirectCombatHost';
import { CombatWorkerServer } from '../../src/runtime/worker/CombatWorkerServer';
import { WorkerCombatHost } from '../../src/runtime/worker/WorkerCombatHost';
import { WORKER_PROTOCOL_VERSION } from '../../src/runtime/worker/protocol';
import { ManualScheduler, channel } from '../helpers/combat-channel';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import scenario from '../fixtures/simulation/route-transitions.json';
import policy from '../fixtures/runtime/worker-policy.json';
const configuration = { combat, simulation };
const limits = { maxCaptured: 4, maxRoutes: 5 };
const value = () => ({ money: 12, experience: 10, dungeonTokens: 4, defeats: 3, clickAttacks: 2, pokeballs: 0,
    captured: [{ pokemonId: 19.01, count: 1 }, { pokemonId: 16, count: 1 }],
    routes: [{ location: { region: 0, route: 2 }, defeats: 1, captures: 1 }, { location: { region: 0, route: 1 }, defeats: 2, captures: 1 }] });
function setup(checkpoint) {
    const link = channel(), timer = new ManualScheduler(), deadlines = new ManualScheduler(); const clock = { value: 0 };
    const server = new CombatWorkerServer(link.ports[1], () => clock.value, timer);
    const host = new WorkerCombatHost({ sessionId: 'progress', session: { configuration, scenario, seed: 123, ...(checkpoint ? { checkpoint } : {}) }, ...policy, transport: link.ports[0], deadlines });
    const call = promise => { link.flush(); return promise; };
    return { host, server, link, clock, timer, call, wake(time) { clock.value = time; timer.fire(); link.flush(); } };
}

describe('progress data contract', () => {
    it('copies, freezes and canonically orders records without rounding fractional catalog IDs', () => {
        const input = value(), result = parseCombatProgress(input, limits);
        input.captured[0].count = 100; input.routes[0].location.route = 99;
        expect(result.captured).toEqual([{ pokemonId: 16, count: 1 }, { pokemonId: 19.01, count: 1 }]);
        expect(result.routes[0].location.route).toBe(1); expect(Object.isFrozen(result.routes[0].location)).toBe(true);
        expect(Object.isFrozen(result.captured[0])).toBe(true); expect(Object.isFrozen(result)).toBe(true);
    });
    it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10', null])('rejects invalid totals %s', invalid => {
        expect(() => parseCombatProgress({ ...value(), money: invalid }, limits)).toThrow();
    });
    it.each([
        data => { delete data.money; }, data => { data.hidden = 1; },
        data => { data.captured[0].count = 0; }, data => { data.captured[0].pokemonId = Infinity; },
        data => { data.routes[0].location.route = 0; }, data => { data.routes[0].captures = 2; },
        data => { data.defeats++; }, data => { data.captured[0].count++; },
        data => { data.captured[0].pokemonId = data.captured[1].pokemonId; },
        data => { data.routes[0].location = data.routes[1].location; },
        data => { data.routes = new Array(2); }, data => { data.captured.extra = true; },
        data => { data.routes[0].defeats = Number.MAX_SAFE_INTEGER; },
    ])('rejects malformed or inconsistent progress %#', mutate => {
        const input = value(); mutate(input); expect(() => parseCombatProgress(input, limits)).toThrow();
    });
    it('rejects bounded lists and accessor properties before evaluating any getter', () => {
        const getter = vi.fn(), input = value();
        Object.defineProperty(input.captured, '0', { get: getter });
        expect(() => parseCombatProgress(input, { ...limits, maxCaptured: 1 })).toThrow(/bound/);
        expect(() => parseCombatProgress(input, limits)).toThrow(/dense/); expect(getter).not.toHaveBeenCalled();
        const other = value(); Object.defineProperty(other, 'money', { get: getter });
        expect(() => parseCombatProgress(other, limits)).toThrow(); expect(getter).not.toHaveBeenCalled();
    });
    it('does not execute an array prototype iterator or map override', () => {
        const input = value(), callback = vi.fn(() => { throw new Error('must not execute'); });
        Object.setPrototypeOf(input.captured, { [Symbol.iterator]: callback, map: callback });
        expect(parseCombatProgress(input, limits).captured).toHaveLength(2); expect(callback).not.toHaveBeenCalled();
    });
    it('requires progress and combat together and rejects invalid frame envelopes', () => {
        const engine = new RouteCombatSimulation('progress', configuration, scenario, 123);
        expect(parseCombatFrame({ snapshot: engine.snapshot, progress: engine.progress }, limits).snapshot.sequence).toBe(0);
        expect(() => parseCombatFrame({ snapshot: engine.snapshot }, limits)).toThrow();
        expect(() => parseCombatFrame({ snapshot: engine.snapshot, progress: engine.progress, extra: true }, limits)).toThrow();
    });
});

describe('committed progression delivery', () => {
    it('retains the progress for each committed batch when later advances change the world', () => {
        const engine = new RouteCombatSimulation('progress', configuration, scenario, 123);
        const first = engine.advanceTo(1000), later = engine.advanceTo(4000);
        expect(first.progress.defeats).toBe(0); expect(later.progress.defeats).toBe(1);
        expect(first.progress.money).toBe(0); expect(later.progress).toEqual(engine.progress);
        expect(Object.isFrozen(later.progress.routes[0])).toBe(true);
    });
    it('direct host exposes an atomic frame while retained batches keep their earlier totals', () => {
        const timer = new ManualScheduler(); let now = 0;
        const host = new DirectCombatHost({ sessionId: 'progress', configuration, scenario, seed: 123, now: () => now, scheduler: timer });
        host.start(); now = 1000; timer.fire(); const oldest = host.pendingOutput;
        now = 4000; timer.fire(); expect(host.latestFrame.progress.defeats).toBe(1);
        expect(host.latestFrame.snapshot.atMs).toBe(4000); expect(oldest.progress.defeats).toBe(0); host.dispose();
    });
    it('worker publishes progress for the delivered batch rather than the newer queued world', async () => {
        const x = setup(); await x.call(x.host.initialize()); await x.call(x.host.start());
        for (const time of [1000, 2000, 3000, 4000]) x.wake(time);
        expect(x.host.latestFrame.snapshot.atMs).toBe(1000); expect(x.host.progress.defeats).toBe(0);
        await x.call(x.host.acknowledge(x.host.latest.sequence)); expect(x.host.progress.defeats).toBe(0);
        await x.call(x.host.acknowledge(x.host.latest.sequence)); expect(x.host.latest.atMs).toBe(3000); expect(x.host.progress.defeats).toBe(1);
        expect(x.host.latestFrame.progress).toBe(x.host.pendingOutput.progress); x.host.dispose();
    });
    it('restores version-one checkpoints with reordered progress before the first wake', async () => {
        const engine = new RouteCombatSimulation('saved', configuration, scenario, 123); engine.advanceTo(4000);
        engine.submit({ protocolVersion: 1, sessionId: 'saved', sequence: 1, atMs: 4001, type: 'ChangeRoute', destination: { region: 0, route: 2 } }); engine.advanceTo(8000);
        const saved = JSON.parse(JSON.stringify(engine.checkpoint())); saved.progress.routes.reverse(); saved.progress.captured.reverse();
        const x = setup({ formatVersion: 1, activeTimeMs: 8000, combat: saved }); await x.call(x.host.initialize());
        expect(x.host.state).toBe('stopped'); expect(x.host.progress).toEqual(engine.progress); expect(x.host.latest.sessionId).toBe('progress');
        expect(x.host.latest.atMs).toBe(8000); expect(x.host.latestFrame.progress.routes[0].location.route).toBe(1); x.host.dispose();
    });
    it.each(['missing', 'negative', 'catalog', 'inventory', 'event-count', 'captures', 'click-count'])('rejects %s progress without publishing a partial frame', async mode => {
        const x = setup(); await x.call(x.host.initialize()); await x.call(x.host.start()); x.wake(100); await x.call(x.host.acknowledge(1));
        const before = x.host.latestFrame, batch = { snapshot: { ...before.snapshot, sequence: 2, atMs: 200 }, progress: structuredClone(before.progress), events: [], commands: [], remainingMs: 0 };
        if (mode === 'missing') delete batch.progress;
        if (mode === 'negative') batch.progress.money = -1;
        if (mode === 'inventory') batch.progress.pokeballs++;
        if (mode === 'click-count') batch.progress.clickAttacks++;
        if (['catalog', 'event-count', 'captures'].includes(mode)) {
            batch.progress.defeats = 1; batch.progress.pokeballs = 1;
            batch.progress.routes = [{ location: { region: 0, route: mode === 'catalog' ? 99 : 1 }, defeats: 1, captures: mode === 'captures' ? 1 : 0 }];
            if (mode === 'captures') batch.progress.captured = [{ pokemonId: 16, count: 1 }];
        }
        x.link.endpoints[0].receive({ version: WORKER_PROTOCOL_VERSION, sessionId: 'progress', type: 'output', batch });
        expect(x.host.state).toBe('faulted'); expect(x.host.latestFrame).toBe(before); expect(x.host.pendingOutput).toBeNull(); x.host.dispose();
    });
    it('rejects regressing rewards after otherwise consistent earlier progress', async () => {
        const x = setup(); await x.call(x.host.initialize()); await x.call(x.host.start()); x.wake(4000); await x.call(x.host.acknowledge(x.host.latest.sequence));
        const before = x.host.latestFrame;
        const batch = { snapshot: { ...before.snapshot, sequence: before.snapshot.sequence + 1, atMs: before.snapshot.atMs + 100 },
            progress: { ...before.progress, money: before.progress.money - 1 }, events: [], commands: [], remainingMs: 0 };
        x.link.endpoints[0].receive({ version: WORKER_PROTOCOL_VERSION, sessionId: 'progress', type: 'output', batch });
        expect(x.host.fault.message).toMatch(/regressed/); expect(x.host.latestFrame).toBe(before); x.host.dispose();
    });
    it('rejects forged initial progress before exposing a ready session', async () => {
        const x = setup(); const pending = x.host.initialize(); x.link.queue.shift()();
        x.link.ports[1].sent.at(-1).result.progress.money = 1; x.link.flush();
        await expect(pending).rejects.toThrow(/requested progress/); expect(x.host.latestFrame).toBeNull(); x.host.dispose();
    });
    it('rejects a valid-looking checkpoint whose progress differs from delivered totals', async () => {
        const x = setup(); await x.call(x.host.initialize());
        const promise = x.host.checkpoint(); x.link.queue.shift()();
        const reply = x.link.ports[1].sent.at(-1); reply.result.checkpoint.combat.progress.money++;
        // send() stores the same detached message that is queued for delivery.
        x.link.flush(); await expect(promise).rejects.toThrow(/delivered state/); expect(x.host.progress.money).toBe(0); x.host.dispose();
    });
});
