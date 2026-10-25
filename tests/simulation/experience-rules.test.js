import { describe, expect, it, vi } from 'vitest';
import { calculateExperienceReward, calculateRouteLevel, parseExperiencePolicy, planExperienceGrant } from '../../src/simulation/experience/experienceRules';
import input from '../../public/config/experience.json';
const policy = parseExperiencePolicy(input);
const rewardInput = () => ({ baseExperience: 64, level: 20, trainer: false, multiplier: 1.5 });
const recipients = () => [
    { pokemonId: 1, level: 10, maxLevel: 100, multiplier: 1.5, shadow: false },
    { pokemonId: 2, level: 100, maxLevel: 100, multiplier: 1.25, shadow: true },
    { pokemonId: 3.01, level: 10, maxLevel: 100, multiplier: 2, shadow: true },
];
describe('experience rules and grant planning', () => {
    it('derives route level and rounds shared experience before individual bonuses', () => {
        expect(calculateRouteLevel(1, policy)).toBe(20);
        expect(calculateExperienceReward(rewardInput(), policy)).toBe(213);
        expect(planExperienceGrant(213, recipients())).toEqual({ members: [
            { pokemonId: 1, calculated: 319.5, stored: 319.5 },
            { pokemonId: 2, calculated: 266.25, stored: 0 },
            { pokemonId: 3.01, calculated: 426, stored: 426 },
        ], shadowExperience: 692.25 });
    });
    it('treats zero multipliers and empty parties explicitly', () => {
        expect(calculateExperienceReward({ ...rewardInput(), multiplier: 0 }, policy)).toBe(0);
        expect(planExperienceGrant(0, recipients()).members.every(p => p.calculated === 0)).toBe(true);
        expect(planExperienceGrant(213, [])).toEqual({ members: [], shadowExperience: 0 });
    });
    it('does not store experience for members already above a lowered cap', () => {
        const members = recipients(); members[0].maxLevel = 5;
        expect(planExperienceGrant(213, members).members[0].stored).toBe(0);
    });
    it('returns detached immutable plans and never changes inputs', () => {
        const members = recipients(), before = structuredClone(members), plan = planExperienceGrant(213, members);
        expect(members).toEqual(before); expect(Object.isFrozen(plan.members[0])).toBe(true); expect(Object.isFrozen(plan.members)).toBe(true);
        members[0].multiplier = 2; expect(plan.members[0].calculated).toBe(319.5);
    });
    it.each([
        ['unknown version', p => { p.schemaVersion = 2; }], ['missing coefficient', p => { delete p.experienceDivisor; }],
        ['extra property', p => { p.defaultBonus = 1; }], ['zero divisor', p => { p.experienceDivisor = 0; }],
        ['negative scale', p => { p.routeLevelScale = -1; }], ['nonfinite exponent', p => { p.routeLevelExponentDivisor = Infinity; }],
    ])('rejects policy %s', (_name, mutate) => { const p = { ...input }; mutate(p); expect(() => parseExperiencePolicy(p)).toThrow(); });
    it.each([
        ['negative base', p => { p.baseExperience = -1; }], ['noninteger level', p => { p.level = 1.5; }],
        ['missing multiplier', p => { delete p.multiplier; }], ['nonboolean trainer', p => { p.trainer = 1; }],
        ['overflow', p => { p.multiplier = Number.MAX_SAFE_INTEGER; }],
    ])('rejects reward %s', (_name, mutate) => { const p = rewardInput(); mutate(p); expect(() => calculateExperienceReward(p, policy)).toThrow(); });
    it.each([
        ['duplicate IDs', p => { p[1].pokemonId = p[0].pokemonId; }], ['negative multiplier', p => { p[1].multiplier = -1; }],
        ['zero cap', p => { p[1].maxLevel = 0; }], ['invalid shadow', p => { p[1].shadow = 1; }],
        ['overflow even while capped', p => { p[1].multiplier = Number.MAX_SAFE_INTEGER; }],
    ])('rejects recipient %s', (_name, mutate) => { const p = recipients(); mutate(p); expect(() => planExperienceGrant(213, p)).toThrow(); });
    it('rejects aggregate shadow overflow and invalid route levels', () => {
        const p = recipients().slice(1); p.forEach(m => { m.multiplier = 1; });
        expect(() => planExperienceGrant(Number.MAX_SAFE_INTEGER, p)).toThrow('shadow');
        expect(() => calculateRouteLevel(0, policy)).toThrow();
        expect(() => calculateRouteLevel(Number.MAX_SAFE_INTEGER, { ...policy, routeLevelScale: Number.MAX_SAFE_INTEGER })).toThrow();
    });
    it('does not execute getters at JSON boundaries', () => {
        const get = vi.fn(() => 1), p = recipients(); Object.defineProperty(p[0], 'multiplier', { get });
        expect(() => planExperienceGrant(213, p)).toThrow(); expect(get).not.toHaveBeenCalled();
    });
});
