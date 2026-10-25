import type { CombatSnapshot } from '../../contracts/combat-protocol';
import { CombatSnapshotReceiver } from '../../contracts/combat-streams';

export const COMBAT_TEXT_FIELDS = ['region', 'route', 'status', 'opponent', 'health', 'capture'] as const;
export type CombatTextField = typeof COMBAT_TEXT_FIELDS[number];
const LABEL_FIELDS = ['title', ...COMBAT_TEXT_FIELDS, 'waiting', 'idle', 'fighting', 'capturing', 'unavailable', 'milliseconds'] as const;
export type CombatLabels = Readonly<Record<typeof LABEL_FIELDS[number], string>>;

export interface CombatView {
    readonly text: Readonly<Record<CombatTextField, string>>;
    readonly healthRatio: number;
}

function labels(value: unknown): CombatLabels {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).length !== LABEL_FIELDS.length) {
        throw new Error('Combat labels must be a plain object containing exactly the required text fields');
    }
    const entries = LABEL_FIELDS.map(field => {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' || !descriptor.value.trim()) {
            throw new Error(`Combat label ${field} must be a nonempty data string`);
        }
        return [field, descriptor.value];
    });
    return Object.freeze(Object.fromEntries(entries)) as CombatLabels;
}

/** Presentation-only projection and ordering. It owns no combat rules or clock. */
export class CombatViewModel {
    readonly labels: CombatLabels;
    private readonly receiver: CombatSnapshotReceiver;
    private view: CombatView;

    constructor(sessionId: string, suppliedLabels: unknown) {
        this.labels = labels(suppliedLabels);
        this.receiver = new CombatSnapshotReceiver(sessionId);
        const unavailable = this.labels.unavailable;
        this.view = Object.freeze({ text: Object.freeze({ region: unavailable, route: unavailable,
            status: this.labels.waiting, opponent: unavailable, health: unavailable, capture: unavailable }), healthRatio: 0 });
    }

    get current(): CombatView {
        return this.view;
    }

    update(value: CombatSnapshot): CombatView | null {
        const snapshot = this.receiver.receive(value);
        if (!snapshot) {
            return null;
        }
        const { encounter, location } = snapshot;
        const unavailable = this.labels.unavailable;
        const enemy = encounter.phase === 'idle' ? null : encounter.enemy;
        const capture = encounter.phase === 'capturing'
            ? `${encounter.resolvesAtMs - snapshot.atMs} ${this.labels.milliseconds}` : unavailable;
        this.view = Object.freeze({
            text: Object.freeze({
                region: String(location.region), route: String(location.route), status: this.labels[encounter.phase],
                opponent: enemy ? String(enemy.pokemonId) : unavailable,
                health: enemy ? `${enemy.health} / ${enemy.maxHealth}` : unavailable,
                capture,
            }),
            healthRatio: enemy ? enemy.health / enemy.maxHealth : 0,
        });
        return this.view;
    }
}
