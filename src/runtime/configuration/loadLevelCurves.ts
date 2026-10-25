import { parseLevelCurves } from '../../simulation/experience/levelCurves';
import { ConfigurationLoadError, ConfigurationLoadOptions, loadConfigurationDocuments } from './loadConfiguration';
import release from './generated/release.json';

export function loadLevelCurves(baseUrl: string, options: ConfigurationLoadOptions) {
    return loadConfigurationDocuments(baseUrl, { 'level-curves': release.files['level-curves'] }, options, documents => {
        try {
            return parseLevelCurves(documents['level-curves']);
        } catch (error) {
            throw new ConfigurationLoadError('invalid-config', 'level-curves', error instanceof Error ? error.message : 'Invalid level curves');
        }
    });
}
