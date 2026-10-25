// Test-only bridge: execute the emitted browser worker bundle inside a real Node worker thread.
const { parentPort, workerData } = require('node:worker_threads');
let now = 0;
let nextTimer = 0;
const tasks = new Map();
const listeners = new Map();
const nativeClock = workerData.nativeClock;
globalThis.self = {
    postMessage: value => parentPort.postMessage(value),
    close: () => parentPort.close(),
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: type => listeners.delete(type),
    performance: { now: () => nativeClock ? performance.now() : now },
    setTimeout: (callback, delay) => {
        if (nativeClock) return setTimeout(callback, delay);
        const id = ++nextTimer;
        tasks.set(id, callback);
        return id;
    },
    clearTimeout: id => { if (nativeClock) clearTimeout(id); else tasks.delete(id); },
};
parentPort.on('message', data => {
    if (data.test === 'clock' || data.test === 'wake') {
        now = data.atMs;
        if (data.test === 'wake') {
            const first = tasks.entries().next().value;
            if (first) { tasks.delete(first[0]); first[1](); }
        }
        parentPort.postMessage({ test: 'tick', id: data.id });
    } else {
        listeners.get('message')?.({ data });
    }
});
require(workerData.bundle);
