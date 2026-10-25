import type { CombatCommand, CombatSnapshot } from '../../src/contracts/combat-protocol';

declare const snapshot: CombatSnapshot;
// @ts-expect-error A renderer cannot mutate authoritative state through the snapshot.
snapshot.location.route = 2;
if (snapshot.encounter.phase === 'fighting') {
    // @ts-expect-error Nested projection data is read-only too.
    snapshot.encounter.enemy.health = 0;
}
declare const command: CombatCommand;
if (command.type === 'ClickAttack') {
    // @ts-expect-error A click does not carry a route-change payload.
    command.destination;
}
