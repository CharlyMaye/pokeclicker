import { planExperienceGrant } from '../../src/simulation/experience/experienceRules';
const plan = planExperienceGrant(1, []);
// @ts-expect-error Grant plans cannot be mutated by a downstream consumer.
plan.shadowExperience = 1;
// @ts-expect-error Recipient grants are immutable values.
plan.members[0].stored = 1;
// @ts-expect-error The recipient list is immutable.
plan.members.push({ pokemonId: 1, calculated: 1, stored: 1 });
