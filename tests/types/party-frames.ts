import type { CombatFrame } from '../../src/contracts/combat-progress';
declare const frame: CombatFrame;
if (frame.party) {
    // @ts-expect-error Committed totals are immutable.
    frame.party.grants++;
    // @ts-expect-error Renderers cannot mutate components.
    frame.party.members[0].experience++;
    // @ts-expect-error Renderers cannot change the roster.
    frame.party.members.push({ pokemonId: 1, level: 1, experience: 0 });
}
