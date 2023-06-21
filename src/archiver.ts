import { EventEmitter } from "node:events";
import { sep as SEP, resolve, join, basename, extname } from "node:path";
import { API, Attachment, Channel, Guild, Message, snowflake } from "./api"
import { createWriteStream, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { mkdir, writeFile } from "node:fs/promises";
import {env as ENV} from "node:process";
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
    before?: snowflake;
    after?: snowflake;
    maxFileSize?: number;
    saveSources?: boolean;
    overwrite?: boolean;
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
interface MessageFile<T = Attachment | Message> { url: string | URL, filename: string, source: T, type: T extends Attachment ? 0 : 1, msg: Message };
interface MessageFile_Attachment { source: Attachment, type: 0 };
interface MessageContent { author: string, content: string, source: Message }

let quickCopy = <T>(src: T): any => {
    let dest: { [key: string | number]: any } = {};
    for (let key in src) dest[key] = src[key];
    return dest;
}
let mediatypes = ["jpg", "png", "jpeg", "webp", "gif", "mov", "mp4", "webm", "gifv", "mp3", "wav"];
let urlfilename = (url: URL | string): string => {
    if (url instanceof URL) url = url.pathname;
    return basename(url);
}
let isMediaAttachment = (attach: Attachment) => "width" in attach && "height" in attach;
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
let download = async (url: string | URL, dest: string, maxSize: number = Infinity): Promise<boolean> => {
    let success = false;
    for (let tries = 0; tries < 5; tries++) {
        try {
            let { response } = await getResponse(url);
            if (+(response.headers["content-length"] ?? Infinity) > maxSize) return false;
            let stream = createWriteStream(dest);
            response.pipe(stream);
            success = true;
            break;
        } catch (e) {
            success = false;
        }
    }
    return success;
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
    debug (...msg: any[]): void {
        if (!!ENV.debug) console.log(...msg);
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
        let lastMessage: string | undefined = options.before;
        let limit = 100;
        while (true) {
            let messages: Message[] = await this.api.getChannelMessages(channel, { limit: 100, before: lastMessage, after: options.after });
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
            files.push({ type: 1, source: msg, url: contenturl, filename: urlfilename(contenturl), msg });
        if (msg?.attachments?.length)
            for (let attach of msg.attachments) files.push({ type: 0, source: attach, url: attach.url, filename: attach.filename, msg });
        return files;
    }
    private static extractMessageContent (msg: Message): MessageContent {
        let { content } = msg;
        let author = msg?.author?.username ?? "unknown";
        return { content, author, source: msg };
    }
    async saveFileChunk (options: ArchiveChunkOptions, chunk: MessageFile[], type: "media" | "nonmedia"): Promise<boolean> {
        if (chunk.length === 0) return true;
        let dir = this.#destination;
        if (options.guild) dir = join(dir, options.guild);
        if (options.channel) dir = join(dir, options.channel);
        dir = join(dir, type);
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });
        let filedir = join(dir, "files")
        let entrydir = join(dir, "entries", Date.now().toString())
        if (!existsSync(filedir)) await mkdir(filedir);
        if (!existsSync(entrydir)) await mkdir(entrydir, { recursive: true });
        interface FileEntry { filename: string, filename_original: string, url: string, msgid: string };
        let entries: FileEntry[] = [];
        let entryfile = join(entrydir, chunk[0].msg.id + ".json");
        for (let file of chunk) {
            let name = file.filename;
            if (name.length > 50) {
                name = name.slice(0, 50) + extname(file.filename);
            }
            name = file.msg.id + "." + name;
            let writepath = join(dir, "files", name);
            if (options.overwrite || !existsSync(writepath)) {
                let success = download(file.url, writepath, options.maxFileSize);
                if (!success) {
                    console.warn(`Failed to download "${file.url}".`)
                    continue;
                }
                if (options.saveSources) await writeFile(writepath + ".source.json", Archiver.stringifyMessage(file.msg))
            }
            entries.push({
                filename: name,
                filename_original: file.filename,
                url: file.url.toString(),
                msgid: file.msg.id,
            });
        }
        await writeFile(entryfile, JSON.stringify({
            entries: entries,
            date: Date.now(),
            total: entries.length,
            spans: [entries[0].msgid, entries[entries.length - 1].msgid],
        }));
        return false;
    }
    async saveTextChunk (options: ArchiveChunkOptions, chunk: MessageContent[]) {
        let dir = this.#destination;
        if (options.guild) dir = join(dir, options.guild);
        if (options.channel) dir = join(dir, options.channel);
        dir = join(dir, "text");
        let name = join(dir, chunk[0].source.id + ".json");
        writeFile(name, JSON.stringify({
            entries: chunk.map(c => Archiver.stringifyMessage(c.source)),
            date: Date.now(),
            total: chunk.length,
            spans: [chunk[0].source.id, chunk[chunk.length - 1].source.id]
        }));
    }
    // TODO: make options actually do something :3
    async archiveChannel (channel: snowflake | Channel, options: ArchiveChannelOptions) {
        if (typeof channel !== "string") channel = channel.id;
        let chunklength = options.chunklength ?? 50;
        // Handle splitting content into chunks.
        let chunkers = { media: new ChunkHandler<MessageFile>(chunklength), nonmedia: new ChunkHandler<MessageFile>(chunklength), text: new ChunkHandler<MessageContent>(chunklength), }
        let chunklisteners = {
            media:  async (chunk: MessageFile[]) => await this.saveFileChunk(newoptions, chunk, "media"),
            nonmedia: async (chunk: MessageFile[]) => await this.saveFileChunk(newoptions, chunk, "nonmedia"),
            text: async (chunk: MessageContent[]) => await this.saveTextChunk(newoptions, chunk)
        }
        let newoptions = quickCopy(options);
        newoptions.channel = channel;
        chunkers.media.on("chunk",chunklisteners.media);
        chunkers.nonmedia.on("chunk",chunklisteners.nonmedia);
        chunkers.text.on("chunk",chunklisteners.text);
        // Iterate through all channel messages.
        const iterator = this.listChannelMessages(channel, options);
        while (true) {
            let { done, value: messages } = await iterator.next()
            if (done || (messages == undefined)) break;
            this.debug("looping through messages")
            for (let msg of messages) {
                if (options.media || options.nonmedia) {
                    let files = Archiver.extractMessageFiles(msg);
                    this.debug(`Found ${files.length} files.`)
                    for (let file of files) {
                        if (file.type === 0 && (file as MessageFile_Attachment).source.size > (options.maxFileSize ?? Infinity)) continue;
                        let ismedia: boolean = false;
                        if (file.type === 0) ismedia = isMediaAttachment((file as MessageFile_Attachment).source);
                        else ismedia = isMedia(file.filename);
                        if (ismedia && options.media) chunkers.media.push(file);
                        if (!ismedia && options.nonmedia) chunkers.nonmedia.push(file);
                    }
                }
                if (options.text) chunkers.text.push(Archiver.extractMessageContent(msg))
            }
            this.debug("ended loop")
        }
        chunkers.media.end();
        chunkers.nonmedia.end();
        chunkers.text.end();
        chunkers.media.off("chunk",chunklisteners.media);
        chunkers.nonmedia.off("chunk",chunklisteners.nonmedia);
        chunkers.text.off("chunk",chunklisteners.text);
        this.debug("finish!")
    }
}