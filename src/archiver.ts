import { EventEmitter } from "node:events";
import { sep as SEP, resolve, join, parse, basename, extname } from "node:path";
import { API, Attachment, Channel, Guild, Message, snowflake } from "./api"
import { createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { mkdir, writeFile } from "node:fs/promises";

/*
Save files in a structure of root -> guildname -> channelname -> chunkid 
*/

export interface APIOptions {
    token: string;
    destination: string | string[];
}
export interface ArchiveOptions {
    media: boolean;
    nonmedia: boolean;
    text: boolean;
//     chunksize?: number;
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
    // TODO: make options actually do something :3
    async archiveChannel (channel: snowflake | Channel, options: ArchiveChannelOptions) {
        if (typeof channel === "string") channel = await this.api.channel(channel);
        let lastMessage: string | undefined;
        let limit = 100;
        let newoptions = quickCopy(options);
        newoptions.channel = channel.id;
        while (true) {
            let messages: Message[] = await this.api.getChannelMessages(channel, { limit: 100, before: lastMessage });
            await this.archiveMessageChunk(messages, newoptions);
            lastMessage = messages[messages.length - 1].id;
            // If there are no more messages.
            if (messages.length < limit) break;
        }
    }
    // kinda lame but it works :P
    static stringifyMessage (msg: Message): string {
        return JSON.stringify(msg);
    }
    static stringifyAttachment (attach: Attachment): string {
        return JSON.stringify(attach);
    }
    async archiveMessageChunk (messages: Message[], options: ArchiveChunkOptions) {
        // most recent message is index 0, latest is index last
        let dir = this.#destination;
        if (options.guild) dir = join(dir, options.guild);
        if (options.channel) dir = join(dir, options.channel);
        let foldername = messages[0].id;
        dir = join(dir, foldername);
        dir = resolve(dir);
        mkdirSync(dir, { recursive: true });
        // subfolders = ["text", "media", "nonmedia"];
        if (options.media && !existsSync(join(dir, "media"))) await mkdir(join(dir, "media"));
        if (options.nonmedia && !existsSync(join(dir, "nonmedia"))) await mkdir(join(dir, "nonmedia"));
        if (options.text && !existsSync(join(dir, "text"))) await mkdir(join(dir, "text"));
        interface File { url: string | URL, filename: string, source: Attachment | Message, type: 0 | 1 };
        interface AttachFile extends File { source: Attachment, type: 0 };
        interface MSGFile extends File { source: Message, type: 1 };
        interface MSG { content: string, source: Message };
        let text: MSG[] = [];
        let files: (MSGFile | AttachFile)[] = [];
        for (let msg of messages) {
            if (msg.content.length > 0) {
                if (options.text) text.push({
                    content: msg.content,
                    source: msg
                })
                if (options.media || options.nonmedia) {
                    let contentURL: null | URL = null;
                    try { contentURL = new URL(msg.content); }
                    catch (e) {}
                    if (contentURL !== null) {
                        let file: MSGFile = { url: contentURL, filename: urlfilename(contentURL), source: msg, type: 1 };
                        files.push(file);
                    }
                }
            }
            if ((options.media || options.nonmedia) && msg.attachments.length > 0) {
                for (let attach of msg.attachments) {
                    let file: AttachFile = {
                        url: attach.url,
                        filename: attach.filename,
                        source: attach,
                        type: 0
                    }
                    files.push(file)
                }
            }
        }
        if (options.text) {
            let txtfile = join(dir, "text", messages[0]?.id ?? "unknown");
            writeFile(txtfile, JSON.stringify(text));
            writeFile(txtfile + ".source", JSON.stringify(text.map(t => Archiver.stringifyMessage(t.source))))
        }
        if (options.media || options.nonmedia) {
            let tryLimit = 3;
            for (let i = 0; i < files.length; i++) {
                let file = files[i];
                if (file.type === 0 && file.source.size > (options.maxFileSize ?? Infinity)) continue;
                let ismedia = isMedia(file.filename);
                if (ismedia && !options.media) continue;
                if (!ismedia && !options.nonmedia) continue;
                let subdir = join(dir, ismedia ? "media" : "nonmedia");
                let filepath = join(subdir, file.filename);
                if (existsSync(filepath)) continue;
                let tries = 0;
                // Attempt to download the file.
                while (tries < tryLimit) {
                    try {
                        let { response, request } = await getResponse(file.url);
                        if (+(response.headers["content-length"] ?? 0) > (options.maxFileSize ?? Infinity)) continue;
                        const stream = createWriteStream(filepath)
                        response.pipe(stream);
                        break;
                    }
                    catch (e) {
                        tries += 1;
                        if (tries === tryLimit) console.warn(`Failed to download ${file.url}.`, "\n", e);
                    }
                }
                let sourceFileName = file.filename + ".source"
                let sourceText = file.type === 0 ? Archiver.stringifyAttachment(file.source) : Archiver.stringifyMessage(file.source);
                await writeFile(join(subdir, sourceFileName), sourceText);
            }
        }
    }
}