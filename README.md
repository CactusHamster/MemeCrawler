# MemeCrawler
Media-focused library for archiving discord servers.

Supports archiving media, files, and text from both guilds (servers) and channels.

---
## Usage
Archived file data is stored in `<destination>/[guildid]/<channelid>/(media | nonmedia | text)/`.

There are two types of archived file data:
- Entry files
  - Located in `entries/{archivedate}`
  - Named for message ID of the first file described
  - Lists files' name in `files/`, along with their original names and urls
- Downloaded files
  - Located in `files/`
  - The archived data itself


Example usage:
```javascript
import { Archiver } from "./archiver";

let archive = new Archiver({
    token: process.env.TOKEN,
    destination: "./archived/"
});

archive.archiveChannel("1096129941717921892", {
    media: true, // images/videos
    nonmedia: false, // other files
    text: false, // message content
    chunklength: 100 // files per entryfile
});
```
---
## Development 
### Building
```bash
# Install dependencies.
npm install -D
# Compile typescript files.
npm run build
```
### Running
```bash
# Run compiled typescript files.
npm run start
```
---
## Known issues
- Archiver seems to freeze up after several hundred attachments (possibly due to following issue).
- Class `ChunkHandler`, used for splitting API data into limited-length chunks for entryfiles, extends `EventEmitter`.
- Poor interfacing with external code (e.g. no way to control archive process externally once started).
- Lack of documentation.
- Archiver checks all messages through the `GET messages` endpoint rather than using undocumented search API.
- Functionality is somewhat untested (most of it worked first try though?)
- Lack of documentation :c