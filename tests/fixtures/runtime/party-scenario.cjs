require('ts-node').register({ transpileOnly: true, skipProject: true, compilerOptions: { module: 'CommonJS', target: 'ES2020' } });
const { prepareLegacyExperienceSession } = require('../../../src/runtime/legacy/prepareLegacyExperienceSession.ts');
const { withPartyExperience } = require('../../../src/simulation/experience/withPartyExperience.ts');
module.exports = () => withPartyExperience(prepareLegacyExperienceSession(require('./experience-route-source.cjs')()), {
    levelCurves: require('../../../public/config/level-curves.json'),
    members: [
        { pokemonId: 1, curveId: 'fast', experience: 0, level: 1, maxLevel: 3, multiplier: 1.5, shadow: false },
        { pokemonId: 2, curveId: 'fast', experience: 800000, level: 100, maxLevel: 100, multiplier: 1.25, shadow: true },
        { pokemonId: 3.01, curveId: 'mediumfast', experience: 0, level: 1, maxLevel: 100, multiplier: 0.5, shadow: true },
    ],
});
