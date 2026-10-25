import { describe, expect, it, vi, afterEach } from 'vitest';
import { CombatWorkerServer } from '../../src/runtime/worker/CombatWorkerServer';
import { WorkerCombatHost } from '../../src/runtime/worker/WorkerCombatHost';
import { createBrowserCombatHost } from '../../src/runtime/worker/browserWorker';
import { parseRequest, parseResponse, parseInput, parseSession } from '../../src/runtime/worker/protocol';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import { ManualScheduler, channel } from '../helpers/combat-channel';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import scenario from '../fixtures/simulation/route-transitions.json';
import policy from '../fixtures/runtime/worker-policy.json';

const session = { configuration: { combat, simulation }, scenario, seed: 123 };
const click = { type: 'ClickAttack' };
function setup(overrides = {}) {
    const link = channel();
    const clock = { value: 0 }, timer = new ManualScheduler(), deadlines = new ManualScheduler();
    const server = new CombatWorkerServer(link.ports[1], () => clock.value, timer);
    const host = new WorkerCombatHost({ sessionId: 'worker', session, ...policy, transport: link.ports[0], deadlines, ...overrides });
    const call = promise => { link.flush(); return promise; };
    const wake = value => { clock.value = value; timer.fire(); link.flush(); };
    return { link, clock, timer, deadlines, server, host, call, wake };
}
async function started(overrides) {
    const context = setup(overrides);
    await context.call(context.host.initialize());
    await context.call(context.host.start());
    return context;
}
const reply = (requestId, result) => ({ version: 1, sessionId: 'worker', type: 'reply', requestId, result });

