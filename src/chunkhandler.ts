import { EventEmitter } from "node:stream";
export class ChunkHandler<T> {
    #pool: T[] = [];
    #chunkLength: number;
    #emitter: EventEmitter = new EventEmitter();
    constructor (chunkLength: number) {
        this.#chunkLength = chunkLength;
    }
    set chunkLength (val: number) {
        this.#chunkLength = val;
        this.checkChunks();
    }
    get chunkLength (): number { return this.#chunkLength }
    checkChunks () {
        if (this.#pool.length < this.#chunkLength) return;
        let maxi = this.#pool.length - (this.#pool.length % this.#chunkLength);
        for (let i = 0; i < maxi; i += this.#chunkLength) {
            let chunk = this.#pool.slice(i, i + this.#chunkLength);
            this.#emitter.emit("chunk", chunk);
        }
        this.#pool.splice(0, maxi);
    }
    addItems (items: T[]) {
        this.#pool.push(...items);
        this.checkChunks();
    }
    push(...items: T[]) {
        this.#pool.push(...items);
        this.checkChunks();
    }
    on (event: "chunk", handler: (chunk: T[]) => any) {
        this.#emitter.on(event, handler);
    }
    off (event: "chunk", handler: (chunk: T[]) => any) {
        this.#emitter.off(event, handler);
    }
    end () {
        this.checkChunks();
        this.#emitter.emit("chunk", this.#pool);
    }
    destroy () {
        this.#pool.length = 0;
        this.#emitter.listeners("chunk").forEach((l) => this.#emitter.off("chunk", l as any));
    }
}