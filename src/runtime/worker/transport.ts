/** Ordered, asynchronous structured-clone channel owned by one combat session. */
export interface CombatTransport {
    send(value: unknown): void;
    listen(receive: (value: unknown) => void, fail: (error: Error) => void): () => void;
    close(): void;
}
