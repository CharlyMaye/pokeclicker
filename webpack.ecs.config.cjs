const path = require('node:path');

module.exports = {
    mode: 'production',
    target: 'webworker',
    entry: './src/runtime/worker/combat.worker.ts',
    devtool: 'source-map',
    resolve: { extensions: ['.ts', '.js'] },
    module: { rules: [{ test: /\.ts$/, loader: 'ts-loader', options: {
        configFile: path.resolve(__dirname, 'tsconfig.worker.json'),
        compilerOptions: { noEmit: false },
    } }] },
    output: { filename: 'combat.worker.js', path: path.resolve(__dirname, 'build/ecs') },
};
