import type { CombatCheckpoint } from '../../src/simulation/combat/checkpoint';
import type { CombatScenario } from '../../src/simulation/combat/model';
function immutableSampling(checkpoint: CombatCheckpoint, scenario: CombatScenario): void {
    if (checkpoint.formatVersion === 2) {
        // @ts-expect-error A saved sample is immutable.
        checkpoint.spawnSample.moneyDeviation = 0;
    }
    if (scenario.formatVersion === 3) {
        // @ts-expect-error Sample rules are immutable session inputs.
        scenario.spawnRules.policy.moneyDeviationMax = 100;
        // @ts-expect-error Profiles are copied and frozen.
        scenario.spawnRules.opponents.push(scenario.spawnRules.opponents[0]);
    }
}
void immutableSampling;
