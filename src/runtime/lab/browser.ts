import bootstrap from '../../../public/config/lab.json';
import { parseLabConfiguration } from './configuration';
import { loadLabConfiguration } from './loadLabConfiguration';
import { mountCombatLab } from './mountLab';

async function start(): Promise<void> {
    const policy = parseLabConfiguration(bootstrap);
    document.title = policy.text.title;
    const container = document.getElementById('combat-lab');
    if (!container) {
        throw new Error('Missing combat lab container');
    }
    container.textContent = policy.text.loading;
    const base = new URL('../', document.baseURI);
    const controller = new AbortController();
    const cancel = (event: PageTransitionEvent) => {
        if (!event.persisted) {
            controller.abort();
        }
    };
    window.addEventListener('pagehide', cancel);
    try {
        if (typeof Worker !== 'function') {
            throw new Error(policy.text.unsupported);
        }
        const bundle = await loadLabConfiguration(base.href, { timeoutMs: policy.startupTimeoutMs, signal: controller.signal });
        if (controller.signal.aborted) {
            return;
        }
        container.textContent = '';
        mountCombatLab(container, base, bundle.configuration, bundle.lab);
    } catch (error) {
        if (!controller.signal.aborted) {
            container.textContent = `${policy.text.failedStartup} ${error instanceof Error ? error.message : String(error)}`;
            container.setAttribute('role', 'alert');
        }
    } finally {
        window.removeEventListener('pagehide', cancel);
    }
}

void start();
