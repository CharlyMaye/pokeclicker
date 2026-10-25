import { parseRouteHealthPolicy } from '../../simulation/content/routeHealth';
import { ConfigurationLoadError, ConfigurationLoadOptions, loadConfigurationDocuments } from './loadConfiguration';
import release from './generated/release.json';

export function loadRouteHealthPolicy(baseUrl: string, options: ConfigurationLoadOptions) {
    return loadConfigurationDocuments(baseUrl, { 'route-health': release.files['route-health'] }, options, documents => {
        try {
            return parseRouteHealthPolicy(documents['route-health']);
        } catch (error) {
            throw new ConfigurationLoadError('invalid-config', 'route-health', error instanceof Error ? error.message : 'Invalid route health policy');
        }
    });
}
