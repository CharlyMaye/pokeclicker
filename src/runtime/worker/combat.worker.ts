import { CombatWorkerServer } from './CombatWorkerServer';

const scope = self as DedicatedWorkerGlobalScope;

new CombatWorkerServer({
    send: value => scope.postMessage(value),
    close: () => scope.close(),
    listen(receive, fail) {
        const onMessage = (event: MessageEvent) => receive(event.data);
        const onError = () => fail(new Error('Combat worker input could not be deserialized'));
        scope.addEventListener('message', onMessage);
        scope.addEventListener('messageerror', onError);
        return () => {
            scope.removeEventListener('message', onMessage);
            scope.removeEventListener('messageerror', onError);
        };
    },
}, () => scope.performance.now(), {
    schedule(callback, delayMs) {
        // Browser timer representation limit, not a gameplay setting.
        if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2 ** 31 - 1) {
            throw new Error('Worker timer delay exceeds the browser range');
        }
        const handle = scope.setTimeout(callback, delayMs);
        return () => scope.clearTimeout(handle);
    },
});
