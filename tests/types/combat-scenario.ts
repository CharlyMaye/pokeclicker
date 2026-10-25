import type { CombatScenario, UniformCombatRoute, WeightedCombatRoute } from '../../src/simulation/combat/model';
function scenarioBoundaries(uniform: UniformCombatRoute, weighted: WeightedCombatRoute, scenario: CombatScenario): void {
    // @ts-expect-error Weighted tables are immutable session inputs.
    weighted.encounters[0].weight = 2;
    // @ts-expect-error Version 2 requires weighted routes.
    const missing: CombatScenario = { ...scenario, formatVersion: 2, routes: [uniform] };
    // @ts-expect-error Unversioned scenarios cannot carry weighted routes.
    const implicit: CombatScenario = { ...scenario, formatVersion: undefined, routes: [weighted] };
    void missing; void implicit;
}
void scenarioBoundaries;
