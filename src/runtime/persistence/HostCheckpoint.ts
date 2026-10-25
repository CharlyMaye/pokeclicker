import type { Configuration } from '../../contracts/configuration-types';
import { CombatCheckpoint, parseCombatCheckpoint } from '../../simulation/combat/checkpoint';
import { dataObject } from '../../simulation/combat/validation';

export interface HostCheckpoint {
    readonly formatVersion: 1;
    /** Includes fractional milliseconds and bounded processing debt; excludes stopped time. */
    readonly activeTimeMs: number;
    readonly combat: CombatCheckpoint;
}

export function parseHostCheckpoint(value: unknown, configuration?: Configuration, scenario?: unknown): HostCheckpoint {
    const data = dataObject(value, ['formatVersion', 'activeTimeMs', 'combat'], 'host checkpoint');
    const combat = parseCombatCheckpoint(data.combat, configuration, scenario);
    if (data.formatVersion !== 1 || typeof data.activeTimeMs !== 'number' || !Number.isFinite(data.activeTimeMs)
        || data.activeTimeMs < combat.snapshot.atMs || data.activeTimeMs > Number.MAX_SAFE_INTEGER) {
        throw new Error('Invalid checkpoint version or active-time debt');
    }
    return Object.freeze({ formatVersion: 1, activeTimeMs: data.activeTimeMs, combat });
}
