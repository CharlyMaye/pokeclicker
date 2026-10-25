import { describe, expect, it } from 'vitest';
import { parseCombatCommand, parseCombatEvent, parseCombatSnapshot, ProtocolError } from '../../src/contracts/combat-protocol';
import { CombatCommandReceiver, CombatEventReceiver, CombatSnapshotReceiver } from '../../src/contracts/combat-streams';

const header = (sequence = 1, atMs = 0) => ({ protocolVersion: 1, sessionId: 'test-session', sequence, atMs });
const click = (sequence = 1, atMs = 0) => ({ ...header(sequence, atMs), type: 'ClickAttack' });
const event = (sequence = 1, atMs = 0) => ({ ...header(sequence, atMs), type: 'EnemyDefeated', encounterId: 1, pokemonId: 19.01 });
const snapshot = (sequence = 0, atMs = 0) => ({
    ...header(sequence, atMs),
    type: 'CombatSnapshot',
    location: { region: 0, route: 1 },
    encounter: { phase: 'fighting', enemy: { encounterId: 1, pokemonId: 19.01, health: 20, maxHealth: 30 } },
});

describe('combat message validation', () => {
    it('accepts commands, events and all snapshot phases through structured clone', () => {
        expect(parseCombatCommand(structuredClone(click()))).toEqual(click());
        const change = { ...header(), type: 'ChangeRoute', destination: { region: 1, route: 29 } };
        expect(parseCombatCommand(structuredClone(change))).toEqual(change);
        expect(parseCombatEvent(structuredClone(event()))).toEqual(event());
        for (const caught of [true, false]) {
            const capture = { ...event(), type: 'CaptureResolved', caught };
            expect(parseCombatEvent(structuredClone(capture))).toEqual(capture);
        }
        const capturing = { phase: 'capturing', enemy: { ...snapshot().encounter.enemy, health: 0 }, resolvesAtMs: 1250 };
        for (const encounter of [{ phase: 'idle' }, snapshot().encounter, capturing]) {
            const state = { ...snapshot(), encounter };
            expect(parseCombatSnapshot(structuredClone(state))).toEqual(state);
        }
    });

    it('detaches and freezes nested data without freezing or retaining the source', () => {
        const source = snapshot();
        const result = parseCombatSnapshot(source);
        source.location.route = 2;
        source.encounter.enemy.health = 0;
        expect(result.location.route).toBe(1);
        expect(result.encounter.enemy.health).toBe(20);
        for (const value of [result, result.location, result.encounter, result.encounter.enemy]) {
            expect(Object.isFrozen(value)).toBe(true);
        }
        const command = { ...header(), type: 'ChangeRoute', destination: { region: 1, route: 29 } };
        const received = parseCombatCommand(command);
        command.destination.route = 30;
        expect(received.destination.route).toBe(29);
        expect(Object.isFrozen(received.destination)).toBe(true);
    });

    it.each([null, [], true, 'click', { ...click(), extra: 1 }, { ...click(), type: 'BuyItem' }, { ...click(), protocolVersion: 2 }])('rejects invalid commands: %j', value => {
        expect(() => parseCombatCommand(value)).toThrow(ProtocolError);
    });

    it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '50'])('rejects invalid timestamps: %s', atMs => {
        expect(() => parseCombatCommand({ ...click(), atMs })).toThrow(ProtocolError);
    });

    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid command sequences: %s', sequence => {
        expect(() => parseCombatCommand(click(sequence))).toThrow(ProtocolError);
    });

    it('rejects missing fields, accessor objects and inherited payloads without executing a getter', () => {
        const missing = click();
        delete missing.atMs;
        expect(() => parseCombatCommand(missing)).toThrow(ProtocolError);
        let invoked = false;
        const accessor = { ...click(), get type() { invoked = true; return 'ClickAttack'; } };
        expect(() => parseCombatCommand(accessor)).toThrow(ProtocolError);
        expect(invoked).toBe(false);
        expect(() => parseCombatCommand(Object.create(click()))).toThrow(ProtocolError);
    });

    it.each([
        { phase: 'fighting', enemy: { ...snapshot().encounter.enemy, health: 31 } },
        { phase: 'fighting', enemy: { ...snapshot().encounter.enemy, health: 0 } },
        { phase: 'fighting', enemy: { ...snapshot().encounter.enemy, health: NaN } },
        { phase: 'capturing', enemy: snapshot().encounter.enemy, resolvesAtMs: 1250 },
        { phase: 'capturing', enemy: { ...snapshot().encounter.enemy, health: 0 }, resolvesAtMs: 49 },
        { phase: 'idle', enemy: snapshot().encounter.enemy },
    ])('rejects inconsistent encounter state: %j', encounter => {
        expect(() => parseCombatSnapshot({ ...snapshot(1, 50), encounter })).toThrow(ProtocolError);
    });

    it('rejects invalid route references and event results', () => {
        expect(() => parseCombatCommand({ ...header(), type: 'ChangeRoute', destination: { region: 0, route: 0 } })).toThrow(ProtocolError);
        expect(() => parseCombatEvent({ ...event(), type: 'CaptureResolved', caught: 'yes' })).toThrow(ProtocolError);
        expect(() => parseCombatEvent({ ...event(), pokemonId: 0 })).toThrow(ProtocolError);
    });
});

