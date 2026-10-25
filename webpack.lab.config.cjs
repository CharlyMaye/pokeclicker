const path = require('node:path');
module.exports = {
    mode: 'production', target: 'web', entry: './src/runtime/lab/browser.ts', devtool: 'source-map',
    resolve: { extensions: ['.ts', '.js', '.json'] },
    module: { rules: [{ test: /\.ts$/, loader: 'ts-loader', options: {
        configFile: path.resolve(__dirname, 'tsconfig.runtime.json'), compilerOptions: { noEmit: false },
    } }] },
    output: { filename: 'lab.js', path: path.resolve(__dirname, 'build/ecs') },
};
