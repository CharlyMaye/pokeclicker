const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../../tools/lab-configuration.cjs');
const { CombatLabController } = require('../../src/runtime/lab/CombatLabController.ts');
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}) {
    const hosts = [], displays = [], writes = [];
    let sequence = 0, record = null;
    const store = { read: () => record, async write(checkpoint, revision) { writes.push({ checkpoint, revision }); return record = { checkpoint, revision: 'saved' }; }, async recoverBackup() { return record; } };
    const controller = new CombatLabController({ store, frames: { request: () => () => {} }, initialRenderer: 'dom', maxPendingOutputs: 3,
        newSessionId: () => `lab-${++sequence}`, changed() {},
        async createHost(id, checkpoint, output, fault) {
            const host = { id, restored: checkpoint, output, notifyFault: fault, state: 'stopped', fault: null, latest: null, pendingOutput: null, acknowledged: [],
                async start() { this.state = 'running'; }, async stop() { this.state = 'stopped'; }, async submit(input) { this.input = input; },
                async acknowledge(sequence) { this.acknowledged.push(sequence); this.pendingOutput = null; },
                async checkpoint() { assert.equal(this.state, 'stopped'); assert.equal(this.pendingOutput, null); return { host: id }; },
                dispose() { this.state = 'disposed'; },
            }; hosts.push(host); return host;
        },
        createRenderer(kind, id) { const renderer = { kind, id, disposed: false, render() {}, dispose() { this.disposed = true; } }; displays.push(renderer); return renderer; }, ...overrides });
    return { controller, hosts, displays, store, writes, setRecord(value) { record = value; } };
}
test('renderer replacement preserves host and saving pauses, drains and tracks revision', async () => {
    const x = setup(); await x.controller.initialize(); const host = x.hosts[0];
    await x.controller.start(); await x.controller.attack(); assert.equal(host.input.type, 'ClickAttack');
    await x.controller.switchRenderer('knockout'); assert.equal(x.hosts.length, 1); assert.equal(x.displays[0].disposed, true);
    host.pendingOutput = { snapshot: { sequence: 2 } };
    await x.controller.save(); assert.deepEqual(host.acknowledged, [2]); assert.equal(host.state, 'stopped');
    await x.controller.save(); assert.deepEqual(x.writes.map(x => x.revision), [null, 'saved']); x.controller.dispose();
});
test('output acknowledgment runs without a display frame', async () => {
    const x = setup(); await x.controller.initialize(); const host = x.hosts[0];
    host.pendingOutput = { snapshot: { sequence: 1 } }; host.output(); await flush();
    assert.deepEqual(host.acknowledged, [1]); x.controller.dispose();
});
test('hidden page queues pause behind an in-flight start and never auto-resumes', async () => {
    const x = setup(); await x.controller.initialize(); const host = x.hosts[0]; let finish;
    host.start = () => new Promise(resolve => { finish = () => { host.state = 'running'; resolve(); }; });
    const pending = x.controller.start(); x.controller.setVisible(false);
    await assert.rejects(x.controller.attack(), /current operation/); finish(); await pending; await flush();
    assert.equal(host.state, 'stopped'); await assert.rejects(x.controller.start(), /returning/);
    x.controller.setVisible(true); assert.equal(host.state, 'stopped'); x.controller.dispose();
});
test('load creates a fresh stopped session and disposes the old view and worker', async () => {
    const x = setup(); await x.controller.initialize(); await x.controller.start();
    const checkpoint = { saved: true }; x.setRecord({ checkpoint, revision: 'loaded' });
    await x.controller.load(); assert.equal(x.hosts[0].state, 'disposed'); assert.equal(x.hosts[1].state, 'stopped');
    assert.equal(x.hosts[1].restored, checkpoint); assert.equal(x.displays[0].disposed, true);
    await x.controller.save(); assert.equal(x.writes[0].revision, 'loaded'); x.controller.dispose();
});
test('failed load preserves the original paused session', async () => {
    const x = setup(); await x.controller.initialize(); await x.controller.start();
    x.store.read = () => { throw new Error('corrupt'); };
    await assert.rejects(x.controller.load(), /corrupt/); assert.equal(x.hosts[0].state, 'stopped'); assert.equal(x.displays[0].disposed, false); x.controller.dispose();
});
test('failed renderer construction preserves active presentation', async () => {
    let fail = false; const x = setup({ createRenderer() { if (fail) throw new Error('renderer'); return { render() {}, dispose() {} }; } });
    await x.controller.initialize(); fail = true;
    await assert.rejects(x.controller.switchRenderer('knockout'), /renderer/); assert.equal(x.controller.rendererKind, 'dom'); assert.equal(x.hosts[0].state, 'stopped'); x.controller.dispose();
});
test('write failure leaves simulation paused and does not advance revision', async () => {
    const x = setup(); await x.controller.initialize(); const write = x.store.write;
    x.store.write = async () => { throw new Error('revision changed'); };
    await assert.rejects(x.controller.save(), /revision changed/); assert.equal(x.controller.state, 'stopped');
    x.store.write = write; await x.controller.save(); assert.equal(x.writes[0].revision, null); x.controller.dispose();
});
test('late initialization is disposed after page teardown', async () => {
    let finish; const host = { state: 'stopped', dispose() { this.state = 'disposed'; } };
    const x = setup({ createHost: () => new Promise(resolve => { finish = resolve; }) });
    const pending = x.controller.initialize(); x.controller.dispose(); finish(host);
    await assert.rejects(pending, /disposed/); assert.equal(host.state, 'disposed');
});
test('acknowledgment failure terminates the host without retrying recursively', async () => {
    const x = setup(); await x.controller.initialize(); const host = x.hosts[0]; let calls = 0;
    host.acknowledge = async () => { calls++; throw new Error('ack failed'); };
    host.pendingOutput = { snapshot: { sequence: 1 } }; host.output(); await flush();
    assert.equal(calls, 1); assert.equal(host.state, 'disposed'); assert.match(x.controller.lastError.message, /ack failed/); x.controller.dispose();
});
test('worker faults are surfaced immediately and stale session callbacks are ignored', async () => {
    let notifications = 0; const x = setup({ changed() { notifications++; } }); await x.controller.initialize();
    await x.controller.save(); await x.controller.load(); const before = notifications;
    x.hosts[0].notifyFault(new Error('old failure')); assert.equal(notifications, before);
    x.hosts[1].notifyFault(new Error('worker failed')); assert.match(x.controller.lastError.message, /worker failed/); assert.ok(notifications > before); x.controller.dispose();
});
test('checkpoint barrier drains batches posted after acknowledge replies', async () => {
    const x = setup(); await x.controller.initialize(); const host = x.hosts[0]; let attempts = 0;
    host.checkpoint = async () => { if (++attempts === 1) { host.pendingOutput = { snapshot: { sequence: 2 } }; throw new Error('pending'); } return { saved: true }; };
    await x.controller.save(); assert.equal(attempts, 2); assert.deepEqual(host.acknowledged, [2]); x.controller.dispose();
});
