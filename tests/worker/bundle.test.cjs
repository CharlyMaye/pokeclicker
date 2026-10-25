const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('ts-node').register({ transpileOnly: true, skipProject: true, compilerOptions: { module: 'CommonJS', target: 'ES2020' } });
const { WorkerCombatHost } = require('../../src/runtime/worker/WorkerCombatHost.ts');
const { RouteCombatSimulation } = require('../../src/simulation/combat/RouteCombatSimulation.ts');
const { PresentationLoop } = require('../../src/client/combat/PresentationLoop.ts');
const combat = require('../../public/config/combat.json');
const simulation = require('../../public/config/simulation.json');
const scenario = require('../fixtures/simulation/route-transitions.json');
const { compileRouteScenario } = require('../../src/simulation/content/compileRouteScenario.ts');
const compiledScenario = compileRouteScenario(require('../fixtures/simulation/route-content.json'), require('../../public/config/route-health.json'));
const { prepareRouteSession } = require('../../src/simulation/content/prepareRouteSession.ts');
const preparedScenario = prepareRouteSession({ content: require('../fixtures/simulation/route-content.json'), healthPolicy: require('../../public/config/route-health.json'),
    damage: require('../fixtures/simulation/damage-snapshot.json'), encounters: require('../fixtures/simulation/encounter-snapshot.json'), encounterPolicy: require('../../public/config/encounter-rules.json') });
const { prepareSampledRouteSession } = require('../../src/simulation/content/prepareSampledRouteSession.ts');
const sampledScenario = prepareSampledRouteSession({ content: require('../fixtures/simulation/route-content.json'), healthPolicy: require('../../public/config/route-health.json'),
    damage: require('../fixtures/simulation/damage-snapshot.json'), spawnRules: { policy: require('../../public/config/encounter-rules.json'), opponents: require('../fixtures/simulation/spawn-profiles.json') } });
const weightedScenario = require('../fixtures/simulation/weighted-encounters.json');
const policy = require('../fixtures/runtime/worker-policy.json');
const session = { configuration: { combat, simulation }, scenario, seed: 123 };

async function launch(t, nativeClock = false, checkpoint, sessionId = 'bundle', definition = scenario) {
    const worker = new Worker(path.resolve(__dirname, 'browser-scope.cjs'), { workerData: { bundle: path.resolve(__dirname, '../../build/ecs/combat.worker.js'), nativeClock } });
    let tickId = 0;
    const ticks = new Map();
    worker.on('message', data => { if (data.test === 'tick') { ticks.get(data.id)?.(); ticks.delete(data.id); } });
    const host = new WorkerCombatHost({ sessionId, session: { ...session, scenario: definition, ...(checkpoint ? { checkpoint } : {}) }, ...policy,
        deadlines: { schedule(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } },
        transport: {
            send: data => worker.postMessage(data), close: () => { void worker.terminate(); },
            listen(receive, fail) {
                const message = data => { if (!data.test) receive(data); };
                const exit = code => fail(new Error(`Unexpected worker exit ${code}`));
                worker.on('message', message); worker.on('error', fail); worker.on('messageerror', fail); worker.on('exit', exit);
                return () => { worker.off('message', message); worker.off('error', fail); worker.off('messageerror', fail); worker.off('exit', exit); };
            },
        },
    });
    t.after(async () => { host.dispose(); await worker.terminate(); });
    const tick = (atMs, wake = true) => new Promise(resolve => {
        const id = ++tickId; ticks.set(id, resolve); worker.postMessage({ test: wake ? 'wake' : 'clock', atMs, id });
    });
    await host.initialize(); await host.start();
    return { host, tick };
}

