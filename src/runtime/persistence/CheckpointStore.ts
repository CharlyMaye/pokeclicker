import type { Configuration } from '../../contracts/configuration-types';
import { dataObject, safeInteger, validateScenario } from '../../simulation/combat/validation';
import { validateConfiguration } from '../../contracts/configuration';
import { HostCheckpoint, parseHostCheckpoint } from './HostCheckpoint';

export interface CheckpointStorage {
    getItem(key: string): string | null;
    /** Atomic replacement of one key: a thrown write must leave that key unchanged. */
    setItem(key: string, value: string): void;
}
export interface ExclusiveCheckpointAccess {
    /** Every writer of this namespace must share this exclusive lock. */
    run<T>(name: string, operation: () => T): Promise<T>;
}
export interface CheckpointStoreOptions {
    readonly slot: string;
    readonly maxBytes: number;
    readonly configuration: Configuration;
    readonly scenario: unknown;
}
function revision(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
        throw new Error('Expected a checkpoint revision UUID');
    }
    return value;
}

export interface StoredCheckpoint {
    readonly formatVersion: 1;
    readonly revision: string;
    readonly checkpoint: HostCheckpoint;
}

/** Separate ECS storage; never reads, changes or enumerates legacy save keys. */
export class CheckpointStore {
    private readonly prefix: string;
    private readonly maxBytes: number;
    private readonly configuration: Configuration;
    private readonly scenario: ReturnType<typeof validateScenario>;

    constructor(private readonly storage: CheckpointStorage, private readonly exclusive: ExclusiveCheckpointAccess, options: CheckpointStoreOptions) {
        if (typeof options.slot !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(options.slot)) {
            throw new Error('Checkpoint slot must be a short portable identifier');
        }
        this.maxBytes = safeInteger(options.maxBytes, 'checkpoint maxBytes', 1);
        this.prefix = `pokeclicker:ecs:checkpoints:v1:${options.slot}`;
        this.configuration = validateConfiguration(options.configuration);
        this.scenario = validateScenario(options.scenario);
    }

    private bounded(text: string): string {
        // Reject before allocating UTF-8 bytes when even the character count exceeds the budget.
        if (typeof text !== 'string' || text.length > this.maxBytes || new TextEncoder().encode(text).byteLength > this.maxBytes) {
            throw new Error('Checkpoint document exceeds its configured byte limit');
        }
        return text;
    }

    private checkpoint(value: unknown): HostCheckpoint {
        return parseHostCheckpoint(value, this.configuration, this.scenario);
    }

    private record(text: string): StoredCheckpoint {
        const data = dataObject(JSON.parse(this.bounded(text)), ['formatVersion', 'revision', 'checkpoint'], 'stored checkpoint');
        if (data.formatVersion !== 1) {
            throw new Error('Unsupported storage record version');
        }
        return Object.freeze({ formatVersion: 1, revision: revision(data.revision), checkpoint: this.checkpoint(data.checkpoint) });
    }

    read(): StoredCheckpoint | null {
        const text = this.storage.getItem(`${this.prefix}:current`);
        return text === null ? null : this.record(text);
    }

    readBackup(): StoredCheckpoint | null {
        const text = this.storage.getItem(`${this.prefix}:previous`);
        return text === null ? null : this.record(text);
    }

    async write(value: unknown, expectedRevision: string | null): Promise<StoredCheckpoint> {
        const checkpoint = this.checkpoint(value);
        if (expectedRevision !== null) {
            revision(expectedRevision);
        }
        return this.exclusive.run(this.prefix, () => this.commit(checkpoint, expectedRevision));
    }

    /** Import validates first, retains the exact imported document, and never touches its source. */
    async importText(text: string, expectedRevision: string | null): Promise<StoredCheckpoint> {
        const checkpoint = this.checkpoint(JSON.parse(this.bounded(text)));
        if (expectedRevision !== null) {
            revision(expectedRevision);
        }
        return this.exclusive.run(this.prefix, () => this.commit(checkpoint, expectedRevision, text));
    }

    exportText(): string | null {
        const record = this.read();
        return record ? this.bounded(JSON.stringify(record.checkpoint)) : null;
    }

    private commit(checkpoint: HostCheckpoint, expectedRevision: string | null, imported?: string): StoredCheckpoint {
        const currentKey = `${this.prefix}:current`;
        const original = this.storage.getItem(currentKey);
        // Malformed or incompatible existing saves require explicit recovery; never overwrite them here.
        const previous = original === null ? null : this.record(original);
        if ((previous?.revision ?? null) !== expectedRevision) {
            throw new Error('Checkpoint revision changed; reload before writing');
        }
        const record: StoredCheckpoint = Object.freeze({ formatVersion: 1, revision: revision(crypto.randomUUID()), checkpoint });
        const text = this.bounded(JSON.stringify(record));
        if (imported !== undefined) {
            this.storage.setItem(`${this.prefix}:import-original`, imported);
        }
        if (original !== null) {
            this.storage.setItem(`${this.prefix}:previous`, original);
        }
        // This single-key replacement is the commit point. Failure preserves the prior current save.
        this.storage.setItem(currentKey, text);
        return record;
    }

    /** Explicit rollback. Preserve the replaced current bytes, including malformed data, for recovery. */
    async recoverBackup(): Promise<StoredCheckpoint> {
        return this.exclusive.run(this.prefix, () => {
            const backupText = this.storage.getItem(`${this.prefix}:previous`);
            if (backupText === null) {
                throw new Error('No checkpoint backup is available');
            }
            const backup = this.record(backupText);
            const currentText = this.storage.getItem(`${this.prefix}:current`);
            if (currentText !== null) {
                this.bounded(currentText);
            }
            const record: StoredCheckpoint = Object.freeze({ ...backup, revision: revision(crypto.randomUUID()) });
            const text = this.bounded(JSON.stringify(record));
            if (currentText !== null) {
                this.storage.setItem(`${this.prefix}:recovery-original`, currentText);
            }
            this.storage.setItem(`${this.prefix}:current`, text);
            return record;
        });
    }
}

/** Fail explicitly without Web Locks: there is no unsafe multi-tab fallback. */
export function createBrowserCheckpointStore(options: CheckpointStoreOptions): CheckpointStore {
    if (!globalThis.navigator?.locks) {
        throw new Error('Checkpoint storage requires Web Locks for exclusive writes');
    }
    return new CheckpointStore(globalThis.localStorage, {
        run: (name, operation) => navigator.locks.request(name, { mode: 'exclusive' }, operation),
    }, options);
}
