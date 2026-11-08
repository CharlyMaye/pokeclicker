import { CombatFrame, ProgressLimits, PROGRESS_TOTAL_FIELDS, ProgressTotalField, parseCombatFrame, parseProgressLimits } from '../../contracts/combat-progress';
import { CombatSnapshotReceiver } from '../../contracts/combat-streams';

export const PROGRESS_LABEL_FIELDS = ['title', ...PROGRESS_TOTAL_FIELDS, 'captured', 'routes', 'pokemonId', 'count', 'region', 'route', 'captures', 'waiting', 'emptyCaptures', 'emptyRoutes', 'party', 'level', 'grants', 'shadowExperience', 'emptyParty', 'partyDisabled'] as const;
export type ProgressLabels = Readonly<Record<typeof PROGRESS_LABEL_FIELDS[number], string>>;
export interface ProgressView {
    readonly totals: Readonly<Record<ProgressTotalField, string>>;
    readonly captured: readonly Readonly<{ pokemonId: string; count: string }>[];
    readonly routes: readonly Readonly<{ region: string; route: string; defeats: string; captures: string }>[];
    readonly capturedNotice: string;
    readonly routesNotice: string;
    readonly party: readonly Readonly<{ pokemonId: string; experience: string; level: string }>[];
    readonly partyTotals: Readonly<{ grants: string; shadowExperience: string }>;
    readonly partyNotice: string;
}
export function parseProgressLabels(value: unknown): ProgressLabels {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).length !== PROGRESS_LABEL_FIELDS.length) {
        throw new Error('Progress labels must contain exactly the required text fields');
    }
    return Object.freeze(Object.fromEntries(PROGRESS_LABEL_FIELDS.map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' || !descriptor.value.trim()) {
            throw new Error(`Progress label ${key} must be a nonempty data string`);
        }
        return [key, descriptor.value];
    }))) as ProgressLabels;
}

/** Turns committed totals into display text. No event application, wallet writes or timing. */
export class ProgressViewModel {
    readonly labels: ProgressLabels;
    private readonly receiver: CombatSnapshotReceiver;
    private view: ProgressView;
    private readonly limits: ProgressLimits;
    constructor(sessionId: string, labels: unknown, limits: ProgressLimits) {
        this.labels = parseProgressLabels(labels);
        this.limits = parseProgressLimits(limits);
        this.receiver = new CombatSnapshotReceiver(sessionId);
        this.view = Object.freeze({ totals: Object.freeze(Object.fromEntries(PROGRESS_TOTAL_FIELDS.map(key => [key, this.labels.waiting]))) as ProgressView['totals'],
            captured: Object.freeze([]), routes: Object.freeze([]), capturedNotice: this.labels.waiting, routesNotice: this.labels.waiting,
            party: Object.freeze([]), partyTotals: Object.freeze({ grants: this.labels.waiting, shadowExperience: this.labels.waiting }), partyNotice: this.labels.waiting });
    }
    get current(): ProgressView {
        return this.view;
    }
    update(value: CombatFrame): { readonly frame: CombatFrame; readonly view: ProgressView } | null {
        const frame = parseCombatFrame(value, this.limits);
        if (!this.receiver.receive(frame.snapshot)) {
            return null;
        }
        const progress = frame.progress;
        this.view = Object.freeze({
            totals: Object.freeze(Object.fromEntries(PROGRESS_TOTAL_FIELDS.map(key => [key, String(progress[key])]))) as ProgressView['totals'],
            captured: Object.freeze(progress.captured.map(entry => Object.freeze({ pokemonId: String(entry.pokemonId), count: String(entry.count) }))),
            routes: Object.freeze(progress.routes.map(entry => Object.freeze({ region: String(entry.location.region), route: String(entry.location.route), defeats: String(entry.defeats), captures: String(entry.captures) }))),
            capturedNotice: progress.captured.length ? '' : this.labels.emptyCaptures,
            routesNotice: progress.routes.length ? '' : this.labels.emptyRoutes,
            party: Object.freeze((frame.party?.members ?? []).map(member => Object.freeze({
                pokemonId: String(member.pokemonId), experience: String(member.experience), level: String(member.level),
            }))),
            partyTotals: Object.freeze({ grants: frame.party ? String(frame.party.grants) : this.labels.partyDisabled,
                shadowExperience: frame.party ? String(frame.party.shadowExperience) : this.labels.partyDisabled }),
            partyNotice: frame.party ? frame.party.members.length ? '' : this.labels.emptyParty : this.labels.partyDisabled,
        });
        return Object.freeze({ frame, view: this.view });
    }
}
