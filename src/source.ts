export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type JsonObject = {[key: string]: Json};
export type Project = JsonObject & {targets: Target[]};
type Target = JsonObject & {isStage: boolean; name: string};

export const projectFile = 'project.source.json';
export const manifestFile = 'sb3-source.json';
export const extensionsFile = 'embedded-extensions.json';
const embeddedReference = 'embedded-extension:';

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
    AssetType: {Sound: AssetType; ImageVector: AssetType; ImageBitmap: AssetType; Font?: AssetType};
    createAsset(type: AssetType, format: string, data: Uint8Array, id: null, generateId: true): Asset;
    addHelper(helper: {load(type: AssetType, id: string, format: string): Promise<Asset> | null}, priority: number): void;
}

type FolderFiles = {
    versions: Map<string, string>;
    files: Map<string, Uint8Array>;
    directory: FileSystemDirectoryHandle;
    bytes: Map<string, Uint8Array>;
    extensionBytes: Map<string, Uint8Array>;
};
export type FolderSource = FolderFiles & {
    project: Project;
    loadText: string;
    storageAssets: Map<string, Asset>;
    embedded: ExtensionManifest;
};

const getFile = async (dir: FileSystemDirectoryHandle, name: string) => (await dir.getFileHandle(name)).getFile();
export const fileVersion = (file: File) => `${file.size}:${file.lastModified}`;
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

export type AssetKind = 'costumes' | 'sounds' | 'fonts';

export const assetTypeFor = (storage: Storage, kind: AssetKind, format: string): AssetType => {
    if (kind === 'fonts') return storage.AssetType.Font ?? unsupported('The editor does not support font assets');
    if (kind === 'sounds') return storage.AssetType.Sound;
    return format === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
};
export const assetKey = (type: AssetType, id: string, format: string) => `${type.name}/${id}.${format}`;

type DataUrlMetadata = {mediaType: string; parameters: string[]; encoding: 'base64' | 'percent'};
type EmbeddedExtension = JsonObject & DataUrlMetadata & {id: string; path: string};
type ExtensionBundle = JsonObject & {id: string; members: string[]};
type ExtensionManifest = JsonObject & {extensions: EmbeddedExtension[]; extensionBundles?: ExtensionBundle[]};

const extensionPath = (id: string) => {
    if (!/^[A-Za-z0-9._-]+$/u.test(id)) return unsupported(`Embedded extension ID cannot be used as a filename: ${id}`);
    return `extensions/${id}.js`;
};
const validUrlPart = (part: Json | undefined): part is string => typeof part === 'string' && part.length > 0 && !/[;,\r\n]/u.test(part);
const extensionURLs = (project: Project) => {
    const urls = project.extensionURLs === undefined ? {} : project.extensionURLs;
    if (!isObject(urls) || Object.values(urls).some(url => typeof url !== 'string')) return unsupported('Invalid extensionURLs');
    return urls as Record<string, string>;
};
const apiManifestName = (entry: EmbeddedExtension): string | undefined => {
    if (entry.source === undefined) return;
    if (!isObject(entry.source)) return unsupported(`Invalid source for embedded extension: ${entry.id}`);
    const api = entry.source.apiManifest;
    if (api === undefined) return;
    const name = `${entry.id}.manifest.json`;
    if (!isObject(api) || api.path !== `extensions/${name}`) return unsupported(`Invalid API manifest path: ${entry.id}`);
    return name;
};
const extensionNames = (entries: EmbeddedExtension[]) => entries.flatMap(entry => {
    const script = `${entry.id}.js`;
    const api = apiManifestName(entry);
    return api === undefined ? [script] : [script, api];
});

