import type { PartyProgress as PartySnapshot } from '../../contracts/combat-progress';
import { catalogId, dataArray, dataObject, safeInteger } from '../combat/input';
import { SimulationInputError } from '../combat/model';
import { finiteRuleNumber } from '../content/encounterPolicy';
import { planExperienceGrant } from './experienceRules';
import { LevelCurve, LevelCurves, parseLevelCurves } from './levelCurves';

export interface PartyMemberDefinition {
    readonly pokemonId: number; readonly curveId: string; readonly experience: number; readonly level: number;
    readonly maxLevel: number; readonly multiplier: number; readonly shadow: boolean;
}
export interface PartyDefinition { readonly levelCurves: LevelCurves; readonly members: readonly PartyMemberDefinition[] }
export interface PartyMemberState { readonly pokemonId: number; readonly experience: number; readonly level: number }
export type { PartyProgress as PartySnapshot } from '../../contracts/combat-progress';
export interface PartyState {
    readonly grants: number; readonly shadowExperience: number; readonly members: ReadonlyMap<number, PartyMemberState>;
}
function requireValid(condition: unknown, detail: string): asserts condition {
    if (!condition) {
        throw new SimulationInputError('invalid-party', detail);
    }
}
function experience(value: unknown): number {
    const result = finiteRuleNumber(value, 'party experience');
    requireValid(result < Number.MAX_SAFE_INTEGER, 'Party experience reaches the level sentinel');
    return result;
}
function curveFor(definition: PartyDefinition, member: PartyMemberDefinition): LevelCurve {
    const curve = definition.levelCurves.curves.find(curve => curve.id === member.curveId);
    if (!curve) {
        throw new SimulationInputError('invalid-party', 'Missing party level curve');
    }
    return curve;
}
function validLevelState(member: { experience: number; level: number; maxLevel: number }, curve: LevelCurve): void {
    requireValid(member.level < curve.thresholds.length && member.maxLevel < curve.thresholds.length, 'Party level or cap exceeds the curve');
    requireValid(member.experience >= curve.thresholds[member.level - 1]
        && (member.level >= member.maxLevel || member.experience < curve.thresholds[member.level]), 'Party level disagrees with experience');
}
export function parsePartyDefinition(value: unknown): PartyDefinition {
    const data = dataObject(value, ['levelCurves', 'members'], 'party definition');
    const levelCurves = parseLevelCurves(data.levelCurves);
    const ids = new Set<number>();
    const members = Array.from(dataArray(data.members, 'party members'), input => {
        const data = dataObject(input, ['pokemonId', 'curveId', 'experience', 'level', 'maxLevel', 'multiplier', 'shadow'], 'party member');
        const pokemonId = catalogId(data.pokemonId);
        const curve = levelCurves.curves.find(curve => curve.id === data.curveId);
        requireValid(!ids.has(pokemonId) && !!curve && typeof data.shadow === 'boolean', 'Duplicate member, unknown curve or invalid shadow flag');
        ids.add(pokemonId);
        const member = { pokemonId, curveId: curve.id, experience: experience(data.experience), level: safeInteger(data.level, 'party level', 1),
            maxLevel: safeInteger(data.maxLevel, 'party level cap', 1), multiplier: finiteRuleNumber(data.multiplier, 'party multiplier'), shadow: data.shadow as boolean };
        validLevelState(member, curve);
        return Object.freeze(member);
    });
    return Object.freeze({ levelCurves, members: Object.freeze(members) });
}
export function createPartyState(definition: PartyDefinition): PartyState {
    return { grants: 0, shadowExperience: 0, members: new Map(definition.members.map(p => [
        p.pokemonId,
        Object.freeze({ pokemonId: p.pokemonId, experience: p.experience, level: p.level }),
    ])) };
}
export function projectPartyState(state: PartyState): PartySnapshot {
    return Object.freeze({ grants: state.grants, shadowExperience: state.shadowExperience,
        members: Object.freeze([...state.members.values()].map(member => Object.freeze({ ...member }))) });
}
/** One defeat at a time. Returns new components; the combat transaction owns the commit. */
export function advancePartyExperience(definition: PartyDefinition, state: PartyState, reward: number): PartyState {
    const recipients = definition.members.map(member => {
        const current = state.members.get(member.pokemonId);
        requireValid(!!current, 'Party experience component is missing');
        return { pokemonId: member.pokemonId, level: current.level, maxLevel: member.maxLevel, multiplier: member.multiplier, shadow: member.shadow };
    });
    const plan = planExperienceGrant(reward, recipients);
    const members = new Map<number, PartyMemberState>();
    definition.members.forEach((member, index) => {
        const current = state.members.get(member.pokemonId);
        requireValid(current, 'Party experience component is missing');
        const nextExperience = experience(current.experience + plan.members[index].stored);
        let level = current.level;
        if (level < member.maxLevel) {
            const curve = curveFor(definition, member);
            // Match PartyPokemon.calculateLevelFromExp, including exact-threshold promotion.
            for (let index = level - 1; index < curve.thresholds.length; index++) {
                if (curve.thresholds[index] > nextExperience) {
                    level = Math.min(index, member.maxLevel);
                    break;
                }
            }
        }
        members.set(member.pokemonId, Object.freeze({ pokemonId: member.pokemonId, experience: nextExperience, level }));
    });
    return { grants: safeInteger(state.grants + 1, 'party grants'), shadowExperience: finiteRuleNumber(state.shadowExperience + plan.shadowExperience, 'shadow experience total'), members };
}
export function parsePartySnapshot(value: unknown, definition: PartyDefinition, defeats: number): PartySnapshot {
    const data = dataObject(value, ['grants', 'shadowExperience', 'members'], 'party checkpoint');
    const grants = safeInteger(data.grants, 'party grants');
    const shadowExperience = finiteRuleNumber(data.shadowExperience, 'shadow experience total');
    requireValid(grants === defeats, 'Party grants must equal committed defeats');
    const required = new Map(definition.members.map(member => [member.pokemonId, member]));
    const members = Array.from(dataArray(data.members, 'saved party members', required.size), input => {
        const data = dataObject(input, ['pokemonId', 'experience', 'level'], 'saved party member');
        const pokemonId = catalogId(data.pokemonId), member = required.get(pokemonId);
        requireValid(!!member, 'Unknown or duplicate saved party member');
        required.delete(pokemonId);
        const current = { pokemonId, experience: experience(data.experience), level: safeInteger(data.level, 'saved party level', 1) };
        validLevelState({ ...current, maxLevel: member.maxLevel }, curveFor(definition, member));
        requireValid(current.level >= member.level && current.level <= Math.max(member.level, member.maxLevel)
            && current.experience >= member.experience, 'Saved party progression regressed or exceeds its cap');
        if (!grants || member.level >= member.maxLevel || member.multiplier === 0) {
            requireValid(current.level === member.level && current.experience === member.experience, 'Inactive party experience changed');
        }
        return Object.freeze(current);
    });
    requireValid(required.size === 0 && (grants > 0 || shadowExperience === 0), 'Missing members or unearned shadow experience');
    requireValid(definition.members.some(member => member.shadow && member.multiplier > 0) || shadowExperience === 0, 'Shadow experience has no eligible recipient');
    const byId = new Map(members.map(member => [member.pokemonId, member]));
    return Object.freeze({ grants, shadowExperience, members: Object.freeze(definition.members.map(member => {
        const saved = byId.get(member.pokemonId);
        requireValid(saved, 'Missing saved member');
        return saved;
    })) });
}
export function restorePartyState(snapshot: PartySnapshot): PartyState {
    return { grants: snapshot.grants, shadowExperience: snapshot.shadowExperience, members: new Map(snapshot.members.map(member => [member.pokemonId, member])) };
}
