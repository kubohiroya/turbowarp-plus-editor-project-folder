export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type JsonObject = {[key: string]: Json};
export type Project = JsonObject & {targets: Target[]};
type Target = JsonObject & {isStage: boolean; name: string};

export const projectFile = 'project.source.json';
const manifestFile = 'sb3-source.json';
const extensionsFile = 'embedded-extensions.json';

export class FolderError extends Error {
    code: 'conflict' | 'unsupported';
    constructor(code: FolderError['code'], detail?: string) {
        super(detail ?? code);
        this.code = code;
    }
}

export const unsupported = (detail: string): never => {throw new FolderError('unsupported', detail);};
export const isObject = (value: Json | undefined): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const readObject = (text: string): JsonObject => {
    const value = JSON.parse(text);
    if (!isObject(value)) return unsupported('Expected a JSON object');
    return value;
};
const targetKey = (target: Target) => target.isStage ? 'stage' : `sprite:${target.name}`;

export function parseProject(text: string): Project {
    const project = readObject(text);
    if (!Array.isArray(project.targets)) return unsupported('Missing targets');
    const keys = new Set<string>();
    let stages = 0;
    for (const target of project.targets) {
        if (!isObject(target) || typeof target.isStage !== 'boolean' || typeof target.name !== 'string') {
            return unsupported('Invalid target');
        }
        const key = targetKey(target as Target);
        if (keys.has(key)) return unsupported('Ambiguous target names');
        keys.add(key);
        if (target.isStage) stages++;
        if (target.blocks !== undefined && !isObject(target.blocks)) return unsupported('Invalid blocks');
        if (target.comments !== undefined && !isObject(target.comments)) return unsupported('Invalid comments');
    }
    if (stages !== 1) return unsupported('Expected one stage');
    return project as Project;
}

export interface AssetType {name: string}
export interface Asset {assetId: string; dataFormat: string; data: Uint8Array}
export interface Storage {
    AssetType: {Sound: AssetType; ImageVector: AssetType; ImageBitmap: AssetType};
    createAsset(type: AssetType, format: string, data: Uint8Array, id: null, generateId: true): Asset;
    addHelper(helper: {load(type: AssetType, id: string, format: string): Promise<Asset> | null}, priority: number): void;
}

type FolderFiles = {
    versions: Map<string, string>;
    files: Map<string, Uint8Array>;
    directory: FileSystemDirectoryHandle;
    bytes: Map<string, Uint8Array>;
};
export type FolderSource = FolderFiles & {project: Project; projectText: string; storageAssets: Map<string, Asset>};

const getFile = async (dir: FileSystemDirectoryHandle, name: string) => (await dir.getFileHandle(name)).getFile();
const fileVersion = (file: File) => `${file.size}:${file.lastModified}`;
const fileBytes = async (file: File) => new Uint8Array(await file.arrayBuffer());
const readBytes = async (dir: FileSystemDirectoryHandle, name: string) => fileBytes(await getFile(dir, name));
const readNames = async (dir: FileSystemDirectoryHandle) => {
    const names = new Set<string>();
    // Directory iteration is available alongside the picker, but absent from older DOM typings.
    for await (const entry of (dir as FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>}).values()) {
        if (entry.kind !== 'file') return unsupported('Nested entries are outside the supported source format');
        names.add(entry.name);
    }
    return names;
};
const sameNames = (actual: Set<string>, expected: Iterable<string>) => {
    const expectedNames = new Set(expected);
    return actual.size === expectedNames.size && [...actual].every(name => expectedNames.has(name));
};

export const assetKey = (type: AssetType, id: string, format: string) => `${type.name}/${id}.${format}`;

