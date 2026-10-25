import { describe, expect, it, vi, afterEach } from 'vitest';
import { DirectCombatHost } from '../../src/runtime/combat/DirectCombatHost';
import { PresentationLoop } from '../../src/client/combat/PresentationLoop';
import { SimulationFault } from '../../src/simulation/combat/model';
import { browserWakeScheduler, browserFrameScheduler, browserMonotonicTime } from '../../src/runtime/scheduling/browserSchedulers';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import scenario from '../fixtures/simulation/route-transitions.json';

class ManualScheduler {
    tasks = [];
    schedule(callback, delayMs) {
        const task = { callback, delayMs, canceled: false, called: false };
        this.tasks.push(task);
        return () => { task.canceled = true; };
    }
    request(callback) { return this.schedule(callback, 0); }
    get active() { return this.tasks.filter(task => !task.canceled && !task.called); }
    fire() {
        const task = this.active[0];
        if (!task) throw new Error('Test scheduler has no pending callback');
        task.called = true;
        task.callback();
        return task;
    }
}

const configuration = { combat, simulation };
const click = (sequence, atMs) => ({ protocolVersion: 1, sessionId: 'loops', sequence, atMs, type: 'ClickAttack' });
const create = (settings = {}) => {
    const clock = { value: 1000 };
    const timer = new ManualScheduler();
    const host = new DirectCombatHost({ sessionId: 'loops', configuration, scenario, seed: 123,
        now: () => clock.value, scheduler: timer, ...settings });
    return { host, clock, timer };
};
function drain(host) {
    const outputs = [];
    while (host.pendingOutput) {
        const output = host.pendingOutput;
        outputs.push(output);
        host.acknowledge(output.snapshot.sequence);
    }
    return outputs;
}
const renderer = () => ({ render: vi.fn(), dispose: vi.fn() });

describe('independent simulation and display cadence', () => {
    it('runs simulation without a renderer and keeps start idempotent', () => {
        const { host, clock, timer } = create();
        expect(host.state).toBe('stopped');
        host.start(); host.start();
        expect(timer.active).toHaveLength(1);
        expect(timer.active[0].delayMs).toBe(simulation.stepMs);
        clock.value = 2000;
        timer.fire();
        expect(host.latest).toMatchObject({ atMs: 1000, encounter: { enemy: { health: 20 } } });
        expect(host.pendingOutputCount).toBe(1);
        expect(Object.isFrozen(host.pendingOutput.commands)).toBe(true);
    });

    it('has identical events, commands and progression with no display, slow frames or fast frames', () => {
        function run(framesPerWake) {
            const { host, clock, timer } = create();
            const frames = new ManualScheduler();
            const view = renderer();
            const display = new PresentationLoop(host, frames, view);
            [click(1, 50), click(2, 100), click(3, 150), { ...click(4, 200), type: 'ChangeRoute', destination: { region: 0, route: 2 } }]
                .forEach(command => host.submit(command));
            host.start();
            if (framesPerWake) display.start();
            const events = [], commands = [];
            for (let time = 100; time <= 10000; time += 100) {
                clock.value = 1000 + time;
                timer.fire();
                for (const output of drain(host)) {
                    events.push(...output.events);
                    commands.push(...output.commands);
                }
                for (let frame = 0; frame < framesPerWake; frame++) frames.fire();
            }
            const result = { events, commands, snapshot: host.latest, progress: host.progress };
            expect(view.render).toHaveBeenCalledTimes(100 * framesPerWake);
            if (framesPerWake) expect(view.render.mock.lastCall[0]).toBe(host.latest);
            display.dispose(); host.dispose();
            return result;
        }
        expect(run(1)).toEqual(run(0));
        expect(run(7)).toEqual(run(0));
    });

    it('replaces a failed renderer without restarting or changing simulation', () => {
        const { host, clock, timer } = create();
        const frames = new ManualScheduler();
        const broken = renderer();
        broken.render.mockImplementation(() => { throw new Error('Renderer failed'); });
        const first = new PresentationLoop(host, frames, broken);
        host.start(); first.start(); frames.fire();
        expect(first.state).toBe('faulted');
        expect(first.fault.message).toBe('Renderer failed');
        expect(host.state).toBe('running');
        clock.value = 4200;
        timer.fire();
        const before = host.progress;
        first.dispose();
        const next = renderer();
        const second = new PresentationLoop(host, frames, next);
        second.start(); frames.fire();
        expect(next.render).toHaveBeenCalledExactlyOnceWith(host.latest);
        expect(host.latest.atMs).toBe(3200);
        expect(host.progress).toEqual(before);
        expect(host.progress.defeats).toBe(1);
        expect(broken.dispose).toHaveBeenCalledTimes(1);
    });

    it('preserves millisecond input timestamps within a step and rejects late boundary input explicitly', () => {
        const { host, clock, timer } = create();
        host.start();
        [1049.9, 1050, 1100].forEach((time, index) => {
            clock.value = time;
            host.submit(click(index + 1, host.inputTimeMs()));
        });
        timer.fire();
        expect(host.pendingOutput.commands.map(command => [command.atMs, command.result])).toEqual([[49, 'cooldown'], [50, 'applied'], [100, 'applied']]);
        expect(() => host.submit(click(4, host.inputTimeMs()))).toThrow(/committed time/);
        clock.value = 1101;
        host.submit(click(4, host.inputTimeMs()));
        expect(host.fault).toBe(null);
    });
});

