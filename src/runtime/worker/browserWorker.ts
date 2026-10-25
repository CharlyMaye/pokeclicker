import { browserWakeScheduler } from '../scheduling/browserSchedulers';
import { WorkerCombatHost, WorkerCombatOptions } from './WorkerCombatHost';
import type { CombatTransport } from './transport';

/** Explicit URL supports subpath deployments; constructing the worker does not activate legacy combat. */
export async function createBrowserCombatHost(workerUrl: URL, options: Omit<WorkerCombatOptions, 'transport' | 'deadlines'>): Promise<WorkerCombatHost> {
    if (!['https:', 'http:'].includes(workerUrl.protocol) || workerUrl.username || workerUrl.password || workerUrl.hash) {
        throw new Error('Expected an HTTP(S) worker asset URL without credentials or fragment');
    }
    const worker = new Worker(workerUrl, { name: options.sessionId });
    const transport: CombatTransport = {
        send: value => worker.postMessage(value),
        close: () => worker.terminate(),
        listen(receive, fail) {
            const onMessage = (event: MessageEvent) => receive(event.data);
            const onError = () => fail(new Error('Combat worker execution failed'));
            const onMessageError = () => fail(new Error('Combat worker message could not be deserialized'));
            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            worker.addEventListener('messageerror', onMessageError);
            return () => {
                worker.removeEventListener('message', onMessage);
                worker.removeEventListener('error', onError);
                worker.removeEventListener('messageerror', onMessageError);
            };
        },
    };
    let host: WorkerCombatHost | undefined;
    try {
        host = new WorkerCombatHost({ ...options, transport, deadlines: browserWakeScheduler });
        await host.initialize();
        return host;
    } catch (error) {
        if (host) {
            host.dispose();
        } else {
            worker.terminate();
        }
        throw error;
    }
}
