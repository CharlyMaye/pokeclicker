const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../../tools/lab-configuration.cjs');
const { readCheckpointFile, CheckpointDownload } = require('../../src/runtime/persistence/checkpointFiles.ts');
class Reader {
    reads = 0; aborted = 0; result = null;
    readAsArrayBuffer() { this.reads++; }
    abort() { this.aborted++; this.onabort?.(); }
    load(bytes) { this.result = bytes; this.onload?.(); }
}
test('reads strict UTF-8 and detaches all callbacks after completion', async () => {
    const reader = new Reader(), signal = new AbortController(); const bytes = new TextEncoder().encode('{"name":"Pokémon"}');
    const promise = readCheckpointFile({ size: bytes.length }, bytes.length, signal.signal, () => reader);
    reader.load(bytes.buffer); assert.equal(await promise, '{"name":"Pokémon"}');
    assert.equal(reader.onload, null); assert.equal(reader.onerror, null); assert.equal(reader.onabort, null); signal.abort(); assert.equal(reader.aborted, 0);
});
for (const size of [0, -1, 11, Infinity, 1.5]) {
    test(`rejects invalid or oversized file size ${size} before allocating a reader`, async () => {
        let made = false;
        await assert.rejects(readCheckpointFile({ size }, 10, new AbortController().signal, () => { made = true; return new Reader(); }), /byte limit/);
        assert.equal(made, false);
    });
}
test('rejects malformed UTF-8 rather than replacing invalid bytes', async () => {
    const reader = new Reader(); const pending = readCheckpointFile({ size: 2 }, 10, new AbortController().signal, () => reader);
    reader.load(new Uint8Array([0xc3, 0x28]).buffer); await assert.rejects(pending); assert.equal(reader.onload, null);
});
test('rejects a changed byte count and an unexpected reader result', async () => {
    for (const value of [new ArrayBuffer(11), new ArrayBuffer(1), '{}', null]) {
        const reader = new Reader(), pending = readCheckpointFile({ size: 2 }, 10, new AbortController().signal, () => reader);
        reader.load(value); await assert.rejects(pending, /size changed/);
    }
});
test('cancellation before or during reading prevents late delivery', async () => {
    const before = new AbortController(); before.abort(); let made = false;
    await assert.rejects(readCheckpointFile({ size: 2 }, 10, before.signal, () => { made = true; return new Reader(); }), /cancelled/); assert.equal(made, false);
    const active = new AbortController(), reader = new Reader();
    const pending = readCheckpointFile({ size: 2 }, 10, active.signal, () => reader); const late = reader.onload; active.abort();
    await assert.rejects(pending, /cancelled/); reader.result = new TextEncoder().encode('{}').buffer; late(); assert.equal(reader.aborted, 1); assert.equal(reader.onload, null);
});
test('cancellation during reader construction is observed before a read starts', async () => {
    const controller = new AbortController(), reader = new Reader();
    await assert.rejects(readCheckpointFile({ size: 2 }, 10, controller.signal, () => { controller.abort(); return reader; }), /cancelled/);
    assert.equal(reader.reads, 0);
});
test('reader errors and synchronous read failures reject and release callbacks', async () => {
    const reader = new Reader(), pending = readCheckpointFile({ size: 2 }, 10, new AbortController().signal, () => reader);
    reader.onerror(); await assert.rejects(pending, /could not be read/); assert.equal(reader.onload, null);
    const broken = new Reader(); broken.readAsArrayBuffer = () => { throw new Error('denied'); };
    await assert.rejects(readCheckpointFile({ size: 2 }, 10, new AbortController().signal, () => broken), /denied/); assert.equal(broken.onerror, null);
});
test('prepared downloads retain the old link on allocation failure and release URLs on replacement/disposal', () => {
    const link = { hidden: false, removeAttribute(name) { delete this[name]; } }; const revoked = [], created = [];
    const urls = { createObjectURL(blob) { created.push(blob); return `blob:checkpoint-${created.length}`; }, revokeObjectURL(url) { revoked.push(url); } };
    const download = new CheckpointDownload(link, urls, text => ({ text })); assert.equal(link.hidden, true);
    download.prepare('first', 'backup.json'); assert.equal(link.href, 'blob:checkpoint-1'); assert.equal(link.download, 'backup.json'); assert.equal(link.hidden, false);
    download.prepare('second', 'backup.json'); assert.deepEqual(revoked, ['blob:checkpoint-1']); assert.equal(created[1].text, 'second');
    urls.createObjectURL = () => { throw new Error('allocation failed'); }; assert.throws(() => download.prepare('third', 'backup.json')); assert.equal(link.href, 'blob:checkpoint-2');
    download.dispose(); download.dispose(); assert.deepEqual(revoked, ['blob:checkpoint-1', 'blob:checkpoint-2']); assert.equal(link.hidden, true); assert.equal(link.href, undefined);
    assert.throws(() => download.prepare('third', 'backup.json'), /disposed/);
});
