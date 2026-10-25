// The same TypeScript parser validates public lab data in the build and browser.
require('ts-node').register({ transpileOnly: true, skipProject: true, compilerOptions: { module: 'CommonJS', target: 'ES2020' } });
module.exports = require('../src/runtime/lab/configuration.ts');
