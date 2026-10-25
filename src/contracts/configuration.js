const { validateCombat, validateSimulation } = require('./generated/validators');

// A boundary limit for these small documents, not a gameplay parameter.
const MAX_CONFIG_BYTES = 64 * 1024;

class ConfigurationValidationError extends Error {
    /** @param {string} file @param {string} detail */
    constructor(file, detail) {
        super(`config/${file}.json: ${detail}`);
        this.name = 'ConfigurationValidationError';
        this.file = file;
    }
}

/**
 * @param {{ combat: unknown, simulation: unknown }} configuration
 * @returns {import('./configuration-types').Configuration}
 */
function validateConfiguration(configuration) {
    const { combat, simulation } = configuration;
    if (!validateCombat(combat)) {
        throw new ConfigurationValidationError('combat', JSON.stringify(validateCombat.errors));
    }
    if (!validateSimulation(simulation)) {
        throw new ConfigurationValidationError('simulation', JSON.stringify(validateSimulation.errors));
    }
    // Clicks can occur within a step; automatic attacks retain the legacy cadence.
    if (combat.autoAttackIntervalMs % simulation.stepMs !== 0) {
        throw new ConfigurationValidationError('combat', 'autoAttackIntervalMs must be a multiple of config/simulation.json stepMs');
    }
    // These schemas contain only scalar fields. Copy before freezing to avoid
    // mutating caller-owned data or retaining writable references.
    return Object.freeze({
        combat: Object.freeze({ ...combat }),
        simulation: Object.freeze({ ...simulation }),
    });
}

module.exports = { validateConfiguration, ConfigurationValidationError, MAX_CONFIG_BYTES };