function validateExtensions(project: Project, value: JsonObject): ExtensionManifest {
    if (value.formatVersion !== 1 || !Array.isArray(value.extensions)) return unsupported('Invalid embedded extension manifest');
    const urls = extensionURLs(project);
    const ids = new Set<string>();
    for (const entry of value.extensions) {
        if (!isObject(entry) || typeof entry.id !== 'string' || ids.has(entry.id) ||
            entry.path !== extensionPath(entry.id) || !validUrlPart(entry.mediaType) ||
            !Array.isArray(entry.parameters) || !entry.parameters.every(validUrlPart) ||
            (entry.encoding !== 'base64' && entry.encoding !== 'percent') ||
            !Object.hasOwn(urls, entry.id) || urls[entry.id] !== embeddedReference + entry.path) {
            return unsupported('Invalid embedded extension entry or project reference');
        }
        ids.add(entry.id);
    }
    for (const [id, url] of Object.entries(urls)) {
        if (url.startsWith('data:') || (url.startsWith(embeddedReference) && !ids.has(id))) {
            return unsupported(`Invalid embedded extension reference: ${id}`);
        }
    }
    if (value.extensionBundles !== undefined) {
        if (!Array.isArray(value.extensionBundles)) return unsupported('Invalid extensionBundles');
        const bundleIds = new Set<string>();
        const members = new Set<string>();
        for (const bundle of value.extensionBundles) {
            if (!isObject(bundle) || typeof bundle.id !== 'string' || !/^[a-z0-9]+$/u.test(bundle.id) ||
                ids.has(bundle.id) || bundleIds.has(bundle.id) || typeof bundle.name !== 'string' ||
                !bundle.name.trim() || /[\r\n]/u.test(bundle.name) ||
                !Array.isArray(bundle.members) || bundle.members.length < 2) {
                return unsupported('Invalid extension bundle');
            }
            bundleIds.add(bundle.id);
            for (const member of bundle.members) {
                if (typeof member !== 'string' || !/^[a-z0-9]+$/u.test(member) || !ids.has(member) || members.has(member)) {
                    return unsupported(`Invalid member of extension bundle: ${bundle.id}`);
                }
                members.add(member);
            }
        }
    }
    return value as ExtensionManifest;
}

function encodeDataUrl(entry: EmbeddedExtension, bytes: Uint8Array): string {
    const metadata = [entry.mediaType, ...entry.parameters].join(';');
    if (entry.encoding === 'percent') {
        const payload = Array.from(bytes, byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('');
        return `data:${metadata},${payload}`;
    }
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return `data:${metadata};base64,${btoa(binary)}`;
}

function decodeDataUrl(id: string, url: string): {metadata: DataUrlMetadata; bytes: Uint8Array} {
    const comma = url.indexOf(',');
    if (comma === -1) return unsupported(`Invalid data URL for embedded extension: ${id}`);
    const [type, ...parameters] = url.slice('data:'.length, comma).split(';');
    const mediaType = type || 'text/plain';
    const base64 = parameters.indexOf('base64');
    if (base64 !== -1) parameters.splice(base64, 1);
    const encoding = base64 === -1 ? 'percent' : 'base64';
    if (!validUrlPart(mediaType) || !parameters.every(validUrlPart) || parameters.includes('base64')) {
        return unsupported(`Invalid data URL metadata for embedded extension: ${id}`);
    }
    const payload = url.slice(comma + 1);
    try {
        if (encoding === 'percent') {
            return {metadata: {mediaType, parameters, encoding}, bytes: new TextEncoder().encode(decodeURIComponent(payload))};
        }
        if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) throw new Error('Invalid base64');
        const binary = atob(payload.replace(/=+$/u, ''));
        return {metadata: {mediaType, parameters, encoding}, bytes: Uint8Array.from(binary, char => char.charCodeAt(0))};
    } catch {
        return unsupported(`Invalid data URL payload for embedded extension: ${id}`);
    }
}

function hasSandboxedNoticeRequirement(bundle: ExtensionBundle, entry: EmbeddedExtension, bytes: Uint8Array): boolean {
    let requirement;
    if (bundle.buildMode === 'module') {
        const source = entry.source;
        if (isObject(source) && isObject(source.module)) requirement = source.module.unsandboxed;
    } else {
        const script = new TextDecoder().decode(bytes);
        requirement = /^\/\/ Unsandboxed: (.+)\r?$/mu.exec(script)?.[1].trim();
    }
    return requirement === 'required' || requirement === 'optional';
}