describe('worker execution and delivery', () => {
    it('matches the direct engine across inputs, route changes and captures', async () => {
        const { host, clock, call, wake } = await started();
        const direct = new RouteCombatSimulation('worker', session.configuration, scenario, session.seed);
        const expectedEvents = [], receivedEvents = [], receivedCommands = [];
        for (let time = 50; time <= 12000; time += 50) {
            clock.value = time;
            if (time <= 150 || time === 200) {
                const input = time === 200 ? { type: 'ChangeRoute', destination: { region: 0, route: 2 } } : click;
                const command = await call(host.submit(input));
                direct.submit(command);
                expect(Object.isFrozen(command)).toBe(true);
            }
            if (time % 100) continue;
            const expected = direct.advanceTo(time);
            wake(time);
            expect(host.pendingOutput).toEqual(expected);
            expectedEvents.push(...expected.events);
            receivedEvents.push(...host.pendingOutput.events);
            receivedCommands.push(...host.pendingOutput.commands);
            expect(Object.isFrozen(host.pendingOutput.events)).toBe(true);
            await call(host.acknowledge(host.pendingOutput.snapshot.sequence));
        }
        expect(receivedEvents).toEqual(expectedEvents);
        expect(receivedEvents.some(event => event.type === 'CaptureResolved')).toBe(true);
        expect(receivedCommands).toHaveLength(4);
        expect(host.latest).toEqual(direct.snapshot);
        host.dispose();
    });

    it('bounds delivery independently of display reads and resumes after FIFO acknowledgment', async () => {
        const { host, call, wake, timer, clock, link } = await started();
        for (let time = 100; time <= 800; time += 100) wake(time);
        expect(timer.active).toHaveLength(0);
        expect(host.latest.atMs).toBe(100);
        expect(link.ports[1].sent.filter(value => value.type === 'output')).toHaveLength(1);
        clock.value = 900;
        await expect(call(host.submit(click))).rejects.toThrow('output capacity');
        await expect(host.acknowledge(8)).rejects.toThrow('oldest');
        expect(host.pendingOutput.snapshot.sequence).toBe(1);
        await call(host.acknowledge(1));
        expect(host.pendingOutput.snapshot.sequence).toBe(2);
        expect(timer.active).toHaveLength(1);
        wake(10000);
        for (let sequence = 2; sequence <= 8; sequence++) await call(host.acknowledge(sequence));
        expect(host.latest.atMs).toBe(10000);
        host.dispose();
    });

    it('excludes stopped time and stamps input at worker ingress after a committed boundary', async () => {
        const { host, call, wake, clock } = await started();
        wake(100);
        const command = await call(host.submit(click));
        expect(command.atMs).toBe(101);
        await call(host.acknowledge(1));
        await call(host.stop());
        await expect(call(host.submit(click))).rejects.toThrow('running');
        clock.value = 10000;
        await call(host.start());
        wake(10100);
        expect(host.latest.atMs).toBe(200);
        expect(host.pendingOutput.commands).toEqual([{ sequence: 1, atMs: 101, result: 'applied' }]);
        host.dispose();
    });

    it('rejects excessive time debt without consuming a command sequence', async () => {
        const { host, clock, call, wake } = await started();
        clock.value = 20000;
        await expect(call(host.submit(click))).rejects.toThrow('horizon');
        wake(20000);
        await call(host.acknowledge(host.pendingOutput.snapshot.sequence));
        wake(20100);
        const accepted = await call(host.submit(click));
        expect(accepted.sequence).toBe(1);
        host.dispose();
    });

    it('permits only one pending RPC and does not consume IDs on local rejection', async () => {
        const { host, call, link } = setup();
        const initializing = host.initialize();
        await expect(host.start()).rejects.toThrow('pending');
        await call(initializing);
        await call(host.start());
        expect(link.ports[0].sent.map(request => request.requestId)).toEqual([1, 2]);
        host.dispose();
    });

    it('retains received data when a consumer throws and terminates the transport', async () => {
        const { host, wake, link } = await started({ onOutputAvailable: () => { throw new Error('Consumer failed'); } });
        wake(100);
        expect(host.state).toBe('faulted');
        expect(host.fault.message).toBe('Consumer failed');
        expect(host.pendingOutput.snapshot.atMs).toBe(100);
        expect(link.ports[0].closed).toBe(true);
    });

    it('rejects asynchronous notifications without an unhandled rejection', async () => {
        const { host, wake } = await started({ onOutputAvailable: () => Promise.reject(new Error('async')) });
        wake(100);
        await Promise.resolve();
        expect(host.fault.message).toContain('synchronous');
    });

    it('reports simulation faults and preserves the last delivered projection', async () => {
        const limited = { ...session, configuration: { combat, simulation: { ...simulation, maxTransitionsPerStep: 1 } } };
        const { host, clock, wake, call, timer } = await started({ session: limited });
        clock.value = 50;
        await call(host.submit(click));
        wake(100);
        expect(host.fault.message).toContain('transition budget');
        expect(host.latest.atMs).toBe(0);
        expect(timer.active).toHaveLength(0);
    });

    it('reports a regressing worker clock', async () => {
        const { host, call, clock, wake } = await started();
        clock.value = 50;
        await call(host.submit(click));
        wake(20);
        expect(host.state).toBe('faulted');
        expect(host.fault.message).toContain('monotonic');
    });
});

