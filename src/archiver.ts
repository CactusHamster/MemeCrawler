import { EventEmitter } from "node:events";
import { sep as SEP, resolve, join, parse, basename, extname } from "node:path";
import { API, Attachment, Channel, Guild, Message, snowflake } from "./api"
import { createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { mkdir, writeFile } from "node:fs/promises";
import { ChunkHandler } from "./chunkhandler";

/*
Save files in a structure of root -> guildname -> channelname -> chunkid -> ( entry-id.json | (files -> id.json) )
*/

export interface APIOptions {
    token: string;
    destination: string | string[];
}
export interface ArchiveOptions {
    media: boolean;
    nonmedia: boolean;
    text: boolean;
    chunklength?: number;
    before?: number;
    after?: number;
    maxFileSize?: number;
}
export interface ArchiveGuildOptions extends ArchiveOptions {
    channelBlacklist?: snowflake[];
    channelWhitelist?: snowflake[];
}
export interface ArchiveChannelOptions extends ArchiveOptions {
    guild?: snowflake
}
export interface ArchiveChunkOptions extends ArchiveOptions {
    guild?: snowflake
    channel: snowflake
}
interface MessageFile<T = Attachment | Message> { url: string | URL, filename: string, source: T, type: T extends Attachment ? 0 : 1 };
interface MessageContent { author: string, content: string, source: Message }

let quickCopy = <T>(src: T): any => {
    let dest: { [key: string | number]: any } = {};
    for (let key in src) dest[key] = src[key];
    return dest;
}
let mediatypes = ["jpg", "png", "jpeg", "webp", "gif"];
let urlfilename = (url: URL | string): string => {
    if (url instanceof URL) url = url.pathname;
    return basename(url);
}
let isMedia = (filename: URL | string): boolean => {
    if (filename instanceof URL) filename = filename.pathname;
    let ext = extname(filename).slice(1).toLowerCase();
    return mediatypes.includes(ext);
}
let getResponse = (url: string | URL): Promise<{ response: IncomingMessage, request: ClientRequest }> => {
    return new Promise((resolve, reject) => {
        let req = request(url, (response) => {
            if ((response?.statusCode ?? 200) >= 400) reject(`Received status ${response.statusCode}. Message: "${response.statusMessage}"`);
            response.on("error", reject);
            resolve({ response, request: req });
        })
        req.on("error", reject);
        req.end();
    });
}
export class Archiver extends EventEmitter {
    api: API;
    #destination: string = ".";
    constructor ({ token, destination }: APIOptions) {
        super();
        this.api = new API(token);
        if (Array.isArray(destination)) this.setDestination(...destination);
        else this.setDestination(destination);
    }
    setDestination (...directory: string[]) {
        let path = resolve(...directory);
        if (!existsSync(path)) {
            let parent = resolve(path, "..");
            if (existsSync(parent)) mkdirSync(path, { recursive: false });
            else throw new Error(`Directory ${path} does not exist.`);
        }
        path = realpathSync(path);
        let stats = statSync(path);
        if (!stats.isDirectory()) throw new Error(`${path} is not a directory.`);
        this.#destination = path;
    }
    async archiveAll (options: ArchiveOptions) {
        const guilds = await this.api.myGuilds();
        guilds.forEach(g => this.archiveGuild(g, options));
    }
    async archiveGuild (guild: snowflake | Guild, options: ArchiveGuildOptions) {
        if (typeof guild !== "string") guild = guild.id;
        let channels = await this.api.guildChannels(guild);
        if (options.channelWhitelist && options.channelWhitelist.length > 0) channels = channels.filter(c => options.channelWhitelist?.includes(c.id));
        if (options.channelBlacklist && options.channelBlacklist.length > 0) channels = channels.filter(c => !options.channelBlacklist?.includes(c.id));
        let newoptions = quickCopy(options);
        newoptions.guild = guild;
        for (let channel of channels) this.archiveChannel(channel, newoptions);
    }
    async *listChannelMessages (channel: snowflake, options: ArchiveChannelOptions): AsyncGenerator<Message[], void, unknown> {
        let lastMessage: string | undefined;
        let limit = 100;
        while (true) {
            let messages: Message[] = await this.api.getChannelMessages(channel, { limit: 100, before: lastMessage });
            yield messages;
            lastMessage = messages[messages.length - 1].id;
            // If there are no more messages.
            if (messages.length < limit) break;
        }
    }
    // kinda lame but it works :P
    static stringifyMessage (msg: Message): string { return JSON.stringify(msg); }
    static stringifyAttachment (attach: Attachment): string { return JSON.stringify(attach); }
    private static extractMessageFiles (msg: Message): MessageFile[] {
        let files: MessageFile[] = [];
        let contenturl: null | URL;
        try { contenturl = new URL(msg.content); }
        catch (e) { contenturl = null }
        if (contenturl !== null && (contenturl.protocol === "http://" || contenturl.protocol === "https://")) 
            files.push({ type: 1, source: msg, url: contenturl, filename: urlfilename(contenturl) });
        if (msg?.attachments?.length)
            for (let attach of msg.attachments) files.push({ type: 0, source: attach, url: attach.url, filename: attach.filename });
        return files;
    }
    private static extractMessageContent (msg: Message): MessageContent {
        let { content } = msg;
        let author = msg?.author?.username ?? "unknown";
        return { content, author, source: msg };
    }
    async saveFileChunk (options: ArchiveChunkOptions, chunk: MessageFile[], type: "media" | "nonmedia") {
        let dir = this.#destination;
        if (options.guild) dir = join(dir, options.guild);
        if (options.channel) dir = join(dir, options.channel);
        dir = join(dir, type);

    }
    async saveTextChunk (options: ArchiveChunkOptions, chunk: MessageContent[]) {
        let dir = this.#destination;
        if (options.guild) dir = join(dir, options.guild);
        if (options.channel) dir = join(dir, options.channel);
        dir = join(dir, "text");

    }
    // TODO: make options actually do something :3
    async archiveChannel (channel: snowflake | Channel, options: ArchiveChannelOptions) {
        if (typeof channel !== "string") channel = channel.id;
        let chunklength = options.chunklength ?? 50;
        // Handle splitting content into chunks.
        let chunkers = { media: new ChunkHandler<MessageFile>(chunklength), nonmedia: new ChunkHandler<MessageFile>(chunklength), text: new ChunkHandler<MessageContent>(chunklength), }
        let newoptions = quickCopy(options);
        newoptions.channel = channel;
        chunkers.media.on("chunk", (chunk) => this.saveFileChunk(newoptions, chunk, "media"));
        chunkers.nonmedia.on("chunk", (chunk) => this.saveFileChunk(newoptions, chunk, "nonmedia"));
        chunkers.text.on("chunk", (chunk) => this.saveTextChunk(newoptions, chunk));
        // Iterate through all channel messages.
        const iterator = this.listChannelMessages(channel, options);
        while (true) {
            let { done, value: messages } = await iterator.next()
            if (done || messages == undefined) break;
            for (let msg of messages) {
                if (options.media || options.nonmedia) {
                    let files = Archiver.extractMessageFiles(msg);
                    for (let file of files) {
                        
                        let ismedia = isMedia(file.filename);
                        if (ismedia && options.media) chunkers.media.push(file);
                        if (!ismedia && options.nonmedia) chunkers.nonmedia.push(file);
                    }
                }
                if (options.text) chunkers.text.push(Archiver.extractMessageContent(msg))
            }
        }
    }
}