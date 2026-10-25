import { catalogId, dataArray, dataObject, safeInteger } from '../combat/input';
import { SimulationInputError } from '../combat/model';
import { finiteRuleNumber } from '../content/encounterPolicy';

export interface ExperiencePolicy {
    readonly schemaVersion: 1;
    readonly routeLevelScale: number;
    readonly routeLevelExponentDivisor: number;
    readonly experienceDivisor: number;
    readonly trainerMultiplier: number;
}
export function parseExperiencePolicy(value: unknown): ExperiencePolicy {
    const data = dataObject(value, ['schemaVersion', 'routeLevelScale', 'routeLevelExponentDivisor', 'experienceDivisor', 'trainerMultiplier'], 'experience policy');
    if (data.schemaVersion !== 1) {
        throw new SimulationInputError('invalid-input', 'Unsupported experience policy version');
    }
    const positive = (field: string) => {
        const result = finiteRuleNumber(data[field], field);
        if (result === 0) {
            throw new SimulationInputError('invalid-input', `${field} must be positive`);
        }
        return result;
    };
    return Object.freeze({ schemaVersion: 1, routeLevelScale: positive('routeLevelScale'),
        routeLevelExponentDivisor: positive('routeLevelExponentDivisor'), experienceDivisor: positive('experienceDivisor'), trainerMultiplier: positive('trainerMultiplier') });
}

export function calculateRouteLevel(normalizedRoute: number, policy: ExperiencePolicy): number {
    const route = safeInteger(normalizedRoute, 'normalized route', 1);
    return safeInteger(Math.floor(finiteRuleNumber(policy.routeLevelScale * Math.pow(route, 1 / policy.routeLevelExponentDivisor), 'route level')), 'route level', 1);
}

/** Party.gainExp's shared amount, before individual held-item multipliers and level caps. */
export function calculateExperienceReward(value: unknown, policy: ExperiencePolicy): number {
    const data = dataObject(value, ['baseExperience', 'level', 'trainer', 'multiplier'], 'experience reward inputs');
    if (typeof data.trainer !== 'boolean') {
        throw new SimulationInputError('invalid-input', 'trainer must be boolean');
    }
    let reward = finiteRuleNumber(data.baseExperience, 'base experience') * safeInteger(data.level, 'enemy level', 1);
    reward = finiteRuleNumber(reward, 'leveled experience') * (data.trainer ? policy.trainerMultiplier : 1);
    reward = finiteRuleNumber(reward, 'trainer experience') * finiteRuleNumber(data.multiplier, 'experience multiplier');
    return safeInteger(Math.floor(finiteRuleNumber(reward, 'multiplied experience') / policy.experienceDivisor), 'experience reward');
}

/** Pure plan for one defeat. It does not level, evolve, mutate a party or credit purification. */
export function planExperienceGrant(sharedExperience: number, membersValue: unknown) {
    safeInteger(sharedExperience, 'shared experience');
    const ids = new Set<number>();
    let shadowExperience = 0;
    const members = Array.from(dataArray(membersValue, 'experience recipients'), input => {
        const data = dataObject(input, ['pokemonId', 'level', 'maxLevel', 'multiplier', 'shadow'], 'experience recipient');
        const pokemonId = catalogId(data.pokemonId);
        if (ids.has(pokemonId) || typeof data.shadow !== 'boolean') {
            throw new SimulationInputError('invalid-input', 'Experience recipients must be unique and shadow must be boolean');
        }
        ids.add(pokemonId);
        const level = safeInteger(data.level, 'recipient level', 1);
        const maxLevel = safeInteger(data.maxLevel, 'recipient level cap', 1);
        const calculated = finiteRuleNumber(sharedExperience * finiteRuleNumber(data.multiplier, 'recipient multiplier'), 'recipient experience');
        // Legacy gainExp returns this amount even when its level cap prevents storage.
        if (data.shadow) {
            shadowExperience = finiteRuleNumber(shadowExperience + calculated, 'shadow experience total');
        }
        return Object.freeze({ pokemonId, calculated, stored: level < maxLevel ? calculated : 0 });
    });
    return Object.freeze({ members: Object.freeze(members), shadowExperience });
}
