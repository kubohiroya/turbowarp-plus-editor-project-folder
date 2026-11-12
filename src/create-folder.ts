import {extensionsFile, fileVersion, FolderError, manifestFile, projectFile, readFolder, sameBytes, unsupported} from './source.js';
import type {Storage} from './source.js';

const manifests = new Set<string>([projectFile, manifestFile, extensionsFile]);
const sourcePath = /^(?:assets\/[a-f0-9]{32}\.[A-Za-z0-9]+|extensions\/[A-Za-z0-9._-]+\.(?:js|manifest\.json))$/u;

type IterableDirectory = FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>};

function missing(error: unknown) {
    return error instanceof DOMException && error.name === 'NotFoundError';
}

async function assertEmpty(directory: FileSystemDirectoryHandle) {
    for await (const _entry of (directory as IterableDirectory).values()) {
        throw new FolderError('conflict', 'Choose an empty project folder');
    }
}

/** Create and validate a project-folder snapshot in a directory chosen by the user. */
export async function createProjectFolder({directory, files, storage, current = () => true}: {
    directory: FileSystemDirectoryHandle;
    files: ReadonlyMap<string, Uint8Array>;
    storage: Storage;
    current?: () => boolean;
}) {
    for (const filename of manifests) {
        if (!files.has(filename)) return unsupported(`Missing ${filename}`);
    }
    for (const [filename, bytes] of files) {
        if ((!manifests.has(filename) && !sourcePath.test(filename)) || !(bytes instanceof Uint8Array)) {
            return unsupported(`Invalid project folder entry: ${filename}`);
        }
    }
    const assertCurrent = () => {
        if (!current()) throw new FolderError('conflict', 'The project changed before the folder was saved');
    };
    await assertEmpty(directory);
    const directories = new Map<string, FileSystemDirectoryHandle>();
    const undo: (() => Promise<void>)[] = [];
    try {
        // Publish the project JSON last, after the files it refers to.
        const entries = [...files].sort(([a], [b]) => Number(manifests.has(a)) - Number(manifests.has(b)) ||
            Number(a === projectFile) - Number(b === projectFile));
        for (const [filename, bytes] of entries) {
            assertCurrent();
            const [first, basename] = filename.split('/');
            let parent = directory;
            if (basename !== undefined) {
                const existing = directories.get(first);
                if (existing) parent = existing;
                else {
                    const unexpected = await directory.getDirectoryHandle(first).catch(error => {
                        if (missing(error)) return null;
                        throw error;
                    });
                    if (unexpected) throw new FolderError('conflict');
                    parent = await directory.getDirectoryHandle(first, {create: true});
                    directories.set(first, parent);
                    undo.push(async () => {
                        const entry = await directory.getDirectoryHandle(first);
                        if (await entry.isSameEntry(parent)) await directory.removeEntry(first);
                    });
                }
            }
            const name = basename ?? first;
            const existing = await parent.getFileHandle(name).catch(error => {
                if (missing(error)) return null;
                throw error;
            });
            if (existing) throw new FolderError('conflict');
            const file = await parent.getFileHandle(name, {create: true});
            const initial = await file.getFile();
            if (initial.size !== 0) throw new FolderError('conflict');
            let expected: Uint8Array = new Uint8Array();
            undo.push(async () => {
                const entry = await parent.getFileHandle(name);
                if (!await entry.isSameEntry(file)) return;
                if (sameBytes(new Uint8Array(await (await entry.getFile()).arrayBuffer()), expected)) await parent.removeEntry(name);
            });
            const writable = await file.createWritable({mode: 'exclusive'} as FileSystemCreateWritableOptions);
            try {
                await writable.write(bytes as Uint8Array<ArrayBuffer>);
                assertCurrent();
                if (fileVersion(await file.getFile()) !== fileVersion(initial)) throw new FolderError('conflict');
                await writable.close();
                expected = bytes;
            } catch (error) {
                await writable.abort().catch(() => {});
                throw error;
            }
        }
        const source = await readFolder(directory, storage);
        assertCurrent();
        return source;
    } catch (error) {
        for (const revert of undo.reverse()) await revert().catch(() => {});
        throw error;
    }
}
