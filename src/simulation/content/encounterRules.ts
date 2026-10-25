import { catalogId, dataArray, dataObject, safeInteger } from '../combat/input';
import { CombatScenario, SimulationInputError } from '../combat/model';
import { routeKey } from '../combat/routes';
import { validateLocation, validateScenario } from '../combat/validation';

import { calculateEncounterRules, parseEncounterRulesPolicy } from './encounterPolicy';
export { calculateEncounterRules, parseEncounterRulesPolicy, EncounterRulesPolicy } from './encounterPolicy';

export function applyEncounterSnapshot(scenarioValue: unknown, snapshotValue: unknown, policyValue: unknown): CombatScenario {
    const scenario = validateScenario(scenarioValue);
    if (scenario.formatVersion === 3) {
        throw new SimulationInputError('invalid-input', 'Resolved encounter snapshots cannot replace sampled spawn rules');
    }
    const policy = parseEncounterRulesPolicy(policyValue);
    const snapshot = dataObject(snapshotValue, ['formatVersion', 'opponents'], 'encounter snapshot');
    if (snapshot.formatVersion !== 1) {
        throw new SimulationInputError('invalid-input', 'Unsupported encounter snapshot version');
    }
    const profiles = new Map<string, ReturnType<typeof calculateEncounterRules>>();
    const key = (location: { region: number; route: number }, id: number) => `${routeKey(location)}:${id}`;
    for (const input of dataArray(snapshot.opponents, 'encounter profiles')) {
        const profile = dataObject(input, ['location', 'pokemonId', 'inputs'], 'encounter profile');
        const location = validateLocation(profile.location);
        const id = key(location, catalogId(profile.pokemonId));
        if (profiles.has(id)) {
            throw new SimulationInputError('invalid-input', 'Duplicate encounter profile');
        }
        profiles.set(id, calculateEncounterRules(profile.inputs, location.region, policy));
    }
    const routes = scenario.routes.map(route => ({ ...route, opponents: route.opponents.map(opponent => {
        const id = key(route.location, opponent.pokemonId);
        const rules = profiles.get(id);
        if (!rules) {
            throw new SimulationInputError('invalid-input', 'Missing encounter profile');
        }
        profiles.delete(id);
        return { ...opponent, ...rules };
    }) }));
    if (profiles.size) {
        throw new SimulationInputError('invalid-input', 'Unknown encounter profile');
    }
    return validateScenario({ ...scenario, routes });
}
