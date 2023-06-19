import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export let isCacheData = (data: any): data is CacheData => typeof data?.created !== "number" && "value" in data;
export interface CacheData {
    created: number;
    data: any;
}
type PromiseResult<T> = T extends Promise<infer R> ? Promise<R> : T;

export class Cache {
    dir: string = "";
    contents: string[] = [];
    maxAge: number = 1000 * 60 * 60 * 24;
    /**
     * Set the maximum age (in milliseconds) allowed for cache entries.
     */
    setMaxAge (ms: number): Cache {
        this.maxAge = ms;
        return this;
    }
    clear (): Cache {
        for (let entry of this.contents) this.delItem(entry);
        this.refreshContents();
        return this;
    }
    /**
     * Refresh the list of files in the cache's directory.
     */
    refreshContents (): Cache {
        this.contents.length = 0;
        let files: string[];
        try { files = readdirSync(this.dir); }
        catch (e) { throw new Error(`Failed to read files from cache directory ${this.dir}.`); }
        for (let i = 0; i < files.length; i++) this.contents[i] = files[i];
        return this;
    }
    /**
     * Set the directory for the cache to save/load from.
     * @param directory The new path for the cache directory.
     */
    setDir (...directory: string[]): Cache {
        let path = resolve(...directory);
        if (!existsSync(path)) {
            let parent = resolve(path, "..");
            if (existsSync(parent)) mkdirSync(path, { recursive: false });
            else throw new Error(`Directory ${path} does not exist.`);
        }
        path = realpathSync(path);
        let stats = statSync(path);
        if (!stats.isDirectory()) throw new Error(`${path} is not a directory.`);
        this.dir = path;
        this.refreshContents();
        return this;
    }
    itemPath (name: string): string {
        return join(this.dir, name.endsWith(".json") ? name : name + ".json");
    }
    /**
     * Determine whether the item is included in the list of cache entries.
     * @param name Name of the cache item.
     * @param refresh Whether to refresh list of cache entries.
     * @returns `true` if item was found, otherwise `false`.
     */
    isCached (name: string, refresh?: boolean | null): boolean {
        if (refresh === true) this.refreshContents();
        return this.contents.includes(name);
    }
    /**
     * Reads an item from the cache's directory. Returns null if item does not exist.
     * @param name Name of cache entry.
     * @param refresh Whether to refresh list of cache entries.
     */
    readItem (name: string, refresh?: boolean | null): CacheData | null {
        let hasitem = this.isCached(name, refresh);
        if (hasitem) {
            let path = this.itemPath(name);
            let rawdata;
            try {
                rawdata = readFileSync(path).toString();
            } catch (e) {
                throw new Error(`Failed to read cache entry ${name}.\n${e}`);
            }
            let json;
            try {
                json = JSON.parse(rawdata);
                if (!isCacheData(json)) throw new Error("JSON is not CacheData.")
            } catch (e) {
                throw new Error(`Invalid cache entry at ${path}.`);
            };
            return json;
        }
        else return null;
    }
    /**
     * Writes an item to the cache's directory.
     * @param name Name of cache entry.
     * @param json JSON data to write as cache entry value.
     * @param pretty Whether to prettify written json.
     */
    writeItem (name: string, json: any, pretty?: boolean): Cache {
        let path = this.itemPath(name);
        let cachedata: CacheData = {
            created: Date.now(),
            data: json,
        }
        let data;
        try {
            data = pretty ? JSON.stringify(cachedata, null, "  ") : JSON.stringify(cachedata);
        } catch (e) {
            throw new Error(`Unable to stringify data to be written to cache entry ${name}.\nData: ${json}`);
        }
        try {
            writeFileSync(path, data);
        } catch (e) {
            throw new Error(`Failed to write data to "${path}".\n${e}`)
        }
        if (!this.isCached(name, false)) this.contents.push(name);
        return this;
    }
    delItem (name: string) {
        let i = this.contents.indexOf(name);
        if (i !== -1) this.contents.splice(i, 1);
        let path = this.itemPath(name);
        try { unlinkSync(path); }
        catch (e) { throw new Error(`Failed to delete file "${path}".\n${e}`); }
    }
    /**
     * Retrieves an item from the cache. Calls (if applicable), returns, and saves the `value` parameter if the specified item does not already exist.
     * @param name Name of cache entry.
     * @param value Value to write to cache if entry does not exist.
     * @returns Cache entry if it exists, otherwise result of `value`.
     */
    item<Value> (name: string, value: Value | (() => Value)): PromiseResult<Value> {
        let cachedata: null | CacheData = this.readItem(name);
        if (cachedata === null || cachedata.created + this.maxAge < Date.now()) {
            let result: any;
            if (value instanceof Function) result = value();
            else result = value;
            if (result instanceof Promise) {
                return result.then((data: typeof result) => {
                    this.writeItem(name, data);
                    return data;
                }) as PromiseResult<Value>;
            }
            else {
                console.log("WRITING", result)
                this.writeItem(name, result);
                return result as PromiseResult<Value>;
            }
        } else {
            return cachedata.data;
        }
    }
    constructor (...path: string[]) {
        this.setDir(...path);
    }
}