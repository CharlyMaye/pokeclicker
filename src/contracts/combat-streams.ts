import {
    CombatCommand, CombatEvent, CombatSnapshot, MessageHeader, ProtocolError,
    parseCombatCommand, parseCombatEvent, parseCombatSnapshot, validateSessionId,
} from './combat-protocol';

type StreamPolicy = 'commands' | 'events' | 'snapshots';

class SequenceGuard {
    private sequence: number;
    private atMs = 0;
    private readonly sessionId: string;

    constructor(sessionId: string, private readonly policy: StreamPolicy, cursor?: { sequence: number; atMs: number }) {
        this.sessionId = validateSessionId(sessionId);
        this.sequence = policy === 'snapshots' ? -1 : 0;
        if (cursor) {
            if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || !Number.isSafeInteger(cursor.atMs) || cursor.atMs < 0 || (!cursor.sequence && cursor.atMs)) {
                throw new ProtocolError('invalid-payload', 'cursor', 'Invalid restored stream cursor');
            }
            this.sequence = cursor.sequence;
            this.atMs = cursor.atMs;
        }
    }

    accept(message: MessageHeader): boolean {
        if (message.sessionId !== this.sessionId) {
            throw new ProtocolError('wrong-session', 'sessionId', 'Message belongs to another session');
        }
        if (message.sequence <= this.sequence) {
            if (this.policy !== 'commands') {
                return false;
            }
            throw new ProtocolError('sequence', 'sequence', 'Command already received or out of order');
        }
        if (this.policy !== 'snapshots' && message.sequence !== this.sequence + 1) {
            throw new ProtocolError('sequence', 'sequence', 'Missing preceding message');
        }
        if (message.atMs < this.atMs) {
            throw new ProtocolError('time', 'atMs', 'Time cannot move backwards within a stream');
        }
        // Commit only after every check succeeds. The caller can retry a rejected gap.
        this.sequence = message.sequence;
        this.atMs = message.atMs;
        return true;
    }
}

/** Orders ingress; accepting a command here does not authorize its gameplay action. */
export class CombatCommandReceiver {
    private readonly guard: SequenceGuard;

    constructor(sessionId: string, cursor?: { sequence: number; atMs: number }) {
        this.guard = new SequenceGuard(sessionId, 'commands', cursor);
    }

    receive(value: unknown): CombatCommand {
        const command = parseCombatCommand(value);
        this.guard.accept(command);
        return command;
    }
}

/** A replaceable renderer reads latest at its own display frequency. */
export class CombatSnapshotReceiver {
    private readonly guard: SequenceGuard;
    private snapshot: CombatSnapshot | null = null;

    constructor(sessionId: string) {
        this.guard = new SequenceGuard(sessionId, 'snapshots');
    }

    get latest(): CombatSnapshot | null {
        return this.snapshot;
    }

    receive(value: unknown): CombatSnapshot | null {
        const snapshot = parseCombatSnapshot(value);
        if (!this.guard.accept(snapshot)) {
            return null;
        }
        this.snapshot = snapshot;
        return snapshot;
    }
}

/** Detects gaps and suppresses redelivery within one live session. */
export class CombatEventReceiver {
    private readonly guard: SequenceGuard;

    constructor(sessionId: string) {
        this.guard = new SequenceGuard(sessionId, 'events');
    }

    receive(value: unknown): CombatEvent | null {
        const event = parseCombatEvent(value);
        return this.guard.accept(event) ? event : null;
    }
}
