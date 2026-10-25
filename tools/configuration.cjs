const { readFileSync, statSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { validateConfiguration, MAX_CONFIG_BYTES } = require('../src/contracts/configuration');
const names = ['combat', 'simulation'];
const { parseLabConfiguration } = require('./lab-configuration.cjs');

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

function loadConfiguration(publicRoot) {
    const directory = path.join(publicRoot, 'config');
    const expected = [...names, 'lab'].map(name => `${name}.json`).sort();
    const actual = readdirSync(directory).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${directory}: expected exactly ${expected.join(', ')}; found ${actual.join(', ')}`);
    }
    parseLabConfiguration(readJson(path.join(directory, 'lab.json')));
    return validateConfiguration(Object.fromEntries(names.map(name => [
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