describe('bounded output and active time', () => {
    it('delivers output through a runtime consumer without requiring display frames or a polling loop', () => {
        let host;
        const received = [];
        const clock = { value: 1000 };
        const timer = new ManualScheduler();
        host = new DirectCombatHost({ sessionId: 'loops', configuration, scenario, seed: 123,
            now: () => clock.value, scheduler: timer, onOutputAvailable: () => received.push(...drain(host)) });
        host.start();
        clock.value = 1050;
        timer.fire();
        expect(received).toEqual([]);
        for (let time = 1100; time <= 5000; time += 100) {
            clock.value = time;
            timer.fire();
            expect(timer.active).toHaveLength(1);
        }
        expect(host.state).toBe('running');
        expect(host.pendingOutputCount).toBe(0);
        expect(received.flatMap(output => output.events).map(event => event.type)).toEqual(['EnemyDefeated', 'CaptureResolved']);
        expect(host.latest.atMs).toBe(4000);
    });

    it('pauses advancement at capacity without dropping output or active-time debt', () => {
        const config = { ...configuration, simulation: { ...simulation, maxPendingOutputs: 2, maxStepsPerAdvance: 2 } };
        const { host, clock, timer } = create({ configuration: config });
        host.start();
        clock.value = 2000;
        timer.fire(); timer.fire();
        expect(host.state).toBe('blocked');
        expect(host.latest.atMs).toBe(400);
        expect(host.pendingOutputCount).toBe(2);
        expect(host.pendingOutput).toMatchObject({ snapshot: { sequence: 2 }, remainingMs: 800 });
        expect(timer.active).toHaveLength(0);
        expect(() => host.acknowledge(4)).toThrow(/oldest/);
        expect(host.pendingOutputCount).toBe(2);
        clock.value = 3100;
        host.acknowledge(2);
        expect(timer.active).toHaveLength(1);
        timer.fire();
        expect(host.latest.atMs).toBe(600);
        expect(host.sampledTimeMs).toBe(2100);
        expect(host.pendingOutput.snapshot.sequence).toBe(4);
        host.acknowledge(4);
        expect(host.pendingOutput.remainingMs).toBe(1500);
        expect(() => host.acknowledge(4)).toThrow(/oldest/);
    });

    it('retains defeat and capture events independently of snapshot reads', () => {
        const { host, clock, timer } = create({ configuration: { ...configuration, simulation: { ...simulation, maxPendingOutputs: 1 } } });
        host.start();
        clock.value = 4000;
        timer.fire();
        expect(host.pendingOutput.events).toMatchObject([{ type: 'EnemyDefeated', sequence: 1 }]);
        const pending = host.pendingOutput;
        for (let i = 0; i < 10; i++) expect(host.latest).toBe(pending.snapshot);
        expect(host.pendingOutput).toBe(pending);
        expect(host.state).toBe('blocked');
        clock.value = 5000;
        host.acknowledge(pending.snapshot.sequence);
        timer.fire();
        expect(host.pendingOutput.events).toMatchObject([{ type: 'CaptureResolved', sequence: 2, atMs: 3200 }]);
        expect(host.progress.defeats).toBe(1);
    });

    it('excludes stopped time but preserves prior debt and fractional active time', () => {
        const { host, clock, timer } = create();
        host.start();
        const stale = timer.active[0];
        clock.value = 1050.5;
        expect(host.inputTimeMs()).toBe(50);
        clock.value = 1100.75;
        host.stop(); host.stop();
        expect(host.sampledTimeMs).toBe(100);
        expect(host.latest.atMs).toBe(0);
        expect(timer.active).toHaveLength(0);
        clock.value = 100000.25;
        host.start();
        stale.callback();
        expect(host.latest.atMs).toBe(0);
        expect(timer.active).toHaveLength(1);
        clock.value = 100050.5;
        timer.fire();
        expect(host.pendingOutput).toMatchObject({ snapshot: { atMs: 100 }, remainingMs: 51 });
        clock.value = 100099.5;
        timer.fire();
        expect(host.latest.atMs).toBe(200);
        expect(host.sampledTimeMs).toBe(200);
    });

    it('keeps blocked output across stop/resume and only schedules after capacity is released', () => {
        const { host, clock, timer } = create({ configuration: { ...configuration, simulation: { ...simulation, maxPendingOutputs: 1 } } });
        host.start(); clock.value = 1100; timer.fire();
        clock.value = 1150; host.stop();
        clock.value = 5000; host.start();
        expect(host.state).toBe('blocked');
        expect(timer.active).toHaveLength(0);
        host.acknowledge(1);
        clock.value = 5050; timer.fire();
        expect(host.latest.atMs).toBe(200);
    });

    it('disposes idempotently, ignores late wakes and retains unread output', () => {
        const { host, clock, timer } = create();
        host.start(); clock.value = 1100; timer.fire();
        const stale = timer.active[0];
        const output = host.pendingOutput;
        host.dispose(); host.dispose();
        clock.value = 5000; stale.callback();
        expect(host.state).toBe('disposed');
        expect(host.latest.atMs).toBe(100);
        expect(host.pendingOutput).toBe(output);
        expect(timer.active).toHaveLength(0);
        expect(() => host.start()).toThrow(/disposed/);
        expect(() => host.submit(click(1, 150))).toThrow(/disposed/);
        expect(() => host.acknowledge(1)).toThrow(/disposed/);
    });
});

