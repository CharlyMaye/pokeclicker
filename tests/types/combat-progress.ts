import type { CombatFrame } from '../../src/contracts/combat-progress';
function immutableFrame(frame: CombatFrame): void {
    // @ts-expect-error Committed totals cannot be modified by a consumer.
    frame.progress.money = 1;
    // @ts-expect-error Captures are a readonly projection, not an inventory to mutate.
    frame.progress.captured.push({ pokemonId: 16, count: 1 });
    // @ts-expect-error Nested route references are readonly too.
    frame.progress.routes[0].location.route = 2;
    // @ts-expect-error A frame's combat and progression cannot be replaced independently.
    frame.snapshot = { ...frame.snapshot };
}
void immutableFrame;
