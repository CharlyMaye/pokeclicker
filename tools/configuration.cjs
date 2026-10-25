const { readFileSync, statSync, readdirSync } = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

// A boundary limit for these small documents, not a gameplay parameter.
const MAX_CONFIG_BYTES = 64 * 1024;
const ajv = new Ajv({ strict: true, allErrors: true });
const validators = Object.freeze({
    combat: ajv.compile(require('../schemas/combat.schema.json')),
    simulation: ajv.compile(require('../schemas/simulation.schema.json')),
});

function readJson(file) {
    try {
        if (statSync(file).size > MAX_CONFIG_BYTES) {
            throw new Error(`exceeds the ${MAX_CONFIG_BYTES}-byte limit`);
        }
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${file}: ${error.message}`, { cause: error });
    }
}

function validateConfiguration(configuration) {
    for (const [name, validate] of Object.entries(validators)) {
        if (!validate(configuration[name])) {
            const details = ajv.errorsText(validate.errors, { dataVar: name, separator: '; ' });
            throw new Error(`config/${name}.json: ${details}`);
        }
    }
    // Preserve the legacy automatic-attack cadence in this baseline.
    // Clicks may be closer together than a step; they need their own timestamps.
    if (configuration.combat.autoAttackIntervalMs % configuration.simulation.stepMs !== 0) {
        throw new Error('config/combat.json: autoAttackIntervalMs must be a multiple of config/simulation.json stepMs');
    }
    return Object.freeze(Object.fromEntries(
        Object.keys(validators).map(name => [name, Object.freeze({ ...configuration[name] })]),
    ));
}

function loadConfiguration(publicRoot) {
    const directory = path.join(publicRoot, 'config');
    const expected = Object.keys(validators).map(name => `${name}.json`).sort();
    const actual = readdirSync(directory).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${directory}: expected exactly ${expected.join(', ')}; found ${actual.join(', ')}`);
    }
    return validateConfiguration(Object.fromEntries(Object.keys(validators).map(name => [
        name, readJson(path.join(directory, `${name}.json`)),
    ])));
}

module.exports = { loadConfiguration, validateConfiguration, MAX_CONFIG_BYTES };

if (require.main === module) {
    const root = path.resolve(process.argv[2] || 'public');
    try {
        loadConfiguration(root);
        console.log(`Validated configuration in ${root}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
