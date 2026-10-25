const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { loadConfiguration } = require('./configuration.cjs');

async function checkPublishedConfiguration(outputRoot) {
    const sourceRoot = path.resolve(__dirname, '../public');
    const expected = loadConfiguration(sourceRoot);
    assert.deepEqual(loadConfiguration(outputRoot), expected);
    const files = new Map(Object.keys(expected).map(name => [
        `/pokeclicker/config/${name}.json`, readFileSync(path.join(outputRoot, 'config', `${name}.json`)),
    ]));
    const release = require('../src/runtime/configuration/generated/release.json');
    assert.deepEqual(JSON.parse(readFileSync(path.join(outputRoot, 'configuration/manifest.json'), 'utf8')), release);
    for (const [name, file] of Object.entries(release.files)) {
        const bytes = readFileSync(path.join(outputRoot, file.path));
        assert.deepEqual(bytes, readFileSync(path.join(sourceRoot, 'config', `${name}.json`)));
        files.set(`/pokeclicker/${file.path}`, bytes);
    }
    // Serve only the emitted files at the Pages project subpath. This checks
    // packaging and relative URL resolution; it is not a browser runtime loader.
    const server = createServer((request, response) => {
        const content = files.get(request.url);
        response.writeHead(content ? 200 : 404, { 'Content-Type': 'application/json' });
        response.end(content);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const base = `http://127.0.0.1:${server.address().port}/pokeclicker/`;
        for (const [urlPath, bytes] of files) {
            const response = await fetch(new URL(urlPath, base));
            assert.equal(response.status, 200);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
        }
        assert.equal((await fetch(new URL('/config/combat.json', base))).status, 404);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

checkPublishedConfiguration(path.resolve(process.argv[2] || 'docs')).then(() => {
    console.log('Published JSON matches source and is accessible under /pokeclicker/config/.');
}).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
