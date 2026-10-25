import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfiguration } from '../../src/runtime/configuration/loadConfiguration';
import { MAX_CONFIG_BYTES, validateConfiguration } from '../../src/contracts/configuration';
import release from '../../src/runtime/configuration/generated/release.json';
import publisher from '../../tools/publish-configuration.cjs';

const source = name => readFileSync(new URL(`../../public/config/${name}.json`, import.meta.url));
let server;
let directory;
let origin;
const requested = [];

beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'pokeclicker-runtime-'));
    publisher.publishConfiguration(directory);
    const files = new Map(Object.values(release.files).flatMap(file => [
        [`/${file.path}`, readFileSync(path.join(directory, file.path))],
        [`/pokeclicker/${file.path}`, readFileSync(path.join(directory, file.path))],
    ]));
    server = createServer((request, response) => {
        requested.push(request.url);
        const content = files.get(request.url);
        response.writeHead(content ? 200 : 404, { 'Content-Type': 'application/json' });
        response.end(content);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => vi.useRealTimers());
afterAll(async () => {
    if (server) {
        await new Promise(resolve => server.close(resolve));
    }
    if (directory) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('runtime configuration boundary', () => {
    it.each(['/', '/pokeclicker/'])('loads published versioned files from %s', async prefix => {
        const settings = await loadConfiguration(`${origin}${prefix}`, { timeoutMs: 5000 });
        expect(settings).toEqual({ combat: JSON.parse(source('combat')), simulation: JSON.parse(source('simulation')) });
        expect(Object.isFrozen(settings)).toBe(true);
        expect(Object.values(settings).every(Object.isFrozen)).toBe(true);
        for (const file of Object.values(release.files)) {
            expect(requested).toContain(`${prefix}${file.path}`);
        }
    });

    it.each(['relative/', 'file:///tmp/', 'https://example.com/pokeclicker', 'https://example.com/?x=1', 'https://user@example.com/'])('rejects invalid base URL %s before fetching', async base => {
        const fetchFile = vi.fn();
        await expect(loadConfiguration(base, { timeoutMs: 5000, fetch: fetchFile })).rejects.toMatchObject({ code: 'invalid-options' });
        expect(fetchFile).not.toHaveBeenCalled();
    });

    it.each([0, -1, Infinity, 1.5, 2147483648])('rejects an invalid timeout %s', async timeoutMs => {
        await expect(loadConfiguration(`${origin}/`, { timeoutMs })).rejects.toMatchObject({ code: 'invalid-options' });
    });

    it('reports missing files without returning partial settings', async () => {
        await expect(loadConfiguration(`${origin}/missing/`, { timeoutMs: 5000 }))
            .rejects.toMatchObject({ code: 'http', file: release.files.combat.path, message: expect.stringContaining('404') });
    });

    it('rejects stale or modified bytes even if they are valid JSON', async () => {
        const fetchFile = vi.fn(async url => new Response(url.endsWith('/combat.json') ? source('combat') : '{"schemaVersion":1,"stepMs":50}'));
        await expect(loadConfiguration(`${origin}/`, { timeoutMs: 5000, fetch: fetchFile }))
            .rejects.toMatchObject({ code: 'integrity', file: release.files.simulation.path });
        expect(fetchFile).toHaveBeenCalledTimes(2);
    });

    it('does not silently replace malformed JSON with defaults', async () => {
        await expect(loadConfiguration(`${origin}/`, { timeoutMs: 5000, fetch: async () => new Response('{broken') }))
            .rejects.toMatchObject({ code: 'integrity' });
    });

    it('rejects an absent response body', async () => {
        await expect(loadConfiguration(`${origin}/`, { timeoutMs: 5000, fetch: async () => new Response(null) }))
            .rejects.toMatchObject({ code: 'invalid-json' });
    });

    it('caps actual streamed bytes and cancels the reader despite a false Content-Length', async () => {
        const cancel = vi.fn();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(MAX_CONFIG_BYTES));
                controller.enqueue(new Uint8Array(1));
            },
            cancel,
        });
        await expect(loadConfiguration(`${origin}/`, {
            timeoutMs: 5000,
            fetch: async () => new Response(stream, { headers: { 'Content-Length': '1' } }),
        })).rejects.toMatchObject({ code: 'too-large' });
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('reports fetch failures with the failing asset path', async () => {
        await expect(loadConfiguration(`${origin}/`, { timeoutMs: 5000, fetch: async () => { throw new Error('Offline'); } }))
            .rejects.toMatchObject({ code: 'network', file: release.files.combat.path });
    });

    it('honors cancellation before issuing a request', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchFile = vi.fn();
        await expect(loadConfiguration(`${origin}/`, { timeoutMs: 5000, signal: controller.signal, fetch: fetchFile }))
            .rejects.toMatchObject({ code: 'aborted' });
        expect(fetchFile).not.toHaveBeenCalled();
    });

    const pendingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });

    it('aborts a pending fetch at the host startup deadline and cleans up its timer', async () => {
        vi.useFakeTimers();
        const loading = loadConfiguration(`${origin}/`, { timeoutMs: 100, fetch: pendingFetch });
        const rejected = expect(loading).rejects.toMatchObject({ code: 'timeout' });
        await vi.advanceTimersByTimeAsync(100);
        await rejected;
        expect(vi.getTimerCount()).toBe(0);
    });

    it('propagates cancellation during loading and removes the caller listener', async () => {
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const loading = loadConfiguration(`${origin}/`, { timeoutMs: 5000, signal: controller.signal, fetch: pendingFetch });
        controller.abort();
        await expect(loading).rejects.toMatchObject({ code: 'aborted' });
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('uses the same schema and cross-file validation as the build', () => {
        const data = { combat: JSON.parse(source('combat')), simulation: { ...JSON.parse(source('simulation')), stepMs: 300 } };
        expect(() => validateConfiguration(data)).toThrow(/autoAttackIntervalMs.*stepMs/);
        data.simulation = { ...JSON.parse(source('simulation')), typo: true };
        expect(() => validateConfiguration(data)).toThrow(/simulation.json/);
    });
});
