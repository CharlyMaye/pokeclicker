import type { CombatCheckpoint } from '../../src/simulation/combat/checkpoint';
import type { CombatScenario } from '../../src/simulation/combat/model';
function immutableParty(checkpoint: CombatCheckpoint, scenario: CombatScenario): void {
    if (checkpoint.formatVersion === 3) {
        // @ts-expect-error Saved components are immutable.
        checkpoint.party.members[0].level = 2;
        // @ts-expect-error Saved party catalogs cannot grow through a projection.
        checkpoint.party.members.push({ pokemonId: 1, level: 1, experience: 0 });
    }
    if (scenario.formatVersion === 4) {
        // @ts-expect-error Party rules cannot change during a session.
        scenario.party.members[0].maxLevel = 50;
        // @ts-expect-error Level curves are immutable session inputs.
        scenario.party.levelCurves.curves[0].thresholds.push(100);
    }
}
void immutableParty;
