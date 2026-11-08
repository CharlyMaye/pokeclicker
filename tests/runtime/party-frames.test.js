import { describe, expect, it, vi } from 'vitest';
import { parseCombatFrame } from '../../src/contracts/combat-progress';
import { RouteCombatSimulation } from '../../src/simulation/combat/RouteCombatSimulation';
import { DirectCombatHost } from '../../src/runtime/combat/DirectCombatHost';
import { CombatWorkerServer } from '../../src/runtime/worker/CombatWorkerServer';
import { WorkerCombatHost } from '../../src/runtime/worker/WorkerCombatHost';
import { WORKER_PROTOCOL_VERSION } from '../../src/runtime/worker/protocol';
import { ManualScheduler, channel } from '../helpers/combat-channel';
import makeParty from '../fixtures/runtime/party-scenario.cjs';
import combat from '../../public/config/combat.json';
import simulation from '../../public/config/simulation.json';
import policy from '../fixtures/runtime/worker-policy.json';
const configuration = { combat, simulation }, scenario = makeParty();
const limits = { maxCaptured: 100, maxRoutes: 100, maxParty: 3 };
const engine = () => new RouteCombatSimulation('party-frames', configuration, scenario, 123);
const frame = game => ({ snapshot: game.snapshot, progress: game.progress, party: game.partyExperience });
function setup(checkpoint) {
    const link = channel(), timer = new ManualScheduler(), deadlines = new ManualScheduler(), clock = { value: 0 };
    const server = new CombatWorkerServer(link.ports[1], () => clock.value, timer);
    const host = new WorkerCombatHost({ sessionId: 'party-frames', session: { configuration, scenario, seed: 123, ...(checkpoint ? { checkpoint } : {}) },
        ...policy, deadlines, transport: link.ports[0] });
    const call = promise => { link.flush(); return promise; };
    return { host, server, link, call, wake(time) { clock.value = time; timer.fire(); link.flush(); } };
}
describe('bounded party frames', () => {
    it('copies and freezes fractional values in roster order', () => {
        const game = engine(); game.advanceTo(3000); const input = structuredClone(frame(game)), parsed = parseCombatFrame(input, limits);
        input.party.members[0].experience++;
        expect(parsed.party).toEqual(game.partyExperience); expect(parsed.party.grants).toBe(1);
        expect(parsed.party.members[2].pokemonId).toBe(3.01); expect(Object.isFrozen(parsed.party.members[0])).toBe(true);
        expect(Object.isFrozen(parsed.party.members)).toBe(true);
    });
    it.each([
        v => { v.party.grants++; }, v => { v.party.shadowExperience = -1; },
        v => { v.party.members[0].experience = NaN; }, v => { v.party.members[0].experience = Number.MAX_SAFE_INTEGER; },
        v => { v.party.members[0].level = 0; }, v => { v.party.members[0].level = 1.5; },
        v => { v.party.members[0].pokemonId = 0; }, v => { v.party.members[0].pokemonId = Infinity; },
        v => { v.party.members[0].pokemonId = v.party.members[1].pokemonId; },
        v => { v.party.members = new Array(3); }, v => { v.party.members.extra = true; },
        v => { v.party.extra = true; }, v => { delete v.party; }, v => { v.party = null; },
    ])('rejects malformed party data %#', mutate => {
        const value = structuredClone(frame(engine())); mutate(value); expect(() => parseCombatFrame(value, limits)).toThrow();
    });
    it('bounds lists and rejects accessors without executing them', () => {
        const value = frame(engine()), getter = vi.fn();
        expect(() => parseCombatFrame(value, { ...limits, maxParty: 2 })).toThrow();
        const member = structuredClone(value); Object.defineProperty(member.party.members, '0', { get: getter });
        expect(() => parseCombatFrame(member, limits)).toThrow();
        Object.defineProperty(value, 'party', { get: getter }); expect(() => parseCombatFrame(value, limits)).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });
    it('distinguishes an enabled empty roster from disabled party progression', () => {
        const value = frame(engine()); value.party = { grants: 0, shadowExperience: 0, members: [] };
        expect(parseCombatFrame(value, { ...limits, maxParty: 0 }).party.members).toEqual([]);
        expect(() => parseCombatFrame(value, { maxCaptured: 100, maxRoutes: 100 })).toThrow();
        expect(() => parseCombatFrame(value, { ...limits, maxParty: undefined })).toThrow();
    });
});
describe('atomic party delivery', () => {
    it('retains each direct-host batch even after later progression', () => {
        const timer = new ManualScheduler(); let now = 0;
        const host = new DirectCombatHost({ sessionId: 'party-frames', configuration, scenario, seed: 123, now: () => now, scheduler: timer });
        expect(host.latestFrame.party.grants).toBe(0); host.start(); now = 100; timer.fire(); const oldest = host.pendingOutput;
        now = 3000; timer.fire(); expect(host.latestFrame.party.grants).toBe(1);
        expect(host.latestFrame.party.grants).toBe(host.latestFrame.progress.defeats); expect(oldest.party.grants).toBe(0); host.dispose();
    });
    it('delivers queued party state with its frame rather than the newer world', async () => {
        const x = setup(); await x.call(x.host.initialize()); await x.call(x.host.start()); x.wake(100); x.wake(3000);
        const before = x.host.latestFrame; expect(before.party.grants).toBe(0);
        await x.call(x.host.acknowledge(before.snapshot.sequence)); expect(x.host.latestFrame.party.grants).toBe(1);
        expect(before.party.grants).toBe(0); expect(x.host.latestFrame.party).toBe(x.host.pendingOutput.party); x.host.dispose();
    });
    it('restores party before any wake with no duplicate grant', async () => {
        const game = engine(); game.advanceTo(3000); const x = setup({ formatVersion: 1, activeTimeMs: 3000, combat: game.checkpoint() });
        await x.call(x.host.initialize()); expect(x.host.state).toBe('stopped'); expect(x.host.latestFrame.party).toEqual(game.partyExperience);
        expect(x.host.pendingOutput).toBeNull(); x.host.dispose();
    });
    it.each(['missing', 'experience', 'roster', 'order', 'shadow', 'grants'])('rejects forged %s initialization', async mode => {
        const x = setup(), pending = x.host.initialize(); x.link.queue.shift()(); const result = x.link.ports[1].sent.at(-1).result;
        if (mode === 'missing') delete result.party;
        if (mode === 'experience') result.party.members[0].experience = 1;
        if (mode === 'roster') result.party.members[0].pokemonId = 999;
        if (mode === 'order') result.party.members.reverse();
        if (mode === 'shadow') result.party.shadowExperience = 1;
        if (mode === 'grants') result.party.grants = 1;
        x.link.flush(); await expect(pending).rejects.toThrow(); expect(x.host.latestFrame).toBeNull(); x.host.dispose();
    });
    it.each(['missing', 'roster', 'level', 'experience', 'shadow', 'grants', 'regression'])('rejects %s output before publishing any partial state', async mode => {
        const x = setup(); await x.call(x.host.initialize()); await x.call(x.host.start()); x.wake(3000);
        await x.call(x.host.acknowledge(x.host.latest.sequence)); const before = x.host.latestFrame;
        const batch = { ...structuredClone(before), snapshot: { ...before.snapshot, sequence: 31, atMs: 3100 }, events: [], commands: [], remainingMs: 0 };
        if (mode === 'missing') delete batch.party;
        if (mode === 'roster') batch.party.members.pop();
        if (mode === 'level') batch.party.members[0].level = 100;
        if (mode === 'experience') batch.party.members[2].experience++;
        if (mode === 'shadow') batch.party.shadowExperience++;
        if (mode === 'grants') batch.party.grants++;
        if (mode === 'regression') batch.party.members[2].experience--;
        x.link.endpoints[0].receive({ version: WORKER_PROTOCOL_VERSION, sessionId: 'party-frames', type: 'output', batch });
        expect(x.host.state).toBe('faulted'); expect(x.host.latestFrame).toBe(before); expect(x.host.pendingOutput).toBeNull(); x.host.dispose();
    });
    it('rejects a plausible checkpoint that differs from the delivered party', async () => {
        const game = engine(); game.advanceTo(3000); const x = setup({ formatVersion: 1, activeTimeMs: 3000, combat: game.checkpoint() });
        await x.call(x.host.initialize()); const before = x.host.latestFrame, pending = x.host.checkpoint(); x.link.queue.shift()();
        x.link.ports[1].sent.at(-1).result.checkpoint.combat.party.members[2].experience++;
        x.link.flush(); await expect(pending).rejects.toThrow(/delivered state/); expect(x.host.latestFrame).toBe(before); x.host.dispose();
    });
    it('rejects the previous transport version instead of losing party data', async () => {
        const x = setup(), pending = x.host.initialize(); x.link.queue.shift()(); x.link.ports[1].sent.at(-1).version = 3;
        x.link.flush(); await expect(pending).rejects.toThrow(/version/); expect(x.host.latestFrame).toBeNull(); x.host.dispose();
    });
});
