const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function publishConfiguration(outputRoot) {
    const root = path.resolve(__dirname, '..');
    // Read afresh so watch builds do not reuse a cached release descriptor.
    const release = JSON.parse(readFileSync(path.join(root, 'src/runtime/configuration/generated/release.json'), 'utf8'));
    const files = Object.entries(release.files).map(([name, file]) => {
        const bytes = readFileSync(path.join(root, `public/config/${name}.json`));
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
            throw new Error(`config/${name}.json changed. Run npm run generate:config.`);
        }
        return [file.path, bytes];
    });
    for (const [relative, bytes] of files) {
        const destination = path.join(outputRoot, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
    }
    writeFileSync(path.join(outputRoot, 'configuration/manifest.json'), `${JSON.stringify(release, null, 2)}\n`);
}

module.exports = { publishConfiguration };
