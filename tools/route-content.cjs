// Share the exact simulation policy parser with build-time configuration checks.
require('ts-node').register({ transpileOnly: true, skipProject: true, compilerOptions: { module: 'CommonJS', target: 'ES2020' } });
module.exports = require('../src/simulation/content/routeHealth.ts');
