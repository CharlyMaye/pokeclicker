export class ManualScheduler {
    tasks = [];
    schedule(callback, delayMs) {
        const task = { callback, delayMs, canceled: false, called: false };
        this.tasks.push(task);
        return () => { task.canceled = true; };
    }
    get active() { return this.tasks.filter(task => !task.canceled && !task.called); }
    fire() {
        const task = this.active[0];
        if (!task) throw new Error('No scheduled task');
        task.called = true;
        task.callback();
        return task;
    }
}

export function channel() {
    const queue = [];
    const endpoints = [{}, {}];
    const ports = endpoints.map((endpoint, index) => ({
        sent: [], closed: false,
        send(value) {
            const copy = structuredClone(value);
            this.sent.push(copy);
            queue.push(() => endpoints[1 - index].receive?.(copy));
        },
        listen(receive, fail) {
            endpoint.receive = receive; endpoint.fail = fail;
            return () => { endpoint.receive = null; endpoint.fail = null; };
        },
        close() { this.closed = true; },
    }));
    return { ports, endpoints, queue, flush() { while (queue.length) queue.shift()(); } };
}