describe('session stream semantics', () => {
    it('preserves two clicks 50 ms apart inside one simulation step', () => {
        const receiver = new CombatCommandReceiver('test-session');
        expect(receiver.receive(click(1, 50)).atMs).toBe(50);
        expect(receiver.receive(click(2, 100)).atMs).toBe(100);
        // Equal-time inputs are ordered by sequence without inventing elapsed time.
        expect(receiver.receive(click(3, 100)).sequence).toBe(3);
    });

    it('rejects duplicates, gaps, backward time and wrong sessions without advancing command state', () => {
        const receiver = new CombatCommandReceiver('test-session');
        receiver.receive(click(1, 50));
        for (const invalid of [click(1, 50), click(3, 100), click(2, 49), { ...click(2, 100), sessionId: 'old-session' }]) {
            expect(() => receiver.receive(invalid)).toThrow(ProtocolError);
        }
        expect(receiver.receive(click(2, 100)).sequence).toBe(2);
    });

    it('does not advance a stream when payload validation fails', () => {
        const receiver = new CombatCommandReceiver('test-session');
        expect(() => receiver.receive({ ...click(), extra: true })).toThrow(ProtocolError);
        expect(receiver.receive(click()).sequence).toBe(1);
    });

    it('retains the latest snapshot, permits gaps and ignores superseded frames', () => {
        const receiver = new CombatSnapshotReceiver('test-session');
        expect(receiver.latest).toBe(null);
        receiver.receive(snapshot(0, 0));
        receiver.receive(snapshot(5, 100));
        expect(receiver.receive(snapshot(2, 50))).toBe(null);
        expect(receiver.receive(snapshot(5, 100))).toBe(null);
        expect(() => receiver.receive(snapshot(6, 99))).toThrow(ProtocolError);
        expect(() => receiver.receive({ ...snapshot(6, 150), sessionId: 'old-session' })).toThrow(ProtocolError);
        expect(receiver.latest.sequence).toBe(5);
        expect(receiver.receive(snapshot(6, 150)).sequence).toBe(6);
    });

    it('does not permit skipped events or repeated delivery within a live session', () => {
        const receiver = new CombatEventReceiver('test-session');
        expect(receiver.receive(event()).sequence).toBe(1);
        expect(receiver.receive(event())).toBe(null);
        expect(() => receiver.receive(event(3))).toThrow(ProtocolError);
        expect(() => receiver.receive({ ...event(2), sessionId: 'old-session' })).toThrow(ProtocolError);
        expect(receiver.receive(event(2, 10)).sequence).toBe(2);
        expect(() => receiver.receive(event(3, 9))).toThrow(ProtocolError);
        expect(receiver.receive(event(3, 10)).sequence).toBe(3);
    });

    it('separates display frequency from command/event consumption', () => {
        const fast = new CombatSnapshotReceiver('test-session');
        const slow = new CombatSnapshotReceiver('test-session');
        const events = new CombatEventReceiver('test-session');
        for (let sequence = 0; sequence <= 10; sequence++) {
            fast.receive(snapshot(sequence, sequence * 100));
        }
        slow.receive(snapshot(0, 0));
        slow.receive(snapshot(10, 1000));
        expect(slow.latest).toEqual(fast.latest);
        expect(events.receive(event(1, 50)).sequence).toBe(1);
        expect(events.receive(event(2, 100)).sequence).toBe(2);
    });
});