describe('host faults and input rejection', () => {
    it('rejects asynchronous notification handlers without losing their committed output', async () => {
        const { host, clock, timer } = create({ onOutputAvailable: async () => { throw new Error('Async failure'); } });
        host.start(); clock.value = 1100; timer.fire();
        await Promise.resolve();
        expect(host.state).toBe('faulted');
        expect(host.fault.message).toMatch(/must be synchronous/);
        expect(host.pendingOutput.snapshot.atMs).toBe(100);
        expect(timer.active).toHaveLength(0);
    });

    it('retains a committed batch if its delivery notification fails before acknowledgment', () => {
        const { host, clock, timer } = create({ onOutputAvailable: () => { throw new Error('Delivery failed'); } });
        host.start(); clock.value = 4000; timer.fire();
        expect(host.state).toBe('faulted');
        expect(host.fault.message).toBe('Delivery failed');
        expect(host.latest.atMs).toBe(3000);
        expect(host.progress.defeats).toBe(1);
        expect(host.pendingOutput.events[0].type).toBe('EnemyDefeated');
        expect(timer.active).toHaveLength(0);
    });

    it('retains published output if scheduling the next wake fails', () => {
        const timer = new ManualScheduler();
        let requests = 0;
        const { host, clock } = create({ scheduler: { schedule: (callback, delay) => {
            if (++requests > 1) throw new Error('Next wake failed');
            return timer.schedule(callback, delay);
        } } });
        host.start(); clock.value = 1100; timer.fire();
        expect(host.state).toBe('faulted');
        expect(host.pendingOutput.snapshot.atMs).toBe(100);
        expect(host.latest.atMs).toBe(100);
    });

    it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])('stops on invalid clock value %s', value => {
        const { host, clock, timer } = create();
        host.start(); clock.value = value; timer.fire();
        expect(host.state).toBe('faulted');
        expect(host.latest.atMs).toBe(0);
        expect(timer.active).toHaveLength(0);
        expect(() => host.start()).toThrow(/clock/);
    });

    it('rejects a regressing clock and retains the last committed output', () => {
        const { host, clock, timer } = create();
        host.start(); clock.value = 1100; timer.fire();
        const before = host.latest;
        clock.value = 1099; timer.fire();
        expect(host.state).toBe('faulted');
        expect(host.latest).toBe(before);
        expect(host.pendingOutput.snapshot).toBe(before);
        host.acknowledge(before.sequence);
        expect(host.pendingOutput).toBe(null);
        expect(timer.active).toHaveLength(0);
    });

    it('isolates expected command errors from host failure and sequence state', () => {
        const { host, clock, timer } = create();
        expect(() => host.submit({ ...click(1, 50), damage: 999 })).toThrow();
        host.submit(click(1, 50));
        host.start(); clock.value = 1100; timer.fire();
        expect(host.fault).toBe(null);
        expect(host.pendingOutput.commands[0].sequence).toBe(1);
    });

    it('stops after a simulation fault while retaining earlier delivery and progression', () => {
        const rng = state => ({ state: state + 1, value: state === 123 ? 0.25 : NaN });
        const { host, clock, timer } = create({ random: rng });
        host.start(); clock.value = 2000; timer.fire();
        const before = host.latest;
        clock.value = 4200; timer.fire();
        expect(host.fault).toBeInstanceOf(SimulationFault);
        expect(host.latest).toBe(before);
        expect(host.progress.defeats).toBe(0);
        expect(host.pendingOutputCount).toBe(1);
        expect(timer.active).toHaveLength(0);
    });

    it('rejects inline scheduling and cancels the returned task', () => {
        const cancel = vi.fn();
        const { host } = create({ scheduler: { schedule: callback => { callback(); return cancel; } } });
        expect(() => host.start()).toThrow(/asynchronously/);
        expect(host.state).toBe('faulted');
        expect(host.latest.atMs).toBe(0);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('records scheduler failures and ignores a callback queued before a thrown request', () => {
        let callback;
        const { host } = create({ scheduler: { schedule: task => { callback = task; throw new Error('Scheduling failed'); } } });
        expect(() => host.start()).toThrow('Scheduling failed');
        callback();
        expect(host.latest.atMs).toBe(0);
        expect(host.state).toBe('faulted');
    });

    it('invalidates a canceled wake even if cancellation throws', () => {
        let callback;
        const { host } = create({ scheduler: { schedule: task => { callback = task; return () => { throw new Error('Cancellation failed'); }; } } });
        host.start();
        expect(() => host.stop()).toThrow('Cancellation failed');
        callback();
        expect(host.latest.atMs).toBe(0);
        expect(host.state).toBe('faulted');
    });

    it('rejects reentrant mutation from an injected clock', () => {
        let host;
        ({ host } = create({ now: () => { host.submit(click(1, 50)); return 1000; } }));
        expect(() => host.start()).toThrow(/reentered/);
        expect(host.state).toBe('faulted');
    });
});

