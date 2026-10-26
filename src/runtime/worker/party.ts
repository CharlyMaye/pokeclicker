import type { CombatFrame } from '../../contracts/combat-progress';
import type { CombatScenario } from '../../simulation/combat/model';
import { sameData } from '../../simulation/combat/checkpoint';
import { parsePartySnapshot } from '../../simulation/experience/partyExperience';

/** Validate delivered components without awarding experience or advancing a main-thread world. */
export function verifyPartyFrame(frame: CombatFrame, scenario: CombatScenario, previous?: CombatFrame): void {
    if (scenario.formatVersion !== 4) {
        if (frame.party !== undefined) {
            throw new Error('Unexpected party progression for this session');
        }
        return;
    }
    const next = parsePartySnapshot(frame.party, scenario.party, frame.progress.defeats);
    if (!sameData(next, frame.party)) {
        throw new Error('Worker party order differs from the session roster');
    }
    if (previous) {
        const before = previous.party;
        if (!before || next.grants < before.grants || next.shadowExperience < before.shadowExperience
            || next.members.some((member, index) => member.level < before.members[index].level || member.experience < before.members[index].experience)
            || (next.grants === before.grants && !sameData(next, before))) {
            throw new Error('Worker party progression regressed or changed without a defeat');
        }
    }
}