export function planExtensionSave(source: FolderSource, project: Project) {
    const urls = {...extensionURLs(project)};
    const entries = new Map(source.embedded.extensions.map(entry => [entry.id, entry]));
    const writes = new Map<string, Uint8Array>();
    const sourceRemoved: string[] = [];
    for (const [id, entry] of entries) {
        if (!Object.hasOwn(urls, id) || (!urls[id].startsWith('data:') && urls[id] !== embeddedReference + entry.path)) entries.delete(id);
    }
    for (const [id, url] of Object.entries(urls)) {
        if (!url.startsWith('data:')) continue;
        const path = extensionPath(id);
        const {metadata, bytes} = decodeDataUrl(id, url);
        const name = `${id}.js`;
        const previous = entries.get(id);
        urls[id] = embeddedReference + path;
        if (!previous || !sameBytes(source.extensionBytes.get(name)!, bytes)) {
            const entry: EmbeddedExtension = {...previous, id, path, ...metadata};
            if (entry.source !== undefined) {
                delete entry.source;
                sourceRemoved.push(id);
            }
            entries.set(id, entry);
            writes.set(name, bytes);
        }
    }
    const embedded: ExtensionManifest = {...source.embedded, extensions: [...entries.values()]};
    if (embedded.extensionBundles) {
        embedded.extensionBundles = embedded.extensionBundles.flatMap(bundle => {
            const members = bundle.members.filter(id => entries.has(id) &&
                // Module bundles need a managed npm module for each member.
                !(bundle.buildMode === 'module' && sourceRemoved.includes(id)));
            if (members.length < 2) return [];
            const updated: ExtensionBundle = {...bundle, members};
            const changed = members.length !== bundle.members.length || members.some(id => writes.has(`${id}.js`));
            if (updated.sandboxedNotice !== undefined && changed && !members.some(id => {
                const name = `${id}.js`;
                return hasSandboxedNoticeRequirement(updated, entries.get(id)!, writes.get(name) ?? source.extensionBytes.get(name)!);
            })) {
                delete updated.sandboxedNotice;
            }
            return [updated];
        });
    }
    const result = project.extensionURLs === undefined ? project : {...project, extensionURLs: urls};
    validateExtensions(result, embedded);
    const names = new Set(extensionNames(embedded.extensions));
    return {project: result, embedded, manifestChanged: !equal(embedded, source.embedded), writes, sourceRemoved,
        removed: [...source.extensionBytes.keys()].filter(name => !names.has(name))};
}

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
    if (project.turboWarpPlus !== undefined) return unsupported('Plus extension manifests are not supported in project folders');
    const extensionManifest = validateExtensions(project, embedded);
    const references = projectAssets(project);
    const expected = new Set(['project.json', ...references.keys()]);
    if (manifest.archiveEntries.length !== expected.size || !sameNames(new Set(manifest.archiveEntries as string[]), expected)) {
        return unsupported('Asset references and archiveEntries do not match');
    }
    expected.delete('project.json');
    const [assets, extensions] = await Promise.all([directory.getDirectoryHandle('assets'), directory.getDirectoryHandle('extensions')]);
    const scripts = extensionNames(extensionManifest.extensions);
    if (!sameNames(await readNames(assets), expected) || !sameNames(await readNames(extensions), scripts)) {
        return unsupported('Unexpected or missing source files');
    }
    const bytes = new Map(await Promise.all([...expected].map(name => readEntry(assets, name, 'assets/'))));
    const extensionBytes = new Map(await Promise.all(scripts.map(name => readEntry(extensions, name, 'extensions/'))));
    const loadText = extensionManifest.extensions.length ? JSON.stringify({...project, extensionURLs: {
        ...extensionURLs(project),
        ...Object.fromEntries(extensionManifest.extensions.map(entry =>
            [entry.id, encodeDataUrl(entry, extensionBytes.get(`${entry.id}.js`)!)]))
    }}) : projectText;
    const storageAssets = new Map<string, Asset>();
    for (const [name, kind] of references) {
        const [id, format] = name.split('.');
        const type = assetTypeFor(storage, kind, format);
        const asset = storage.createAsset(type, format, bytes.get(name)!.slice(), null, true);
        if (asset.assetId !== id) return unsupported(`Asset hash mismatch: ${name}`);
        storageAssets.set(assetKey(type, id, format), asset);
    }
    return {versions, files, directory, bytes, extensionBytes, project, loadText, storageAssets, embedded: extensionManifest};
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);

