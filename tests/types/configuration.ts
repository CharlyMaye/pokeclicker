import type { Configuration } from '../../src/contracts/configuration-types';

declare const settings: Configuration;
// @ts-expect-error The simulation-facing contract does not permit mutation.
settings.combat.clickAttackCooldownMs = 1;
// @ts-expect-error Schema versions are literal contracts, not arbitrary numbers.
const version: Configuration['combat']['schemaVersion'] = 2;
// @ts-expect-error DOM globals must remain unavailable to simulation contracts.
document.createElement('div');
// @ts-expect-error Node globals must not leak through development dependencies.
process.exit(0);
