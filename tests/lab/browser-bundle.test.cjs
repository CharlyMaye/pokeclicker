const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const lab = require('../../public/config/lab.json');
const release = require('../../src/runtime/configuration/generated/release.json');
const root = path.resolve(__dirname, '../..');
const key = `pokeclicker:ecs:checkpoints:v1:${lab.saveSlot}:current`;
async function until(predicate) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for browser state');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
function browser(t, { corruptConfig = false, initialSave } = {}) {
    const dom = new JSDOM(readFileSync(path.join(root, 'public/ecs/index.html'), 'utf8'), {
        url: 'https://example.test/pokeclicker/ecs/', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const { window } = dom; const workers = [], requests = [], frames = new Map(); let frameId = 0;
    Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });
    window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    Object.defineProperty(window.navigator, 'locks', { value: { request: async (_name, _options, operation) => operation() } });
    window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
    window.cancelAnimationFrame = id => frames.delete(id);
    if (initialSave) window.localStorage.setItem(key, initialSave);
    window.localStorage.setItem('player', 'legacy-sentinel');
    window.fetch = async url => {
        requests.push(url); const relative = new URL(url).pathname.replace('/pokeclicker/', '');
        const name = Object.keys(release.files).find(name => release.files[name].path === relative);
        if (!name) return new Response('', { status: 404 });
        const content = readFileSync(path.join(root, 'public/config', `${name}.json`));
        return new Response(corruptConfig && name === 'lab' ? '{}' : content);
    };
    window.Worker = class extends window.EventTarget {
        constructor(url) {
            super(); assert.equal(url.href, 'https://example.test/pokeclicker/ecs/combat.worker.js');
            this.closed = false; this.next = 0; this.ticks = new Map();
            this.worker = new Worker(path.join(root, 'tests/worker/browser-scope.cjs'), { workerData: { bundle: path.join(root, 'build/ecs/combat.worker.js') } });
            this.worker.on('message', data => {
                if (data.test) { this.ticks.get(data.id)?.(); this.ticks.delete(data.id); }
                else if (!this.closed) this.dispatchEvent(new window.MessageEvent('message', { data: window.JSON.parse(JSON.stringify(data)) }));
            });
            this.worker.on('error', () => this.dispatchEvent(new window.Event('error')));
            workers.push(this);
        }
        postMessage(data) { this.worker.postMessage(data); }
        terminate() { this.closed = true; void this.worker.terminate(); }
        tick(atMs, wake = true) { return new Promise(resolve => { const id = ++this.next; this.ticks.set(id, resolve); this.worker.postMessage({ test: wake ? 'wake' : 'clock', atMs, id }); }); }
    };
    t.after(async () => { window.dispatchEvent(new window.PageTransitionEvent('pagehide')); window.close(); await Promise.all(workers.map(worker => worker.worker.terminate())); });
    window.eval(readFileSync(path.join(root, 'build/ecs/lab.js'), 'utf8'));
    const button = name => window.document.querySelector(`[data-action="${name}"]`);
    const click = async name => { await until(() => button(name) && !button(name).disabled); button(name).click(); await until(() => !button('load').disabled || !window.document.querySelector('fieldset').hidden); };
    const frame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); };
    return { window, workers, requests, button, click, frame };
}

test('emitted page plays, swaps views, saves, reloads and recovers under the Pages subpath', { timeout: 20000 }, async t => {
    const x = browser(t); const { window } = x;
    await until(() => x.button('start') && !x.button('start').disabled);
    assert.equal(x.requests.length, 3); assert.equal(x.workers.length, 1);
    assert.equal(window.document.querySelector('a').href, 'https://example.test/pokeclicker/');
    assert.equal(window.document.querySelector('option[value="0:4"]').disabled, true);
    assert.equal(window.document.querySelector('option[value="1:1"]').disabled, true);
    await x.click('start'); const first = x.workers[0];
    for (const time of [50, 100, 150]) { await first.tick(time, false); await x.click('attack'); }
    await first.tick(300); await until(() => !x.button('save').disabled);
    x.frame(); assert.match(window.document.querySelector('[data-combat-field="status"]').textContent, /Capturing/);
    const select = window.document.querySelector('[data-control="renderer"]'); select.value = 'dom'; select.dispatchEvent(new window.Event('change'));
    await until(() => !x.button('save').disabled); x.frame();
    assert.equal(x.workers.length, 1); assert.equal(window.document.querySelectorAll('.ecs-lab-view > section').length, 1);
    assert.ok(window.document.querySelector('.ecs-combat-diagnostics'));
    const route = window.document.querySelector('[data-control="route"]'); route.value = '0:2'; route.dispatchEvent(new window.Event('change'));
    await until(() => !x.button('save').disabled); await first.tick(400); await until(() => !x.button('save').disabled);
    await x.click('save'); const saved = JSON.parse(window.localStorage.getItem(key));
    assert.equal(saved.checkpoint.combat.snapshot.location.route, 2); assert.equal(x.button('attack').disabled, true);
    assert.equal(saved.checkpoint.combat.snapshot.encounter.phase, 'fighting');
    await x.click('start'); await first.tick(800); await until(() => !x.button('save').disabled); await x.click('save');
    const newer = JSON.parse(window.localStorage.getItem(key)); assert.ok(newer.checkpoint.activeTimeMs > saved.checkpoint.activeTimeMs);
    await x.click('load'); assert.equal(x.workers.length, 1); assert.equal(window.document.querySelector('fieldset').hidden, false);
    x.button('cancel').click(); assert.equal(window.document.activeElement, x.button('load'));
    await x.click('recover'); x.button('confirm').click(); await until(() => x.workers.length === 2 && !x.button('start').disabled);
    assert.equal(first.closed, true); const recovered = JSON.parse(window.localStorage.getItem(key));
    assert.deepEqual(recovered.checkpoint, saved.checkpoint); assert.notEqual(recovered.revision, saved.revision);
    await x.click('load'); x.button('confirm').click(); await until(() => x.workers.length === 3 && !x.button('start').disabled);
    assert.equal(window.localStorage.getItem('player'), 'legacy-sentinel');
    await x.click('start'); Object.defineProperty(window.document, 'hidden', { configurable: true, value: true });
    window.document.dispatchEvent(new window.Event('visibilitychange')); await until(() => !x.button('start').disabled);
    Object.defineProperty(window.document, 'hidden', { configurable: true, value: false }); window.document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(x.button('attack').disabled, true); assert.equal(window.localStorage.getItem('player'), 'legacy-sentinel');
});

test('pinned configuration integrity failure creates no worker or storage writes', async t => {
    const x = browser(t, { corruptConfig: true }); await until(() => x.window.document.getElementById('combat-lab').getAttribute('role') === 'alert');
    assert.match(x.window.document.body.textContent, /does not match/); assert.equal(x.workers.length, 0); assert.equal(x.window.localStorage.getItem(key), null);
});

test('corrupt existing save is retained and reported before worker creation', async t => {
    const x = browser(t, { initialSave: '{broken' }); await until(() => x.window.document.querySelector('[role="alert"]')?.textContent.includes(lab.text.failed));
    assert.equal(x.workers.length, 0); assert.equal(x.window.localStorage.getItem(key), '{broken'); assert.equal(x.button('start').disabled, true);
});
