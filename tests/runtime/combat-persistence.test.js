import { describe, it, expect, vi, afterEach } from 'vitest';
import { DirectCombatHost } from '../../src/runtime/combat/DirectCombatHost';
import { WorkerCombatHost } from '../../src/runtime/worker/WorkerCombatHost';
import { CombatWorkerServer } from '../../src/runtime/worker/CombatWorkerServer';
import { CheckpointStore, createBrowserCheckpointStore } from '../../src/runtime/persistence/CheckpointStore';
import { parseHostCheckpoint } from '../../src/runtime/persistence/HostCheckpoint';
import { ManualScheduler, channel } from '../helpers/combat-channel';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import scenario from '../fixtures/simulation/route-transitions.json';
import policy from '../fixtures/runtime/checkpoint-policy.json';
import workerPolicy from '../fixtures/runtime/worker-policy.json';
const configuration = { combat, simulation };
function direct(checkpoint) {
    const clock = { value: 0 }, timer = new ManualScheduler();
    const host = new DirectCombatHost({ sessionId: 'stored', configuration, scenario, seed: 123, checkpoint, now: () => clock.value, scheduler: timer });
    return { host, clock, timer };
}
function saved() { return direct().host.checkpoint(); }
function worker(checkpoint, sessionId = 'worker') {
    const link = channel(), clock = { value: 0 }, timer = new ManualScheduler(), deadlines = new ManualScheduler();
    const server = new CombatWorkerServer(link.ports[1], () => clock.value, timer);
    const session = { configuration, scenario, seed: 123, ...(checkpoint ? { checkpoint } : {}) };
    const host = new WorkerCombatHost({ sessionId, session, transport: link.ports[0], deadlines, ...workerPolicy });
    return { host, server, link, clock, timer, call(promise) { link.flush(); return promise; }, wake(atMs) { clock.value = atMs; timer.fire(); link.flush(); } };
}

describe('direct and worker checkpoint lifecycle', () => {
    it('requires stopped and drained output, and preserves fractional time and debt', () => {
        const original = direct();
        original.host.start();
        expect(() => original.host.checkpoint()).toThrow('Stop');
        original.clock.value = 100.75; original.timer.fire();
        original.clock.value = 250.5; original.host.stop();
        expect(() => original.host.checkpoint()).toThrow('acknowledge');
        original.host.acknowledge(1);
        const checkpoint = original.host.checkpoint();
        expect(checkpoint.activeTimeMs).toBe(250.5);
        const restored = direct(checkpoint);
        original.clock.value = 1000; original.host.start(); restored.host.start();
        original.clock.value = 1100.25; restored.clock.value = 100.25;
        original.timer.fire(); restored.timer.fire();
        expect(restored.host.pendingOutput).toEqual(original.host.pendingOutput);
        expect(restored.host.latest.atMs).toBe(300);
        original.host.stop(); restored.host.stop();
        original.host.acknowledge(3); restored.host.acknowledge(3);
        expect(restored.host.checkpoint()).toEqual(original.host.checkpoint());
    });
    it('rejects saves from disposed or faulted hosts', () => {
        const disposed = direct(); disposed.host.dispose(); expect(() => disposed.host.checkpoint()).toThrow('disposed');
        const broken = direct(); broken.host.start(); broken.clock.value = NaN; broken.timer.fire();
        expect(() => broken.host.checkpoint()).toThrow('clock');
    });
    it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid active time %s', value => {
        expect(() => parseHostCheckpoint({ ...saved(), activeTimeMs: value })).toThrow();
    });
    it('restores worker cursors, pending capture and queued input in a new session', async () => {
        const first = worker();
        await first.call(first.host.initialize()); await first.call(first.host.start());
        for (const time of [50, 100, 150]) {
            first.clock.value = time;
            await first.call(first.host.submit({ type: 'ClickAttack' }));
        }
        first.wake(300);
        first.clock.value = 325;
        await first.call(first.host.submit({ type: 'ChangeRoute', destination: { region: 0, route: 2 } }));
        await expect(first.host.checkpoint()).rejects.toThrow('Stop');
        await first.call(first.host.stop());
        await expect(first.host.checkpoint()).rejects.toThrow('acknowledge');
        await first.call(first.host.acknowledge(3));
        const checkpoint = await first.call(first.host.checkpoint());
        expect(checkpoint.combat.commands).toHaveLength(1);
        expect(checkpoint.combat.snapshot.encounter.phase).toBe('capturing');
        first.host.dispose();
        const second = worker(checkpoint, 'replacement');
        await second.call(second.host.initialize());
        expect(second.host.latest).toEqual({ ...checkpoint.combat.snapshot, sessionId: 'replacement' });
        expect(second.host.pendingOutput).toBeNull();
        await second.call(second.host.start()); second.wake(100);
        expect(second.host.pendingOutput.commands.map(command => command.sequence)).toEqual([4]);
        expect(second.host.pendingOutput.events[0]).toMatchObject({ type: 'CaptureResolved', sequence: 2, sessionId: 'replacement' });
        await second.call(second.host.acknowledge(4));
        const command = await second.call(second.host.submit({ type: 'ClickAttack' }));
        expect(command.sequence).toBe(5);
        await second.call(second.host.stop());
        const again = await second.call(second.host.checkpoint());
        expect(again.combat.commands[0].sessionId).toBe('replacement');
        second.host.dispose();
    });
    it('detects corrupted worker checkpoint responses without replacing the last snapshot', async () => {
        const context = worker(); await context.call(context.host.initialize());
        const snapshot = context.host.latest;
        const pending = context.host.checkpoint();
        const rejected = expect(pending).rejects.toThrow();
        context.link.queue.shift()();
        const reply = context.link.ports[1].sent.at(-1);
        reply.result.checkpoint.activeTimeMs = -1;
        context.link.endpoints[0].receive(reply);
        await rejected;
        expect(context.host.latest).toBe(snapshot);
        expect(context.host.state).toBe('faulted');
    });
});

