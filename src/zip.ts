/**
 * Writes a folder as a ZIP archive without compression, so a project folder kept in the browser can be saved as one
 * file. Entries use UTF-8 names. The archive holds at most 65535 entries and 4 GiB, which a project folder stays under.
 */

type IterableDirectory = FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>};

const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes: Uint8Array) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(time: number) {
    const date = new Date(Math.max(time, Date.UTC(1980, 0, 1)));
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
}

type Entry = {name: string; data: Uint8Array; modified: number; directory: boolean};

async function collect(directory: FileSystemDirectoryHandle, prefix: string, exclude: (path: string) => boolean, out: Entry[]) {
    const children: FileSystemHandle[] = [];
    for await (const child of (directory as IterableDirectory).values()) children.push(child);
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (prefix && !children.length) out.push({name: prefix, data: new Uint8Array(), modified: Date.now(), directory: true});
    for (const child of children) {
        const path = prefix + child.name;
        if (exclude(path)) continue;
        if (child.kind === 'directory') {
            await collect(child as FileSystemDirectoryHandle, `${path}/`, exclude, out);
        } else {
            const file = await (child as FileSystemFileHandle).getFile();
            out.push({name: path, data: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified, directory: false});
        }
    }
}

/** The files under `directory` as a ZIP. `exclude` receives paths relative to `directory`, such as `.git`. */
export async function zipDirectory(directory: FileSystemDirectoryHandle, {exclude = () => false}: {
    exclude?: (path: string) => boolean;
} = {}) {
    const entries: Entry[] = [];
    await collect(directory, '', exclude, entries);
    if (entries.length > 0xffff) throw new RangeError('Too many files for a ZIP archive');
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const crc = crc32(entry.data);
        const {time, date} = dosTime(entry.modified);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true); // UTF-8 names
        local.setUint16(8, 0, true); // stored
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, entry.data.length, true);
        local.setUint32(22, entry.data.length, true);
        local.setUint16(26, name.length, true);
        const header = new DataView(new ArrayBuffer(46));
        header.setUint32(0, 0x02014b50, true);
        header.setUint16(4, 20, true);
        header.setUint16(6, 20, true);
        header.setUint16(8, 0x0800, true);
        header.setUint16(12, time, true);
        header.setUint16(14, date, true);
        header.setUint32(16, crc, true);
        header.setUint32(20, entry.data.length, true);
        header.setUint32(24, entry.data.length, true);
        header.setUint16(28, name.length, true);
        header.setUint32(38, entry.directory ? 0x10 : 0, true);
        header.setUint32(42, offset, true);
        parts.push(new Uint8Array(local.buffer), name, entry.data);
        central.push(new Uint8Array(header.buffer), name);
        offset += 30 + name.length + entry.data.length;
        if (offset > 0xffffffff) throw new RangeError('The folder is too large for a ZIP archive');
    }
    const size = central.reduce((total, part) => total + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], {type: 'application/zip'});
}
