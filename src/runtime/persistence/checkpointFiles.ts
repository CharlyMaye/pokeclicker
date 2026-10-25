/** Read one bounded file as strict UTF-8. Selection alone never changes storage or combat. */
export function readCheckpointFile(file: File, maxBytes: number, signal: AbortSignal, makeReader: () => FileReader = () => new FileReader()): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxBytes) {
        return Promise.reject(new Error('Checkpoint file is empty or exceeds the configured byte limit'));
    }
    if (signal.aborted) {
        return Promise.reject(new Error('Checkpoint file reading was cancelled'));
    }
    return new Promise((resolve, reject) => {
        const reader = makeReader();
        let finished = false;
        const finish = (error: Error | null, text = '') => {
            if (finished) {
                return;
            }
            finished = true;
            reader.onload = null; reader.onerror = null; reader.onabort = null;
            signal.removeEventListener('abort', cancel);
            if (error) {
                reject(error);
            } else {
                resolve(text);
            }
        };
        const cancel = () => {
            finish(new Error('Checkpoint file reading was cancelled'));
            reader.abort();
        };
        reader.onload = () => {
            try {
                const bytes = reader.result;
                if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== file.size || bytes.byteLength > maxBytes) {
                    throw new Error('Checkpoint file size changed or exceeds the configured byte limit');
                }
                finish(null, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            } catch (error) {
                finish(error instanceof Error ? error : new Error('Invalid UTF-8 checkpoint file'));
            }
        };
        reader.onerror = () => finish(new Error('Checkpoint file could not be read'));
        reader.onabort = () => finish(new Error('Checkpoint file reading was cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) {
            cancel(); return;
        }
        try {
            reader.readAsArrayBuffer(file);
        } catch (error) {
            finish(error instanceof Error ? error : new Error('Checkpoint file could not be read'));
        }
    });
}

export interface ObjectUrlPort {
    createObjectURL(blob: Blob): string;
    revokeObjectURL(url: string): void;
}

/** Keep a prepared download alive until it is replaced or the owning page is disposed. */
export class CheckpointDownload {
    private url: string | null = null;
    private disposed = false;
    constructor(private readonly link: HTMLAnchorElement, private readonly urls: ObjectUrlPort, private readonly makeBlob: (text: string) => Blob = text => new Blob([text], { type: 'application/json;charset=utf-8' })) {
        link.hidden = true;
    }
    prepare(text: string, filename: string): void {
        if (this.disposed) {
            throw new Error('Checkpoint download is disposed');
        }
        const next = this.urls.createObjectURL(this.makeBlob(text));
        const previous = this.url;
        this.url = next;
        this.link.href = next; this.link.download = filename; this.link.hidden = false;
        if (previous) {
            this.urls.revokeObjectURL(previous);
        }
    }
    dispose(): void {
        if (!this.disposed) {
            this.disposed = true;
            if (this.url) {
                this.urls.revokeObjectURL(this.url);
            }
            this.url = null; this.link.hidden = true; this.link.removeAttribute('href'); this.link.removeAttribute('download');
        }
    }
}
