import { SimulationInputError } from '../combat/model';
import { validateScenario } from '../combat/validation';

/** Attach an explicit initial party snapshot to an already prepared sampled scenario. */
export function withPartyExperience(scenarioValue: unknown, party: unknown) {
    const scenario = validateScenario(scenarioValue);
    if (scenario.formatVersion !== 3) {
        throw new SimulationInputError('invalid-input', 'Party progression requires a prepared version 3 scenario');
    }
    return validateScenario({ ...scenario, formatVersion: 4, party });
}
