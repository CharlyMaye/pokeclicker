const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('ts-node').register({ transpileOnly: true, skipProject: true, compilerOptions: { module: 'CommonJS', target: 'ES2020' } });
const { WorkerCombatHost } = require('../../src/runtime/worker/WorkerCombatHost.ts');
const { RouteCombatSimulation } = require('../../src/simulation/combat/RouteCombatSimulation.ts');
const { applyDamageSnapshot } = require('../../src/simulation/damage/resolveDamage.ts');
const configuration = { combat: require('../../public/config/combat.json'), simulation: require('../../public/config/simulation.json') };
const source = require('../fixtures/simulation/weighted-encounters.json');
const damage = require('../fixtures/simulation/damage-snapshot.json');
const policy = require('../fixtures/runtime/worker-policy.json');

async function launch(t, scenario, checkpoint) {
    const worker = new Worker(path.resolve(__dirname, 'browser-scope.cjs'), { workerData: { bundle: path.resolve(__dirname, '../../build/ecs/combat.worker.js'), nativeClock: false } });
    const pending = new Map(); let serial = 0;
    worker.on('message', data => { if (data.test === 'tick') { pending.get(data.id)?.(); pending.delete(data.id); } });
    const host = new WorkerCombatHost({ sessionId: 'damage-worker', session: { configuration, scenario, seed: 123, ...(checkpoint ? { checkpoint } : {}) }, ...policy,
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
    const tick = (atMs, wake = true) => new Promise(resolve => { const id = ++serial; pending.set(id, resolve); worker.postMessage({ test: wake ? 'wake' : 'clock', atMs, id }); });
    await host.initialize(); await host.start();
    return { host, tick };
}

test('resolved damage drives emitted worker attacks and survives a pending-capture restart', { timeout: 15000 }, async t => {
    const input = structuredClone(damage);
    input.opponents[0].party.multiplier = 2;
    input.click.multiplier = 1.5;
    const scenario = applyDamageSnapshot(source, input);
    const direct = new RouteCombatSimulation('damage-worker', configuration, scenario, 123);
    const original = await launch(t, scenario);
    await original.tick(1000);
    assert.deepEqual(original.host.pendingOutput, direct.advanceTo(1000));
    assert.equal(original.host.latest.encounter.enemy.health, 10);
    await original.host.acknowledge(original.host.pendingOutput.snapshot.sequence);
    await original.tick(1050, false);
    direct.submit(await original.host.submit({ type: 'ClickAttack' }));
    await original.tick(1100);
    assert.deepEqual(original.host.pendingOutput, direct.advanceTo(1100));
    assert.equal(original.host.latest.encounter.phase, 'capturing');
    await original.host.stop(); await original.host.acknowledge(original.host.pendingOutput.snapshot.sequence);
    await original.tick(1100, false);
    const saved = await original.host.checkpoint(); original.host.dispose();
    const resumed = await launch(t, scenario, JSON.parse(JSON.stringify(saved)));
    for (let target = 1200; target <= 8000; target += 100) {
        await resumed.tick(target - saved.activeTimeMs);
        assert.deepEqual(resumed.host.pendingOutput, direct.advanceTo(target));
        await resumed.host.acknowledge(resumed.host.pendingOutput.snapshot.sequence);
    }
    await resumed.host.stop();
    assert.deepEqual((await resumed.host.checkpoint()).combat, direct.checkpoint());
    assert.equal(resumed.host.fault, null);
});
