const createInput = require('./legacy-route-source.cjs');
module.exports = function createExperienceInput() {
    const input = createInput();
    input.experiencePolicy = require('../../../public/config/experience.json');
    input.session.formatVersion = 2;
    input.pokemonList.forEach(p => { p.exp = 64; });
    input.session.routes.forEach(route => route.opponents.forEach(p => {
        delete p.experienceReward;
        p.experienceMultiplier = 1.5;
    }));
    return input;
};