export type FolderUpdate = {version: string; bytes: Uint8Array; project: Project};
export type DiskChange = FolderUpdate | 'structure' | 'waiting' | null;

// Metadata probes do not read file contents. Only a changed project JSON can be applied partially; changes to
// assets, the manifest or extensions report 'structure' so that the host can offer a whole reload instead.
export async function readFolderUpdate(source: FolderSource, previous: FolderUpdate | null): Promise<DiskChange> {
    const {directory, versions} = source;
    try {
        const [assets, extensions, project] = await Promise.all([
            directory.getDirectoryHandle('assets'), directory.getDirectoryHandle('extensions'), getFile(directory, projectFile)
        ]);
        const [assetNames, extensionNames] = await Promise.all([readNames(assets), readNames(extensions)]);
        if (!sameNames(assetNames, source.bytes.keys()) || !sameNames(extensionNames, source.extensionBytes.keys())) return 'structure';
        const unchanged = await Promise.all([
            ...[manifestFile, extensionsFile].map(async name => fileVersion(await getFile(directory, name)) === versions.get(name)),
            ...[...assetNames].map(async name => fileVersion(await getFile(assets, name)) === versions.get(`assets/${name}`)),
            ...[...extensionNames].map(async name => fileVersion(await getFile(extensions, name)) === versions.get(`extensions/${name}`))
        ]);
        if (unchanged.includes(false)) return 'structure';
        const version = fileVersion(project);
        if (version === versions.get(projectFile)) return null;
        if (previous?.version === version) return previous;
        const bytes = await fileBytes(project);
        // An editor may update the timestamp without changing the bytes, including our own save.
        if (sameBytes(bytes, source.files.get(projectFile)!)) {
            versions.set(projectFile, version);
            return null;
        }
        const updated = parseProject(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
        if (!equal(source.project.extensionURLs, updated.extensionURLs)) return 'structure';
        return {version, bytes, project: updated};
    } catch (error) {
        // Well-formed JSON outside the partial scope needs a whole reload. Anything else may be a write in
        // progress, such as truncated JSON or a file replaced between the probe and the read, and is retried.
        return error instanceof FolderError ? 'structure' : 'waiting';
    }
}

export async function assertFolderUnchanged(source: FolderSource) {
    try {
        const assets = await source.directory.getDirectoryHandle('assets');
        const extensions = await source.directory.getDirectoryHandle('extensions');
        if (!sameNames(await readNames(assets), source.bytes.keys()) ||
            !sameNames(await readNames(extensions), source.extensionBytes.keys())) throw new FolderError('conflict');
        for (const [directory, files] of [[source.directory, source.files], [assets, source.bytes], [extensions, source.extensionBytes]] as const) {
            for (const [name, bytes] of files) {
                if (!sameBytes(await readBytes(directory, name), bytes)) throw new FolderError('conflict');
            }
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

// Items that name themselves (monitors, costumes) must be the same item in the folder and in the Editor.
const sameIdentity = (left: Json, right: Json) => !isObject(left) || !isObject(right) ||
    ['id', 'assetId', 'name', 'opcode'].every(key => !Object.hasOwn(left, key) || !Object.hasOwn(right, key) || equal(left[key], right[key]));
const applyChanges = (source: Json | undefined, before: Json, after: Json): Json => {
    if (equal(before, after)) return source === undefined ? after : source;
    // Lists of the same length, such as costumes or a block input, change item by item to keep unknown fields.
    if (Array.isArray(before) && Array.isArray(after) && Array.isArray(source) &&
        before.length === after.length && source.length === after.length &&
        source.every((item, index) => sameIdentity(item, before[index]))) {
        return after.map((item, index) => applyChanges(source[index], before[index], item));
    }
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

/** The asset files a project refers to, by file name, with the kind of list that refers to each. */
export const projectAssets = (project: Project) => {
    const names = new Map<string, AssetKind>();
    for (const target of project.targets) {
        for (const kind of ['costumes', 'sounds'] as const) {
            const entries = target[kind] ?? [];
            if (!Array.isArray(entries)) return unsupported('Invalid asset list');
            for (const entry of entries) {
                if (!isObject(entry) || typeof entry.assetId !== 'string' || !/^[a-f0-9]{32}$/u.test(entry.assetId) ||
                    typeof entry.dataFormat !== 'string' || entry.md5ext !== `${entry.assetId}.${entry.dataFormat}`) {
                    return unsupported('Invalid asset reference');
                }
                const supported = kind === 'sounds' ? /^(wav|mp3)$/u.test(entry.dataFormat) :
                    /^(svg|png|bmp|jpg|jpeg|gif)$/u.test(entry.dataFormat);
                if (!supported) return unsupported(`Unsupported asset reference: ${entry.md5ext}`);
                names.set(entry.md5ext, kind);
            }
        }
    }
    const fonts = project.customFonts ?? [];
    if (!Array.isArray(fonts)) return unsupported('Invalid customFonts list');
    for (const font of fonts) {
        if (!isObject(font) || font.system !== false) continue;
        if (typeof font.md5ext !== 'string' || !/^[a-f0-9]{32}\.(ttf|otf|woff2?)$/u.test(font.md5ext)) {
            return unsupported('Invalid font asset reference');
        }
        names.set(font.md5ext, 'fonts');
    }
    return names;
};

/** Runtime ids of the targets, in the order of the project's `targets`, so a renamed sprite stays the same sprite. */
export type TargetIdentity = {before: readonly string[]; after: readonly string[]};

/**
 * Applies the edits between `before` and `after` (both from the VM) to the project read from the folder, keeping the
 * fields and order the VM does not know. Sprites are matched by `identity` (by name without it): a sprite with the
 * same id keeps its folder entry under a new name, and added or removed sprites are added or removed. The asset files
 * the result needs are the caller's to write. Returns `null` without edits.
 */
export function projectChanges(source: Project, before: Project, after: Project, identity?: TargetIdentity): Project | null {
    const beforeIds = identity?.before ?? before.targets.map(targetKey);
    const afterIds = identity?.after ?? after.targets.map(targetKey);
    if (beforeIds.length !== before.targets.length || afterIds.length !== after.targets.length) {
        return unsupported('The targets could not be identified');
    }
    projectAssets(after);
    if (after.turboWarpPlus !== undefined) return unsupported('Plus extension manifests are not saved to a project folder');
    if (equal(before, after) && equal([...beforeIds], [...afterIds])) return null;
    const {targets: sourceTargets, ...sourceOther} = source;
    const {targets: beforeTargets, ...beforeOther} = before;
    const {targets: afterTargets, ...afterOther} = after;
    const originals = new Map(sourceTargets.map(target => [targetKey(target), target]));
    const previous = new Map(beforeTargets.map((target, index) => [beforeIds[index], target]));
    const targets = afterTargets.map((target, index) => {
        const prior = previous.get(afterIds[index]);
        if (!prior) return target;
        const original = originals.get(targetKey(prior));
        if (!original) return unsupported('The original target could not be identified');
        return applyChanges(original, prior, target) as Target;
    });
    // The folder keeps its own target order unless the Editor added, removed or reordered sprites.
    let ordered = targets;
    if (equal([...beforeIds], [...afterIds])) {
        const position = new Map(sourceTargets.map((target, index) => [targetKey(target), index]));
        const place = (index: number) => position.get(targetKey(beforeTargets[index])) ?? index;
        ordered = targets.map((target, index) => ({target, at: place(index)})).sort((a, b) => a.at - b.at).map(entry => entry.target);
    }
    const other = applyChanges(sourceOther, beforeOther, afterOther) as JsonObject;
    if (!equal(before.extensionURLs, after.extensionURLs)) {
        // The VM only serializes the URLs it knows. Apply its edits to those entries.
        const urls = applyChanges(source.extensionURLs, extensionURLs(before), extensionURLs(after)) as JsonObject;
        if (after.extensionURLs === undefined && !Object.keys(urls).length) delete other.extensionURLs;
        else other.extensionURLs = urls;
    }
    // Keep the folder's key order, with the targets where they were.
    const result: JsonObject = {};
    for (const key of Object.keys(source)) {
        if (key === 'targets') result.targets = ordered;
        else if (Object.hasOwn(other, key)) result[key] = other[key];
    }
    for (const key of Object.keys(other)) if (!Object.hasOwn(result, key)) result[key] = other[key];
    return result as Project;
}