export async function readFolder(directory: FileSystemDirectoryHandle, storage: Storage): Promise<FolderSource> {
    const versions = new Map<string, string>();
    const readEntry = async (dir: FileSystemDirectoryHandle, name: string, prefix = '') => {
        const file = await getFile(dir, name);
        versions.set(prefix + name, fileVersion(file));
        return [name, await fileBytes(file)] as const;
    };
    const filenames = [projectFile, manifestFile, extensionsFile];
    const files = new Map(await Promise.all(filenames.map(name => readEntry(directory, name))));
    const decoder = new TextDecoder('utf-8', {fatal: true});
    const projectText = decoder.decode(files.get(projectFile));
    const project = parseProject(projectText);
    const manifest = readObject(decoder.decode(files.get(manifestFile)));
    const embedded = readObject(decoder.decode(files.get(extensionsFile)));
    if (manifest.formatVersion !== 1 || manifest.project !== projectFile || manifest.embeddedExtensions !== extensionsFile ||
        manifest.assetsDirectory !== 'assets' || !Array.isArray(manifest.archiveEntries)) {
        return unsupported('Expected an sb3-toolchain v1 folder');
    }
    if (embedded.formatVersion !== 1 || !Array.isArray(embedded.extensions) || embedded.extensions.length ||
        (embedded.extensionBundles !== undefined && (!Array.isArray(embedded.extensionBundles) || embedded.extensionBundles.length)) ||
        project.turboWarpPlus !== undefined || project.customFonts !== undefined ||
        (project.extensionURLs !== undefined && (!isObject(project.extensionURLs) || Object.keys(project.extensionURLs).length))) {
        return unsupported('Custom extensions and fonts are outside the prototype scope');
    }
    const expected = new Set(['project.json']);
    const references = new Map<string, {id: string; format: string; type: AssetType; name: string}>();
    for (const target of project.targets) {
        for (const kind of ['costumes', 'sounds'] as const) {
            const entries = target[kind] ?? [];
            if (!Array.isArray(entries)) return unsupported('Invalid asset list');
            for (const entry of entries) {
                if (!isObject(entry) || typeof entry.assetId !== 'string' || !/^[a-f0-9]{32}$/u.test(entry.assetId) ||
                    typeof entry.dataFormat !== 'string') return unsupported('Invalid asset reference');
                const {assetId: id, dataFormat: format} = entry;
                const name = `${id}.${format}`;
                const type = kind === 'sounds' ?
                    (/^(wav|mp3)$/u.test(format) ? storage.AssetType.Sound : null) :
                    (format === 'svg' ? storage.AssetType.ImageVector :
                        (/^(png|bmp|jpg|jpeg|gif)$/u.test(format) ? storage.AssetType.ImageBitmap : null));
                if (!type || entry.md5ext !== name) return unsupported(`Unsupported asset reference: ${name}`);
                expected.add(name);
                references.set(assetKey(type, id, format), {id, format, type, name});
            }
        }
    }
    if (manifest.archiveEntries.length !== expected.size || !sameNames(new Set(manifest.archiveEntries as string[]), expected)) {
        return unsupported('Asset references and archiveEntries do not match');
    }
    expected.delete('project.json');
    const [assets, extensions] = await Promise.all([directory.getDirectoryHandle('assets'), directory.getDirectoryHandle('extensions')]);
    if (!sameNames(await readNames(assets), expected) || (await readNames(extensions)).size) {
        return unsupported('Unexpected or missing source files');
    }
    const bytes = new Map(await Promise.all([...expected].map(name => readEntry(assets, name, 'assets/'))));
    const storageAssets = new Map<string, Asset>();
    for (const [key, {id, format, type, name}] of references) {
        const asset = storage.createAsset(type, format, bytes.get(name)!.slice(), null, true);
        if (asset.assetId !== id) return unsupported(`Asset hash mismatch: ${name}`);
        storageAssets.set(key, asset);
    }
    return {versions, files, directory, bytes, project, projectText, storageAssets};
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);

export type FolderUpdate = {version: string; bytes: Uint8Array; project: Project};
type DiskChange = FolderUpdate | 'blocked' | null;

