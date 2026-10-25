import { parseExperiencePolicy } from '../../simulation/experience/experienceRules';
import { ConfigurationLoadError, ConfigurationLoadOptions, loadConfigurationDocuments } from './loadConfiguration';
import release from './generated/release.json';

export function loadExperiencePolicy(baseUrl: string, options: ConfigurationLoadOptions) {
    return loadConfigurationDocuments(baseUrl, { experience: release.files.experience }, options, documents => {
        try {
            return parseExperiencePolicy(documents.experience);
        } catch (error) {
            throw new ConfigurationLoadError('invalid-config', 'experience', error instanceof Error ? error.message : 'Invalid experience policy');
        }
    });
}