describe('presentation lifecycle', () => {
    it('waits for a snapshot and renders only on its own frames', () => {
        const source = { latest: null };
        const frames = new ManualScheduler();
        const view = renderer();
        const display = new PresentationLoop(source, frames, view);
        display.start(); display.start();
        expect(frames.active).toHaveLength(1);
        frames.fire();
        expect(view.render).not.toHaveBeenCalled();
        source.latest = create().host.latest;
        frames.fire();
        expect(view.render).toHaveBeenCalledExactlyOnceWith(source.latest);
    });

    it('ignores late frames across restart and disposes renderer resources once', () => {
        const frames = new ManualScheduler();
        const view = renderer();
        const display = new PresentationLoop(create().host, frames, view);
        display.start();
        const stale = frames.active[0];
        display.stop(); display.start(); stale.callback();
        expect(view.render).not.toHaveBeenCalled();
        expect(frames.active).toHaveLength(1);
        frames.fire();
        display.dispose(); display.dispose(); stale.callback();
        expect(view.render).toHaveBeenCalledTimes(1);
        expect(view.dispose).toHaveBeenCalledTimes(1);
        expect(frames.active).toHaveLength(0);
        expect(() => display.start()).toThrow(/disposed/);
    });

    it('does not render an obsolete frame when a snapshot source stops and restarts it', () => {
        const frames = new ManualScheduler();
        const view = renderer();
        let display;
        const snapshot = create().host.latest;
        const source = { get latest() { display.stop(); display.start(); return snapshot; } };
        display = new PresentationLoop(source, frames, view);
        display.start(); frames.fire();
        expect(view.render).not.toHaveBeenCalled();
        expect(frames.active).toHaveLength(1);
    });

    it('isolates source and disposal failures and prevents restart after a fault', () => {
        const frames = new ManualScheduler();
        const view = renderer();
        view.dispose.mockImplementation(() => { throw new Error('Dispose failed'); });
        const display = new PresentationLoop({ get latest() { throw new Error('Source failed'); } }, frames, view);
        display.start(); frames.fire();
        expect(display.fault.message).toBe('Source failed');
        expect(() => display.start()).toThrow('Source failed');
        display.dispose();
        expect(display.state).toBe('disposed');
        expect(display.fault.message).toBe('Source failed');
        expect(frames.active).toHaveLength(0);
    });

    it('rejects an inline frame scheduler', () => {
        const cancel = vi.fn();
        const view = renderer();
        const display = new PresentationLoop(create().host, { request: callback => { callback(); return cancel; } }, view);
        expect(() => display.start()).toThrow(/asynchronously/);
        expect(view.render).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledTimes(1);
    });
});