class MemoryStorage {
    data = new Map(); writes = [];
    failKey = null;
    getItem(key) { return this.data.get(key) ?? null; }
    setItem(key, value) {
        if (key.endsWith(this.failKey ?? '\u0000')) throw new Error('Quota exceeded');
        this.writes.push(key); this.data.set(key, value);
    }
}
class Exclusive {
    tail = Promise.resolve(); names = [];
    run(name, operation) {
        this.names.push(name);
        const result = this.tail.then(operation);
        this.tail = result.catch(() => {});
        return result;
    }
}
function storage(options = {}) {
    const memory = new MemoryStorage(), exclusive = new Exclusive();
    const store = new CheckpointStore(memory, exclusive, { ...policy, configuration, scenario, ...options });
    return { memory, exclusive, store, prefix: `pokeclicker:ecs:checkpoints:v1:${policy.slot}` };
}
afterEach(() => vi.unstubAllGlobals());
describe('checkpoint storage and recovery', () => {
    it('round-trips JSON, retains the previous record and leaves legacy saves untouched', async () => {
        const { store, memory, prefix } = storage();
        memory.data.set('player', 'legacy-player'); memory.data.set('save', 'legacy-save');
        expect(store.read()).toBeNull(); expect(store.exportText()).toBeNull();
        const first = await store.write(saved(), null);
        const second = await store.write(saved(), first.revision);
        expect(second.revision).not.toBe(first.revision);
        expect(store.readBackup()).toEqual(first);
        expect(JSON.parse(store.exportText())).toEqual(saved());
        expect(memory.data.get('save')).toBe('legacy-save');
        expect(memory.data.get('player')).toBe('legacy-player');
        expect(memory.writes.every(key => key.startsWith(prefix))).toBe(true);
    });
    it('serializes competing writers and rejects stale revisions', async () => {
        const { store, memory, exclusive } = storage();
        const other = new CheckpointStore(memory, exclusive, { ...policy, configuration, scenario });
        const results = await Promise.allSettled([store.write(saved(), null), other.write(saved(), null)]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results[1].reason.message).toContain('revision changed');
        expect(new Set(exclusive.names).size).toBe(1);
    });
    it.each([':previous', ':current'])('preserves current data when writing %s fails', async key => {
        const { store, memory, prefix } = storage();
        const first = await store.write(saved(), null);
        const original = memory.data.get(`${prefix}:current`);
        memory.failKey = key;
        await expect(store.write(saved(), first.revision)).rejects.toThrow('Quota');
        expect(memory.data.get(`${prefix}:current`)).toBe(original);
        expect(store.read()).toEqual(first);
    });
    it('does not mutate storage on malformed, oversized or incompatible imports', async () => {
        const { store, memory } = storage();
        const invalid = saved();
        const changed = structuredClone(invalid); changed.combat.configuration.combat.clickAttackCooldownMs++;
        for (const text of ['{broken', JSON.stringify(changed), ' '.repeat(policy.maxBytes + 1)]) {
            await expect(store.importText(text, null)).rejects.toThrow();
        }
        expect(memory.writes).toHaveLength(0);
    });
    it('retains the exact original import and checks the serialized envelope size', async () => {
        const { store, memory, prefix } = storage();
        const text = JSON.stringify(saved(), null, 2);
        await store.importText(text, null);
        expect(memory.data.get(`${prefix}:import-original`)).toBe(text);
        const small = storage({ maxBytes: JSON.stringify(saved()).length });
        await expect(small.store.write(saved(), null)).rejects.toThrow('byte limit');
        expect(small.memory.writes).toHaveLength(0);
    });
    it('preserves corrupt current bytes and requires explicit recovery', async () => {
        const { store, memory, prefix } = storage();
        const first = await store.write(saved(), null);
        const second = await store.write(saved(), first.revision);
        memory.data.set(`${prefix}:current`, '{corrupt original');
        expect(() => store.read()).toThrow();
        await expect(store.write(saved(), second.revision)).rejects.toThrow();
        expect(memory.data.get(`${prefix}:current`)).toBe('{corrupt original');
        const recovered = await store.recoverBackup();
        expect(recovered.checkpoint).toEqual(first.checkpoint);
        expect(recovered.revision).not.toBe(first.revision);
        expect(recovered.revision).not.toBe(second.revision);
        expect(memory.data.get(`${prefix}:recovery-original`)).toBe('{corrupt original');
        await expect(store.write(saved(), second.revision)).rejects.toThrow('revision changed');
    });
    it('keeps current and backup intact if recovery cannot preserve original bytes', async () => {
        const { store, memory, prefix } = storage();
        const first = await store.write(saved(), null); await store.write(saved(), first.revision);
        memory.data.set(`${prefix}:current`, '{bad'); memory.failKey = ':recovery-original';
        const backup = memory.data.get(`${prefix}:previous`);
        await expect(store.recoverBackup()).rejects.toThrow('Quota');
        expect(memory.data.get(`${prefix}:current`)).toBe('{bad');
        expect(memory.data.get(`${prefix}:previous`)).toBe(backup);
    });
    it('rejects unavailable or invalid backups without a write', async () => {
        const { store, memory, prefix } = storage();
        await expect(store.recoverBackup()).rejects.toThrow('No checkpoint backup');
        memory.data.set(`${prefix}:previous`, '{}');
        await expect(store.recoverBackup()).rejects.toThrow();
        expect(memory.writes).toHaveLength(0);
    });
    it('enforces the byte budget for non-ASCII imports', async () => {
        const checkpoint = structuredClone(saved());
        checkpoint.combat.snapshot.sessionId = 'é'.repeat(30);
        const text = JSON.stringify(checkpoint);
        const { store, memory } = storage({ maxBytes: text.length });
        await expect(store.importText(text, null)).rejects.toThrow('byte limit');
        expect(memory.writes).toHaveLength(0);
    });
    it('requires explicit valid policy', () => {
        for (const maxBytes of [0, -1, NaN, 0.5]) expect(() => storage({ maxBytes })).toThrow();
        for (const slot of ['', '../save', 'player:name']) expect(() => storage({ slot })).toThrow();
    });
    it('uses a shared browser lock and fails explicitly when unavailable', async () => {
        vi.stubGlobal('navigator', {});
        expect(() => createBrowserCheckpointStore({ ...policy, configuration, scenario })).toThrow('Web Locks');
        const memory = new MemoryStorage();
        const request = vi.fn((_name, _options, callback) => Promise.resolve(callback()));
        vi.stubGlobal('localStorage', memory); vi.stubGlobal('navigator', { locks: { request } });
        const store = createBrowserCheckpointStore({ ...policy, configuration, scenario });
        await store.write(saved(), null);
        expect(request).toHaveBeenCalledWith(`pokeclicker:ecs:checkpoints:v1:${policy.slot}`, { mode: 'exclusive' }, expect.any(Function));
    });
});

