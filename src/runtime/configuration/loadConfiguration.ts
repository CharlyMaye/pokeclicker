import { ConfigurationValidationError, MAX_CONFIG_BYTES, validateConfiguration } from '../../contracts/configuration';
import type { Configuration } from '../../contracts/configuration-types';
import release from './generated/release.json';

// setTimeout uses a signed 32-bit delay; this is an API limit, not a product setting.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type ConfigurationLoadErrorCode = 'invalid-options' | 'network' | 'http' | 'too-large'
    | 'integrity' | 'invalid-json' | 'invalid-config' | 'aborted' | 'timeout';

export class ConfigurationLoadError extends Error {
    constructor(
        public readonly code: ConfigurationLoadErrorCode,
        public readonly file: string,
        message: string
    ) {
        super(`${file}: ${message}`);
        this.name = 'ConfigurationLoadError';
    }
}

export interface ConfigurationLoadOptions {
    // The host supplies its startup budget; the loader has no hidden timeout policy.
    readonly timeoutMs: number;
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
}

async function readFile(
    base: URL,
    file: { path: string; sha256: string },
    fetchFile: typeof fetch,
    signal: AbortSignal
): Promise<unknown> {
    const response = await fetchFile(new URL(file.path, base).href, { signal, redirect: 'error' });
    if (!response.ok) {
        await response.body?.cancel();
        throw new ConfigurationLoadError('http', file.path, `HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
        throw new ConfigurationLoadError('invalid-json', file.path, 'Response body is missing');
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        // Count actual streamed bytes; Content-Length is not a trustworthy bound.
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            length += value.byteLength;
            if (length > MAX_CONFIG_BYTES) {
                await reader.cancel();
                throw new ConfigurationLoadError('too-large', file.path, `Exceeds ${MAX_CONFIG_BYTES} bytes`);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== file.sha256) {
        throw new ConfigurationLoadError('integrity', file.path, 'Content does not match this code version');
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw new ConfigurationLoadError('invalid-json', file.path, 'Expected valid UTF-8 JSON');
    }
}

/** Load a complete configuration set before constructing the simulation. */
export async function loadConfigurationDocuments<T>(
    baseUrl: string,
    files: Readonly<Record<string, { path: string; sha256: string }>>,
    options: ConfigurationLoadOptions,
    validate: (documents: Record<string, unknown>) => T
): Promise<T> {
    let base: URL;
    try {
        base = new URL(baseUrl);
        if (!['https:', 'http:'].includes(base.protocol) || !base.pathname.endsWith('/')
            || base.search || base.hash || base.username || base.password
            || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMEOUT_MS) {
            throw new Error();
        }
    } catch {
        throw new ConfigurationLoadError('invalid-options', 'configuration', 'Expected an absolute HTTP(S) base URL ending in / and a valid timeoutMs');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
        controller.abort();
    }
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs);
    let file = 'configuration';
    try {
        const fetchFile = options.fetch ?? globalThis.fetch;
        if (controller.signal.aborted) {
            throw new Error('Aborted');
        }
        const documents: Record<string, unknown> = {};
        for (const [name, descriptor] of Object.entries(files)) {
            const url = new URL(descriptor.path, base);
            if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash
                || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
                throw new ConfigurationLoadError('invalid-options', name, 'Invalid release document location or digest');
            }
            file = descriptor.path;
            documents[name] = await readFile(base, descriptor, fetchFile, controller.signal);
        }
        if (controller.signal.aborted) {
            throw new Error('Aborted');
        }
        return validate(documents);
    } catch (error) {
        if (controller.signal.aborted) {
            throw new ConfigurationLoadError(timedOut ? 'timeout' : 'aborted', file, timedOut ? 'Startup budget exceeded' : 'Loading cancelled');
        }
        if (error instanceof ConfigurationLoadError) {
            throw error;
        }
        if (error instanceof ConfigurationValidationError) {
            throw new ConfigurationLoadError('invalid-config', error.file, error.message);
        }
        throw new ConfigurationLoadError('network', file, error instanceof Error ? error.message : 'Unable to load configuration');
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        controller.abort();
    }
}

export function loadConfiguration(baseUrl: string, options: ConfigurationLoadOptions): Promise<Configuration> {
    return loadConfigurationDocuments(baseUrl, { combat: release.files.combat, simulation: release.files.simulation }, options,
        data => validateConfiguration({ combat: data.combat, simulation: data.simulation }));
}