describe('browser scheduling adapters', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('schedules real host wakes through browser timers and cancels them on disposal', () => {
        vi.useFakeTimers(); vi.setSystemTime(1000);
        const { host } = create({ scheduler: browserWakeScheduler, now: () => Date.now() });
        host.start(); vi.advanceTimersByTime(100);
        expect(host.latest.atMs).toBe(100);
        host.dispose(); vi.advanceTimersByTime(1000);
        expect(host.latest.atMs).toBe(100);
        expect(vi.getTimerCount()).toBe(0);
        expect(() => browserWakeScheduler.schedule(() => {}, 2 ** 31)).toThrow(/timer range/);
    });

    it('keeps animation frame cancellation separate from simulation timers', () => {
        const request = vi.fn(() => 42);
        const cancel = vi.fn();
        vi.stubGlobal('requestAnimationFrame', request);
        vi.stubGlobal('cancelAnimationFrame', cancel);
        vi.spyOn(performance, 'now').mockReturnValue(123.5);
        const task = vi.fn();
        const release = browserFrameScheduler.request(task);
        expect(request).toHaveBeenCalledExactlyOnceWith(task);
        release();
        expect(cancel).toHaveBeenCalledExactlyOnceWith(42);
        expect(browserMonotonicTime()).toBe(123.5);
    });
});
