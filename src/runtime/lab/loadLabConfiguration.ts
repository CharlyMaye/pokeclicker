import { validateConfiguration } from '../../contracts/configuration';
import release from '../configuration/generated/release.json';
import { ConfigurationLoadError, ConfigurationLoadOptions, loadConfigurationDocuments } from '../configuration/loadConfiguration';
import { parseLabConfiguration } from './configuration';

export function loadLabConfiguration(baseUrl: string, options: ConfigurationLoadOptions) {
    function parseLab(value: unknown) {
        try {
            return parseLabConfiguration(value);
        } catch (error) {
            throw new ConfigurationLoadError('invalid-config', 'lab', error instanceof Error ? error.message : 'Invalid lab configuration');
        }
    }
    return loadConfigurationDocuments(baseUrl, release.files, options, documents => Object.freeze({
        configuration: validateConfiguration({ combat: documents.combat, simulation: documents.simulation }),
        lab: parseLab(documents.lab),
    }));
}