for (const framesPerWake of [0, 1, 7]) {
    test(`emitted worker matches direct combat with ${framesPerWake} display frames and renderer replacement`, { timeout: 15000 }, async t => {
        const { host, tick } = await launch(t);
        const direct = new RouteCombatSimulation('bundle', session.configuration, scenario, session.seed);
        let frame;
        let firstFrames = 0, replacementFrames = 0, disposed = 0;
        const scheduler = { request(callback) { frame = callback; return () => { frame = null; }; } };
        let display = new PresentationLoop(host, scheduler, { render() { firstFrames++; }, dispose() { disposed++; } });
        if (framesPerWake) display.start();
        let eventCount = 0;
        for (let time = 50; time <= 12000; time += 50) {
            await tick(time, false);
            if (time <= 150 || time === 200) {
                const input = time === 200 ? { type: 'ChangeRoute', destination: { region: 0, route: 2 } } : { type: 'ClickAttack' };
                direct.submit(await host.submit(input));
            }
            if (time % 100) continue;
            const expected = direct.advanceTo(time);
            await tick(time);
            assert.deepEqual(host.pendingOutput, expected);
            eventCount += expected.events.length;
            for (let n = 0; n < framesPerWake; n++) frame();
            if (time === 300) {
                assert.equal(host.latest.encounter.phase, 'capturing');
                const stale = frame;
                display.dispose();
                display = new PresentationLoop(host, scheduler, { render() { replacementFrames++; }, dispose() { disposed++; } });
                if (framesPerWake) { display.start(); stale(); }
            }
            await host.acknowledge(host.pendingOutput.snapshot.sequence);
        }
        assert.equal(host.fault, null);
        assert.ok(eventCount > 0);
        assert.deepEqual(host.latest, direct.snapshot);
        assert.equal(firstFrames, 3 * framesPerWake);
        assert.equal(replacementFrames, 117 * framesPerWake);
        display.dispose(); assert.equal(disposed, 2);
    });
}

test('native worker timers continue while the main thread is blocked, then respect bounded output', { timeout: 15000 }, async t => {
    const { host, tick } = await launch(t, true);
    // A synchronous main-thread stall does not prevent the worker from running its timer loop.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    await host.stop();
    let batches = 0;
    let previous = 0;
    while (host.pendingOutput) {
        assert.ok(host.latest.atMs > previous);
        previous = host.latest.atMs;
        await host.acknowledge(host.pendingOutput.snapshot.sequence);
        // Worker sends acknowledgment before the following batch; allow that queued message to arrive.
        await tick(0, false);
        batches++;
    }
    assert.ok(batches >= 2, 'The worker must have committed multiple batches during the main-thread stall');
    assert.ok(batches <= simulation.maxPendingOutputs, 'Worker FIFO stays bounded without acknowledgments');
    assert.equal(host.state, 'stopped');
    assert.equal(host.fault, null);
});


for (const [label, definition] of [['uniform', scenario], ['weighted', weightedScenario], ['compiled', compiledScenario], ['prepared', preparedScenario], ['sampled', sampledScenario]]) {
    test(`save, terminate and restore the emitted ${label} worker without changing combat outcomes`, { timeout: 15000 }, async t => {
        const { CheckpointStore } = require('../../src/runtime/persistence/CheckpointStore.ts');
        const storagePolicy = require('../fixtures/runtime/checkpoint-policy.json');
        const bytes = new Map();
        const store = new CheckpointStore({ getItem: key => bytes.get(key) ?? null, setItem: (key, value) => bytes.set(key, value) },
            { run: async (_name, operation) => operation() }, { ...storagePolicy, ...session, scenario: definition });
        const original = await launch(t, false, undefined, 'bundle', definition);
        const direct = new RouteCombatSimulation('bundle', session.configuration, definition, session.seed);
        for (const time of [50, 100, 150]) {
            await original.tick(time, false);
            direct.submit(await original.host.submit({ type: 'ClickAttack' }));
        }
        await original.tick(300); direct.advanceTo(300);
        await original.tick(325, false);
        direct.submit(await original.host.submit({ type: 'ChangeRoute', destination: { region: 0, route: 2 } }));
        await original.host.stop(); await original.host.acknowledge(3);
        const checkpoint = await original.host.checkpoint();
        assert.equal(checkpoint.combat.snapshot.encounter.phase, 'capturing');
        await store.write(checkpoint, null);
        original.host.dispose();
        const resumed = await launch(t, false, store.read().checkpoint, 'restored', definition);
        const normalize = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'sessionId' ? 'session' : item));
        let firstEvent;
        for (let time = 400; time <= 12000; time += 100) {
            await resumed.tick(time - 325, false);
            if (time === 600) {
                const command = await resumed.host.submit({ type: 'ClickAttack' });
                direct.submit({ ...command, sessionId: 'bundle' });
            }
            const expected = direct.advanceTo(time);
            await resumed.tick(time - 325);
            assert.deepEqual(normalize(resumed.host.pendingOutput), normalize(expected));
            firstEvent ??= resumed.host.pendingOutput.events[0];
            await resumed.host.acknowledge(resumed.host.pendingOutput.snapshot.sequence);
        }
        await resumed.host.stop();
        const final = await resumed.host.checkpoint();
        assert.equal(firstEvent.sequence, checkpoint.combat.eventSequence + 1);
        assert.deepEqual(normalize(final.combat), normalize(direct.checkpoint()));
        assert.equal(final.activeTimeMs, 12000);
        assert.equal(resumed.host.fault, null);
    });

}
