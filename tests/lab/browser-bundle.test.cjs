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
    const { window } = dom; const workers = [], requests = [], downloads = [], revoked = [], frames = new Map(); let frameId = 0;
    Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });
    window.URL.createObjectURL = blob => { downloads.push(blob); return `blob:checkpoint-${downloads.length}`; };
    window.URL.revokeObjectURL = url => revoked.push(url);
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
    return { window, workers, requests, button, click, frame, downloads, revoked };
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
    const displayedTotals = () => Object.fromEntries([...window.document.querySelectorAll('[data-progress-field]')].map(node => [node.dataset.progressField, node.textContent]));
    const capturingTotals = displayedTotals();
    assert.equal(capturingTotals.money, '10'); assert.equal(capturingTotals.pokeballs, '1'); assert.equal(capturingTotals.defeats, '1');
    const select = window.document.querySelector('[data-control="renderer"]'); select.value = 'dom'; select.dispatchEvent(new window.Event('change'));
    await until(() => !x.button('save').disabled); x.frame();
    assert.equal(x.workers.length, 1); assert.equal(window.document.querySelectorAll('.ecs-lab-view > section').length, 1);
    assert.ok(window.document.querySelector('.ecs-combat-diagnostics'));
    assert.deepEqual(displayedTotals(), capturingTotals);
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
    x.frame();
    assert.equal(displayedTotals().money, String(saved.checkpoint.combat.progress.money));
    assert.equal(displayedTotals().pokeballs, String(saved.checkpoint.combat.pokeballs));
    assert.deepEqual(recovered.checkpoint, saved.checkpoint); assert.notEqual(recovered.revision, saved.revision);
    await x.click('load'); x.button('confirm').click(); await until(() => x.workers.length === 3 && !x.button('start').disabled);
    x.frame();
    assert.equal(displayedTotals().money, String(saved.checkpoint.combat.progress.money));
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

function readBlob(window, blob) {
    return new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(blob); });
}
function selectFile(window, content, filename = 'checkpoint.json') {
    const input = window.document.querySelector('[data-control="checkpoint-file"]');
    Object.defineProperty(input, 'files', { configurable: true, value: [new window.File([content], filename, { type: 'application/json' })] });
    input.dispatchEvent(new window.Event('change')); return input;
}
test('portable checkpoint exports unsaved capture progress and imports into another session only after confirmation', { timeout: 20000 }, async t => {
    const source = browser(t); await until(() => source.button('start') && !source.button('start').disabled); await source.click('start');
    for (const time of [50, 100, 150]) { await source.workers[0].tick(time, false); await source.click('attack'); }
    await source.workers[0].tick(300); await until(() => !source.button('export').disabled); await source.click('export');
    assert.equal(source.window.localStorage.getItem(key), null); assert.equal(source.button('attack').disabled, true);
    assert.equal(source.downloads.length, 1); assert.equal(source.button('download').download, lab.checkpointFilename);
    const text = await readBlob(source.window, source.downloads[0]), checkpoint = JSON.parse(text);
    assert.equal(checkpoint.combat.snapshot.encounter.phase, 'capturing'); assert.equal(checkpoint.combat.progress.money, 10);
    const target = browser(t); await until(() => target.button('save') && !target.button('save').disabled); await target.click('save');
    const original = target.window.localStorage.getItem(key); await target.click('start');
    const filename = '<img src=x onerror=alert(1)>.json'; selectFile(target.window, text, filename);
    await until(() => !target.button('import-confirm').disabled);
    assert.equal(target.workers.length, 1); assert.equal(target.window.localStorage.getItem(key), original);
    const preview = target.window.document.querySelector('[data-checkpoint-preview]');
    assert.match(preview.textContent, /Capturing/); assert.equal(target.window.document.querySelector('.ecs-checkpoint-files img'), null);
    assert.ok(target.window.document.querySelector('.ecs-checkpoint-files').textContent.includes(filename));
    target.button('import-cancel').click(); await until(() => !target.button('load').disabled); assert.equal(preview.children.length, 0);
    assert.equal(target.workers.length, 1); assert.equal(target.window.localStorage.getItem(key), original);
    selectFile(target.window, text); await until(() => !target.button('import-confirm').disabled); target.button('import-confirm').click();
    await until(() => target.workers.length === 2 && !target.button('load').disabled); target.frame();
    const record = JSON.parse(target.window.localStorage.getItem(key)); assert.deepEqual(record.checkpoint, checkpoint);
    assert.equal(target.window.localStorage.getItem(key.replace(':current', ':previous')), original);
    assert.equal(target.window.localStorage.getItem(key.replace(':current', ':import-original')), text);
    assert.equal(target.workers[0].closed, true); assert.equal(target.button('attack').disabled, true);
    assert.equal(target.window.document.querySelector('[data-progress-field="money"]').textContent, '10');
    assert.equal(target.window.localStorage.getItem('player'), 'legacy-sentinel');
    await target.click('recover'); target.button('confirm').click(); await until(() => target.workers.length === 3 && !target.button('start').disabled);
    assert.deepEqual(JSON.parse(target.window.localStorage.getItem(key)).checkpoint, JSON.parse(original).checkpoint);
    await source.click('export'); assert.deepEqual(source.revoked, ['blob:checkpoint-1']);
    source.window.dispatchEvent(new source.window.PageTransitionEvent('pagehide'));
    assert.deepEqual(source.revoked, ['blob:checkpoint-1', 'blob:checkpoint-2']);
});

test('file preview rejects empty, oversized, malformed, invalid UTF-8 and incompatible files without replacing progress', { timeout: 20000 }, async t => {
    const x = browser(t); await until(() => x.button('save') && !x.button('save').disabled); await x.click('save'); const original = x.window.localStorage.getItem(key);
    const incompatible = JSON.parse(original).checkpoint; incompatible.combat.scenario.clickAttackDamage++;
    for (const value of ['', ' '.repeat(lab.maxCheckpointBytes + 1), '{broken', new Uint8Array([0xc3, 0x28]), JSON.stringify(incompatible)]) {
        selectFile(x.window, value); await until(() => !x.window.document.querySelector('[data-control="checkpoint-file"]').disabled);
        assert.ok(x.window.document.querySelector('[role="alert"]').textContent.includes(lab.text.failed));
        assert.equal(x.window.document.querySelector('[data-checkpoint-preview]').children.length, 0);
        assert.equal(x.workers.length, 1); assert.equal(x.window.localStorage.getItem(key), original);
    }
});

test('a changed saved revision rejects confirmation and disposes only the prepared import worker', { timeout: 20000 }, async t => {
    const x = browser(t); await until(() => x.button('save') && !x.button('save').disabled); await x.click('save');
    const record = JSON.parse(x.window.localStorage.getItem(key)), text = JSON.stringify(record.checkpoint);
    selectFile(x.window, text); await until(() => !x.button('import-confirm').disabled);
    record.revision = x.window.crypto.randomUUID(); const otherTab = JSON.stringify(record); x.window.localStorage.setItem(key, otherTab);
    x.button('import-confirm').click(); await until(() => x.workers.length === 2 && x.workers[1].closed);
    assert.equal(x.workers[0].closed, false); assert.equal(x.window.localStorage.getItem(key), otherTab);
    assert.match(x.window.document.querySelector('[role="alert"]').textContent, /revision changed/);
    x.button('import-cancel').click(); await until(() => !x.button('load').disabled);
});