describe('portable checkpoint validation without storage mutation', () => {
    it('previews and serializes detached checkpoint data without reading storage or acquiring a lock', () => {
        const getItem = vi.fn(() => { throw new Error('must not read'); }), setItem = vi.fn();
        const run = vi.fn(() => { throw new Error('must not lock'); });
        const store = new CheckpointStore({ getItem, setItem }, { run }, { ...policy, configuration, scenario });
        const checkpoint = saved(), text = store.serializeCheckpoint(checkpoint), preview = store.previewImport(text);
        expect(preview).toEqual(checkpoint); expect(Object.isFrozen(preview.combat.progress)).toBe(true);
        expect(getItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    });
    it('applies the same configured byte and rule bounds to preview and unsaved export', () => {
        const store = new CheckpointStore({ getItem: () => null, setItem() {} }, { run: async (_name, operation) => operation() }, { ...policy, maxBytes: 10, configuration, scenario });
        expect(() => store.serializeCheckpoint(saved())).toThrow(/byte limit/);
        expect(() => store.previewImport(' '.repeat(11))).toThrow(/byte limit/);
        const full = new CheckpointStore({ getItem: () => null, setItem() {} }, { run: async (_name, operation) => operation() }, { ...policy, configuration, scenario });
        const incompatible = structuredClone(saved()); incompatible.combat.scenario.clickAttackDamage++;
        expect(() => full.previewImport(JSON.stringify(incompatible))).toThrow(/incompatible/);
        expect(() => full.serializeCheckpoint(incompatible)).toThrow(/incompatible/);
    });
});