describe('transport faults and lifecycle', () => {
    it('terminates on an initialization timeout and ignores a late response', async () => {
        const { host, deadlines, link } = setup();
        const waiting = host.initialize();
        const rejected = expect(waiting).rejects.toThrow('deadline');
        const staleReceive = link.endpoints[0].receive;
        deadlines.fire();
        await rejected;
        expect(link.ports[0].closed).toBe(true);
        link.flush();
        staleReceive(reply(1, { type: 'done' }));
        expect(host.latest).toBeNull();
    });

    it('does not retry input when its acknowledgment is lost', async () => {
        const { host, clock, deadlines, link } = await started();
        clock.value = 50;
        const pending = host.submit(click);
        const rejected = expect(pending).rejects.toThrow('outcome may be unknown');
        link.queue.shift()(); // Commit in worker but leave reply undelivered.
        deadlines.fire();
        await rejected;
        expect(link.ports[0].sent.filter(request => request.payload.type === 'input')).toHaveLength(1);
        expect(host.state).toBe('faulted');
    });

    it('disposes idempotently, rejects pending work and invalidates late timers', async () => {
        const { host, deadlines, link } = setup();
        const pending = host.initialize();
        const rejected = expect(pending).rejects.toThrow('disposed');
        const timer = deadlines.active[0];
        host.dispose(); host.dispose();
        timer.callback(); link.flush();
        await rejected;
        expect(host.state).toBe('disposed');
        expect(deadlines.active).toHaveLength(0);
        await expect(host.start()).rejects.toThrow('disposed');
    });

    it('fails closed for message deserialization errors', async () => {
        const { host, link } = await started();
        link.endpoints[0].fail(new Error('Cannot deserialize'));
        expect(host.fault.message).toBe('Cannot deserialize');
        expect(link.ports[0].closed).toBe(true);
    });

    it('fails closed when postMessage throws', async () => {
        const { host, link, call } = setup();
        await call(host.initialize());
        link.ports[0].send = () => { throw new Error('Clone failed'); };
        await expect(host.start()).rejects.toThrow('Clone failed');
        expect(host.state).toBe('faulted');
    });

    it('rejects inline deadline scheduling', async () => {
        const { host } = setup({ deadlines: { schedule(callback) { callback(); return () => {}; } } });
        await expect(host.initialize()).rejects.toThrow('asynchronous');
        expect(host.state).toBe('faulted');
    });

    it('ignores canceled deadline callbacks after a completed request', async () => {
        const { host, deadlines, call } = setup();
        await call(host.initialize());
        deadlines.tasks[0].callback();
        expect(host.state).toBe('stopped');
        host.dispose();
    });

    it.each(['duplicate', 'foreign', 'wrong-kind'])('rejects a %s reply', async mode => {
        const { host, call, link } = setup();
        await call(host.initialize());
        if (mode === 'duplicate') {
            link.endpoints[0].receive(reply(1, { type: 'done' }));
        } else {
            const pending = host.start();
            const rejected = expect(pending).rejects.toThrow();
            link.endpoints[0].receive({ ...reply(2, { type: mode === 'wrong-kind' ? 'ready' : 'done', ...(mode === 'wrong-kind' ? { snapshot: host.latest } : {}) }), sessionId: mode === 'foreign' ? 'other' : 'worker' });
            await rejected;
        }
        expect(host.state).toBe('faulted');
    });

    it('closes the worker for replayed requests', async () => {
        const { host, link, call, timer } = setup();
        await call(host.initialize());
        await call(host.start());
        link.endpoints[1].receive(link.ports[0].sent[1]); link.flush();
        expect(host.fault.message).toContain('contiguous');
        expect(timer.active).toHaveLength(0);
        expect(link.ports[1].closed).toBe(true);
    });
});

