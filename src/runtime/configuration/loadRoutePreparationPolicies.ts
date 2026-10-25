import { parseRouteHealthPolicy } from '../../simulation/content/routeHealth';
import { parseEncounterRulesPolicy } from '../../simulation/content/encounterRules';
import { ConfigurationLoadError, ConfigurationLoadOptions, loadConfigurationDocuments } from './loadConfiguration';
import release from './generated/release.json';

export function loadRoutePreparationPolicies(baseUrl: string, options: ConfigurationLoadOptions) {
    return loadConfigurationDocuments(baseUrl, { 'route-health': release.files['route-health'], 'encounter-rules': release.files['encounter-rules'] }, options, documents => {
        const parse = <T>(name: string, parser: (value: unknown) => T): T => {
            try {
                return parser(documents[name]);
            } catch (error) {
                throw new ConfigurationLoadError('invalid-config', name, error instanceof Error ? error.message : 'Invalid preparation policy');
            }
        };
        return Object.freeze({ healthPolicy: parse('route-health', parseRouteHealthPolicy), encounterPolicy: parse('encounter-rules', parseEncounterRulesPolicy) });
    });
}
