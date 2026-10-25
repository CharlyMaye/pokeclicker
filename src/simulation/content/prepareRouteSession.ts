import { dataObject } from '../combat/input';
import { applyDamageSnapshot } from '../damage/resolveDamage';
import { compileRouteScenario } from './compileRouteScenario';
import { applyEncounterSnapshot } from './encounterRules';

/** All inputs are validated before a host, worker or storage slot needs to be created. */
export function prepareRouteSession(value: unknown) {
    const data = dataObject(value, ['content', 'healthPolicy', 'damage', 'encounters', 'encounterPolicy'], 'route session preparation');
    const health = compileRouteScenario(data.content, data.healthPolicy);
    const damage = applyDamageSnapshot(health, data.damage);
    return applyEncounterSnapshot(damage, data.encounters, data.encounterPolicy);
}