describe('worker data boundaries', () => {
    it('copies and freezes initialization data', () => {
        const parsed = parseSession(session);
        expect(parsed).toEqual(session);
        expect(Object.isFrozen(parsed.scenario.routes[0].opponents)).toBe(true);
        expect(parsed.scenario).not.toBe(session.scenario);
    });
    it.each([null, {}, { type: 'Other' }, { type: 'ClickAttack', atMs: 0 }, { type: 'ChangeRoute', destination: { region: 0, route: 0 } }, Object.create({ type: 'ClickAttack' })])('rejects malformed input %j', value => {
        expect(() => parseInput(value)).toThrow();
    });
    it('does not invoke accessors', () => {
        const getter = vi.fn();
        expect(() => parseInput({ get type() { getter(); return 'ClickAttack'; } })).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });
    it('rejects unknown fields and versions in envelopes', () => {
        const request = { version: 1, sessionId: 'worker', requestId: 1, payload: { type: 'start' } };
        expect(parseRequest(request, 'worker')).toEqual(request);
        expect(() => parseRequest({ ...request, version: 2 }, 'worker')).toThrow();
        expect(() => parseRequest({ ...request, extra: true }, 'worker')).toThrow();
    });
    it('rejects oversized batches before iterating their contents', async () => {
        const { host, call } = setup();
        await call(host.initialize());
        expect(() => parseResponse({ version: 1, sessionId: 'worker', type: 'output', batch: {
            snapshot: host.latest, events: [], commands: new Array(simulation.maxQueuedCommands + 1), remainingMs: 0,
        } }, 'worker', session.configuration)).toThrow('limits');
        host.dispose();
    });
    it.each(['gap', 'foreign-event', 'future-event', 'unknown-command', 'invalid-outcome', 'duplicate-output'])('does not commit a malformed %s batch', async mode => {
        const { host, wake, link } = await started();
        wake(100);
        const original = host.latest;
        if (mode !== 'duplicate-output') {
            // Acknowledge so the injected record tests validation rather than queue capacity.
            const promise = host.acknowledge(1); link.flush(); await promise;
        }
        const batch = { snapshot: { ...original, sequence: 2, atMs: 200 }, events: [], commands: [], remainingMs: 0 };
        if (mode === 'gap' || mode.includes('event')) batch.events.push({ protocolVersion: 1, sessionId: mode === 'foreign-event' ? 'other' : 'worker', type: 'EnemyDefeated', sequence: mode === 'gap' ? 2 : 1, atMs: mode === 'future-event' ? 300 : 150, encounterId: 1, pokemonId: 16 });
        if (mode.includes('command') || mode === 'invalid-outcome') batch.commands.push({ sequence: 1, atMs: 150, result: mode === 'invalid-outcome' ? 'invented' : 'applied' });
        link.endpoints[0].receive({ version: 1, sessionId: 'worker', type: 'output', batch });
        expect(host.state).toBe('faulted');
        expect(host.latest).toBe(original);
    });
});

class FakeWorker {
    static instances = [];
    listeners = new Map();
    sent = [];
    terminated = 0;
    constructor(url, options) { this.url = url; this.options = options; FakeWorker.instances.push(this); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type) { this.listeners.delete(type); }
    postMessage(value) { this.sent.push(value); }
    terminate() { this.terminated++; }
}
afterEach(() => vi.unstubAllGlobals());
describe('browser worker ownership', () => {
    it('uses an explicit subpath URL and cleans up error/messageerror listeners', async () => {
        vi.stubGlobal('Worker', FakeWorker);
        const promise = createBrowserCombatHost(new URL('https://example.test/pokeclicker/ecs/combat.worker.js'), { sessionId: 'worker', session, ...policy });
        const worker = FakeWorker.instances.at(-1);
        expect(worker.url.pathname).toBe('/pokeclicker/ecs/combat.worker.js');
        expect([...worker.listeners.keys()]).toEqual(['message', 'error', 'messageerror']);
        worker.listeners.get('messageerror')();
        await expect(promise).rejects.toThrow('deserialized');
        expect(worker.listeners.size).toBe(0);
        expect(worker.terminated).toBe(1);
    });
    it('terminates a worker if local option validation fails', async () => {
        vi.stubGlobal('Worker', FakeWorker);
        await expect(createBrowserCombatHost(new URL('https://example.test/ecs/combat.worker.js'), { sessionId: 'worker', session, requestTimeoutMs: 0 })).rejects.toThrow('positive');
        expect(FakeWorker.instances.at(-1).terminated).toBe(1);
    });
    it('rejects credentials and non-HTTP asset URLs', async () => {
        await expect(createBrowserCombatHost(new URL('data:application/javascript,0'), { sessionId: 'worker', session, ...policy })).rejects.toThrow('HTTP');
        await expect(createBrowserCombatHost(new URL('https://secret@example.test/worker.js'), { sessionId: 'worker', session, ...policy })).rejects.toThrow('credentials');
    });
});
