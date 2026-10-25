import type { CombatConfiguration } from './generated/combat';
import type { SimulationConfiguration } from './generated/simulation';

export type Configuration = Readonly<{
    combat: Readonly<CombatConfiguration>;
    simulation: Readonly<SimulationConfiguration>;
}>;
