import { URL } from "node:url";
import { resolve as resolveposix } from "node:path/posix";
import { RequestOptions, request } from "node:https";
import { IncomingMessage } from "node:http";

type primitive = number | string | null | undefined | boolean;
export type snowflake = string;
export interface Channel {
    id: snowflake;
    type: number;
    guild_id?: snowflake;
    name?: string;
    topic?: string;
    nsfw?: boolean;
}
export interface Attachment {
    id: snowflake;
    filename: string;
    description?: string;
    content_type?: string;
    size: number;
    url: string;
    proxy_url: string;
    height?: number;
    width?: number;
    ephemeral?: boolean;
    duration_secs?: number;
    waveform?: string;
}
export interface Embed {
    title?: string;
    description?: string;
    url?: string;
    timestamp?: string;
    color?: number;
    footer?: { text: string, icon_url?: string, proxy_icon_url?: string };
    image?: { url: string, proxy_url?: string, height?: number, width?: number };
    thumbnail?: { url: string, proxy_url?: string, height?: number, width?: number };
    video?: { url: string, proxy_url?: string, height?: number, width?: number };
    provider?: { name: string, url: string };
    author?: { name: string, url: string, icon_url?: string, proxy_icon_url?: string };
    fields?: { name: string, value: string, inline?: boolean }[];
}
export interface Reaction {
    count: number;
    me: boolean;
    emoji: Emoji;
}
export interface Message {
    id: snowflake;
    channel_id: snowflake;
    author?: User;
    timestamp: string;
    webhook_id?: snowflake;
    attachments: Attachment[];
    embeds: Embed[];
    reactions?: Reaction[];
    tts: boolean;
    pinned: boolean;
    type: number;
    referenced_message?: Message;
    flags?: number;
    thread?: Channel;
    stickers?: Sticker[];
    mentions: User[];
}
export interface Emoji {
    id: snowflake;
    name?: string;
    animated?: boolean;
    managed?: boolean;
    require_colons?: boolean;
    available?: boolean;
}
export interface User {
    id: snowflake;
    username: string;
    discriminator: string;
    global_name?: string;
    avatar?: string;
    bot?: boolean;
    system?: boolean;
    mfa_enabled?: boolean;
    banner?: string;
    accent_color?: number;
    locale?: string;
    verified?: boolean;
    email?: string;
    flags?: number;
    premium_type?: number;
    public_flags?: number;
}
export interface Sticker {
    id: snowflake;
    pack_id?: snowflake;
    name: string;
    description?: string;
    type: number;
    format_type?: number;
    available?: boolean;
    guild_id?: snowflake;
    user?: User;
    sort_value?: number;
}
export interface Guild {
    id: snowflake;
    name: string;
    icon?: string;
    owner_id: snowflake;
    emojis: Emoji[];
    description?: string;
    banner?: string;
    nsfw_level: number;
    stickers: Sticker[];
    owner?: boolean;
}
export interface PartialGuild {
    id: string;
    name: string;
    icon?: string;
    owner: boolean;
}
export interface APIFetchResult {
    response: IncomingMessage;
    data: Buffer;
}
export interface GetChannelMessagesOptions {
    around?: snowflake;
    before?: snowflake
    after?: snowflake;
    limit: number;
}
// https://discord.com/api/v9/channels/1092006921533399142/messages/search?author_id=762771482434600992&mentions=676750057340403742&mentions=762771482434600992
// https://discord.com/api/v9/channels/1092006921533399142/messages/search?max_id=1115897934643200000&min_id=1114448383180800000
export type ChannelSearchHasOption = "link" | "embed" | "file" | "video" | "image" | "sound" | "sticker";
export interface ChannelSearchOptions {
    from?: snowflake;
    mentions?: snowflake | snowflake[];
    has?: ChannelSearchHasOption | ChannelSearchHasOption[];
    before?: snowflake;
    after?: snowflake;
    content?: string;
}
export interface ChannelSearchResult {
    total_results: number;
    messages: Message[];
    analytics_id: string;
}
interface EndpointRequest {
    url: string | URL;
    options?: RequestOptions & { body?: any };
    resolve: Function,
    reject: (reason?: any) => void
}
export class DiscordError {
    code: number;
    message: string;
    errors: { [key: string]: any };
    constructor (response: any) {
        if (response instanceof Buffer) response = response.toString();
        if (typeof response === "string") response = JSON.parse(response);
        this.code = +(response.code ?? 50035);
        this.message = response.toString();
        this.errors = response.errors;
    }
    toString () {
        return this.message;
    }
}
let delay = (ms = 0): Promise<ReturnType<typeof setTimeout>> => new Promise(res => { let t: ReturnType<typeof setTimeout> = setTimeout(() => res(t), ms); })
export class API {
    #token: string;
    #bucket: EndpointRequest[] = [];
    #emptyingBucket: boolean = false;
    apiVersion: number;
    constructor (token: string, apiVersion = 10) {
        this.#token = token;
        this.apiVersion = apiVersion;
    }
    /**
     * Begin the process of emptying stored requests. Helps enforce ratelimits.
     */
    async #emptyBucket (): Promise<boolean> {
        if (this.#emptyingBucket) return false;
        this.#emptyingBucket = true;
        while (this.#bucket.length > 0) {
            let item = this.#bucket.shift();
            if (item !== undefined) {
                let { url, options, resolve, reject } = item;
                let response = await this.fetch(url, options);
                resolve(response);
            }
            await delay(1000);
            if (this.#bucket.length === 0) break;
        }
        this.#emptyingBucket = false;
        return true;
    }
    #addToBucket (url: string | URL, options?: RequestOptions & { body?: any }): Promise<APIFetchResult> {
        return new Promise((res, rej) => {
            this.#bucket.push({
                resolve: res,
                reject: rej,
                url,
                options
            })
            this.#emptyBucket()
        })
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
    async endpoint (path: string | string[], options?: RequestOptions & { body?: any, query?: string | { [key: string]: primitive | primitive[] } }): Promise<(Buffer | string | any)> {
        let urlpath: string = resolveposix( "/", "api", `v${this.apiVersion}`, ...path );
        let url: string = "https://" + "discord.com" + urlpath;
        if (!options) options = {};
        if (options.query !== undefined) {
            let querystring: string;
            if (typeof options.query === "string") querystring = options.query
            else {
                let s = [];
                for (let key in options.query) {
                    let value = options.query[key];
                    if (value === undefined || value === null) continue;
                    if (Array.isArray(value)) {
                        for (let subval of value) {
                            if (subval === undefined || subval === null) continue;
                            s.push(key + "=" + subval.toString());
                        }
                    }
                    else s.push(key + "=" + value.toString());
                }
                querystring = "?" + s.join("&");
            }
            url = url + querystring;
            delete options.query;
        }
        if (!options.headers) options.headers = {};
        let hasheader = (h: string) => Object.keys(options?.headers ?? {}).map(key => key.toLowerCase()).includes(h.toLowerCase())
        if (!hasheader("authorization")) options.headers["Authorization"] = this.#token;
        if (options.body && !hasheader("content-type")) options.headers["Content-Type"] = "application/json";
        let { response, data }: APIFetchResult = await this.#addToBucket(url, options);
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
    static isChannelSearchResult (result: any): result is ChannelSearchResult {
        if (typeof result.total_results !== "number") return false;
        if (!Array.isArray(result.messages)) return false;
        if (result.messages.length > 0 && !API.isMessage(result.messages[0])) return false;
        if (typeof result.analytics_id !== "string") return false;
        return true;
    }
    static isMessage (msg: any): msg is Message {
        if (typeof msg.id !== "string") return false;
        if (typeof msg.channel_id !== "string") return false;
        if (typeof msg.pinned !== "boolean") return false;
        if (!Array.isArray(msg.attachments)) return false;
        return true;
    }
    static isEmbed (embed: any): embed is Embed {
        // haha it works :3
        return Object.keys(embed).length > 0;
    }
    static isAttachment (attach: any): attach is Attachment {
        if (typeof attach.id !== "string") return false;
        if (typeof attach.filename !== "string") return false;
        if (typeof attach.size !== "number") return false;
        if (typeof attach.url !== "string") return false;
        if (typeof attach.proxy_url !== "string") return false;
        return true;
    }
    static isReaction (reaction: any): reaction is Reaction {
       if (typeof reaction.count !== "number") return false;
       if (typeof reaction.me !== "boolean") return false;
       if (!API.isEmoji(reaction.emoji)) return false;
       return true;
    }
    static isChannel (channel: any): channel is Channel {
        if (!channel) return false;
        if (typeof channel.id !== "string") return false;
        if (typeof channel.type !== "number") return false;
        return true;
    }
    static isUser (user: any): user is User {
        if (typeof user.id !== "string") return false;
        if (typeof user.username !== "string") return false;
        return true;
    }
    static isEmoji (emoji: any): emoji is Emoji { return typeof emoji.id === "string"; }
    static isSticker (sticker: any): sticker is Sticker {
        if (typeof sticker.id !== "string") return false;
        if (typeof sticker.name !== "string") return false;
        if (typeof sticker.type !== "number") return false;
        return true;
    }
    static isGuild (guild: any): guild is Guild {
        if (typeof guild.id !== "string") return false;
        if (typeof guild.name !== "string") return false;
        if (typeof guild.owner_id !== "string") return false;
        if (!("emojis" in guild)) return false;
        if (guild.emojis.length && !API.isEmoji(guild.emojis[0])) return false;
        if (typeof guild.nsfw_level !== "number") return false;
        if (!("stickers" in guild)) return false;
        if (guild.stickers.length && !API.isSticker(guild.stickers[0])) return false;
        return true;
    }
    async me (): Promise<User> {
        let result = await this.endpoint(["users", "@me"]);
        if (API.isUser(result)) return result;
        else throw new Error(new DiscordError(result).toString());
    }
    async channel (id: string): Promise<Channel> {
        let result = await this.endpoint(["channels", id]);
        if (API.isChannel(result)) return result;
        else throw new Error(new DiscordError(result).toString());
    }
    async guild (id: string): Promise<Guild> {
        let result = await this.endpoint(["guilds", id]);
        if (API.isGuild(result)) return result;
        else throw new Error(new DiscordError(result).toString());
    }
    async myGuilds (): Promise<Guild[]> {
        let result = await this.endpoint(["users", "@me", "guilds"]);
        if (Array.isArray(result) && (result.length === 0 || API.isGuild(result[0]))) return result;
        else throw new Error(new DiscordError(result).toString());
    }
    async guildChannels (id: string): Promise<Channel[]> {
        let result = await this.endpoint(["guilds", id, "channels"]);
        if (Array.isArray(result) && (result.length === 0 || API.isChannel(result[0]))) return result;
        else throw new Error(new DiscordError(result).toString());
    }
    async getChannelMessages(channel: string | Channel, options: GetChannelMessagesOptions): Promise<Message[]> {
        if (typeof channel !== "string") channel = channel.id;
        if (!options) options = { limit: 50 };
        let result = await this.endpoint(["channels", channel, "messages"], {
            query: {
                around: options.around,
                before: options.before,
                after: options.after,
                limit: options.limit
            }
        })
        if (Array.isArray(result) && (result.length === 0 || API.isMessage(result[0]))) return result;
        else throw new Error(new DiscordError(result).toString());
    }
    async searchChannelMessages (channel: string | Channel, search: ChannelSearchOptions): Promise<ChannelSearchResult> {
        if (typeof channel !== "string") channel = channel.id;
        if (Object.keys(search).length === 0) throw new Error("Empty search query.")
        let result = await this.endpoint(["channels", channel, "messages", "search"], {
            query: {
                from: search.from,
                mentions: search.mentions,
                has: search.has,
                before: search.before,
                after: search.after,
                content: search.content
            }
        })
        if (API.isChannelSearchResult(result)) return result;
        else throw new Error(new DiscordError(result).toString());
    }
}