import { describe, expect, it } from 'vitest';
import SeededRand from '../../src/modules/utilities/SeededRand';
import { sampleSpawn } from '../../src/simulation/combat/spawnRules';
import { parseEncounterRulesPolicy } from '../../src/simulation/content/encounterPolicy';
import policyInput from '../../public/config/encounter-rules.json';
class ControlledRandom extends SeededRand { static value = 0; static next() { return this.value; } }
const policy = parseEncounterRulesPolicy(policyInput);
describe('legacy spawn variation sampling', () => {
    it.each([0, 0.01, 0.25, 0.5, 0.99, 1 - Number.EPSILON])('matches real Rand.intBetween for draw %s', draw => {
        ControlledRandom.value = draw;
        const expectedCatch = ControlledRandom.intBetween(policy.catchVariationMin, policy.catchVariationMax);
        const expectedMoney = ControlledRandom.intBetween(policy.moneyDeviationMin, policy.moneyDeviationMax);
        let calls = 0;
        expect(sampleSpawn({ policy }, () => { calls++; return draw; })).toEqual({ catchVariation: expectedCatch, moneyDeviation: expectedMoney });
        expect(calls).toBe(2);
    });
});
