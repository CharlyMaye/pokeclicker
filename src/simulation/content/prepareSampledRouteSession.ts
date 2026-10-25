import { dataObject } from '../combat/input';
import { validateScenario } from '../combat/validation';
import { applyDamageSnapshot } from '../damage/resolveDamage';
import { compileRouteScenario } from './compileRouteScenario';

/** Opt in to per-spawn sampling; resolved v1/v2 preparation keeps its original semantics. */
export function prepareSampledRouteSession(value: unknown) {
    const data = dataObject(value, ['content', 'healthPolicy', 'damage', 'spawnRules'], 'sampled route preparation');
    const health = compileRouteScenario(data.content, data.healthPolicy);
    const damage = applyDamageSnapshot(health, data.damage);
    return validateScenario({ ...damage, formatVersion: 3, spawnRules: data.spawnRules });
}