// Metadata probes do not read file contents. Only a changed project JSON can be applied here.
export async function readFolderUpdate(source: FolderSource, previous: FolderUpdate | null): Promise<DiskChange> {
    const {directory, versions} = source;
    try {
        const [assets, extensions, project] = await Promise.all([
            directory.getDirectoryHandle('assets'), directory.getDirectoryHandle('extensions'), getFile(directory, projectFile)
        ]);
        const [assetNames, extensionNames] = await Promise.all([readNames(assets), readNames(extensions)]);
        if (!sameNames(assetNames, source.bytes.keys()) || extensionNames.size) return 'blocked';
        const unchanged = await Promise.all([
            ...[manifestFile, extensionsFile].map(async name => fileVersion(await getFile(directory, name)) === versions.get(name)),
            ...[...assetNames].map(async name => fileVersion(await getFile(assets, name)) === versions.get(`assets/${name}`))
        ]);
        if (unchanged.includes(false)) return 'blocked';
        const version = fileVersion(project);
        if (version === versions.get(projectFile)) return null;
        if (previous?.version === version) return previous;
        const bytes = await fileBytes(project);
        // An editor may update the timestamp without changing the bytes, including our own save.
        if (sameBytes(bytes, source.files.get(projectFile)!)) {
            versions.set(projectFile, version);
            return null;
        }
        return {version, bytes, project: parseProject(new TextDecoder('utf-8', {fatal: true}).decode(bytes))};
    } catch {
        // A transient invalid or incomplete external write is retried on the next scan.
        return 'blocked';
    }
}

export async function assertFolderUnchanged(source: FolderSource) {
    try {
        const assets = await source.directory.getDirectoryHandle('assets');
        const extensions = await source.directory.getDirectoryHandle('extensions');
        if (!sameNames(await readNames(assets), source.bytes.keys()) || (await readNames(extensions)).size) throw new FolderError('conflict');
        for (const [name, bytes] of source.files) {
            if (!sameBytes(await readBytes(source.directory, name), bytes)) throw new FolderError('conflict');
        }
        for (const [name, bytes] of source.bytes) {
            if (!sameBytes(await readBytes(assets, name), bytes)) throw new FolderError('conflict');
        }
    } catch (error) {
        if (error instanceof FolderError || (error instanceof DOMException && ['NotFoundError', 'TypeMismatchError'].includes(error.name))) {
            throw new FolderError('conflict');
        }
        throw error;
    }
}

export const equal = (left: Json | undefined, right: Json | undefined): boolean => {
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((item, index) => equal(item, right[index]));
    }
    if (!isObject(left) || !isObject(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
        keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
};

const applyChanges = (source: Json | undefined, before: Json, after: Json): Json => {
    if (equal(before, after)) return source === undefined ? after : source;
    if (!isObject(before) || !isObject(after)) return after;
    const result: JsonObject = Object.assign(Object.create(null), isObject(source) ? source : {});
    for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key)) delete result[key];
        else if (!equal(before[key], after[key])) {
            result[key] = applyChanges(Object.hasOwn(result, key) ? result[key] : undefined, before[key], after[key]);
        }
    }
    for (const key of Object.keys(after)) {
        if (!Object.hasOwn(before, key)) result[key] = after[key];
    }
    return result;
};

export function projectChanges(source: Project, before: Project, after: Project): Project | null {
    const {targets: beforeTargets, ...beforeOther} = before;
    const {targets: afterTargets, ...afterOther} = after;
    if (!equal(beforeOther, afterOther) || !equal(beforeTargets.map(targetKey), afterTargets.map(targetKey))) {
        return unsupported('This prototype saves block edits on existing targets only');
    }
    const edits = new Map<string, Partial<Pick<Target, 'blocks' | 'comments'>>>();
    const originalTargets = new Map(source.targets.map(target => [targetKey(target), target]));
    for (const [index, target] of afterTargets.entries()) {
        const {blocks, comments, ...rest} = target;
        const {blocks: priorBlocks, comments: priorComments, ...priorRest} = beforeTargets[index];
        if (!equal(rest, priorRest)) return unsupported('This prototype saves block edits on existing targets only');
        const key = targetKey(target);
        const original = originalTargets.get(key);
        if (!original) return unsupported('The original target could not be identified');
        if (!equal(priorBlocks, blocks) || !equal(priorComments, comments)) {
            const changes: Partial<Pick<Target, 'blocks' | 'comments'>> = {};
            if (!equal(priorBlocks, blocks)) changes.blocks = applyChanges(original.blocks, priorBlocks, blocks);
            if (!equal(priorComments, comments)) changes.comments = applyChanges(original.comments, priorComments, comments);
            edits.set(key, changes);
        }
    }
    if (!edits.size) return null;
    return {...source, targets: source.targets.map(target => {
        const edit = edits.get(targetKey(target));
        return edit ? {...target, ...edit} : target;
    })};
}
