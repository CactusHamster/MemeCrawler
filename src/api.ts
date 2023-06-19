import { URL } from "node:url";
import { resolve as resolveposix } from "node:path/posix";
import { RequestOptions, request } from "node:https";
import { IncomingMessage } from "node:http";

export interface SimpleChannel {

}
export interface SimpleGuild {

}
export interface APIFetchResult {
    response: IncomingMessage;
    data: Buffer;
}
export class API {
    #token: string;
    apiVersion: number;
    constructor (token: string, apiVersion = 10) {
        this.#token = token;
        this.apiVersion = apiVersion;
    }
    /**
     * Fetches a url.
     * @param url URL to fetch.
     * @param options HTTPS options to pass. Can include request body.
     * @returns Promise resolving to an object the with server response and the response's body data.
     */
    fetch (url: string | URL, options?: RequestOptions & { body?: any }): Promise<APIFetchResult> {
        return new Promise((resolve, reject) => {
            if (options === undefined) options = {};
            let body: any;
            if ("body" in options) {
                body = options.body;
                delete options.body;
            }
            let req = request(url, options, (res: IncomingMessage) => {
                let data: Buffer[] = [];
                res.on("data", (d) => data.push(d));
                res.on("end", () => resolve({ response: res, data: Buffer.concat(data) }));
                res.on("error", (e) => reject(e));
            });
            if (body) req.write(body, () => req.end());
            else req.end();
        })
    }
    /**
     * Makes a request to Discord API. Prefills Authorization and Content-Type header for you.
     * @param path API path.
     * @param options HTTPS request options. Can include request body.
     */
    async endpoint (path: string | string[], options?: RequestOptions & { body?: any }): Promise<(Buffer | string | any)> {
        let urlpath: string = resolveposix( "/", "api", `v${this.apiVersion}`, ...path );
        let url: string = "https://" + "discord.com" + urlpath;
        if (!options) options = {};
        if (!options.headers) options.headers = {};
        let hasheader = (h: string) => Object.keys(options?.headers ?? {}).map(key => key.toLowerCase()).includes(h.toLowerCase())
        if (!hasheader("authorization")) options.headers["Authorization"] = this.#token;
        if (options.body && !hasheader("content-type")) options.headers["Content-Type"] = "application/json";
        let { response, data }: APIFetchResult = await this.fetch(url, options);
        let type = response.headers["content-type"];
        switch (type) {
            default:
                return data;
                break;
            case "text/plain":
                return data.toString("utf-8");
                break;
            case "application/json":
                return JSON.parse(data.toString("utf-8"));
                break;
        }
    }
    // TODO: type all these
    channel (id: string) {
        return this.endpoint(["channels", id]);
    }
    guild (id: string) {
        return this.endpoint(["guilds", id]);
    }
    guildChannels (id: string) {
        return this.endpoint(["guilds", id, "channels"]);
    }
    
}