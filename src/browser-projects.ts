/**
 * Project folders kept in the browser's origin private file system (OPFS). They let browsers without the folder
 * picker, such as Safari and Firefox, open and save project folders. The folders live only in this browser, so the
 * browser may delete them; a user keeps a copy by exporting a ZIP or pushing to GitHub.
 *
 * Layout under the OPFS root:
 *   turbowarp-plus/projects/<id>/        the folder, a project folder with the project at its root
 *   turbowarp-plus/project-info/<id>.json  its title and times, kept outside the folder so Git never sees them
 */

export interface BrowserProject {
    id: string;
    title: string;
    /**
     * A folder inside the stored folder, `''` for the stored folder itself. Only for compatibility: the Editor opens the
     * project at the root of the stored folder, so an entry with another path is not a project folder there.
     */
    projectPath: string;
    createdAt: number;
    updatedAt: number;
}

export interface BrowserStorageState {
    usage?: number;
    quota?: number;
    persisted: boolean;
}

export interface BrowserProjects {
    list(): Promise<BrowserProject[]>;
    create(title: string, options?: {projectPath?: string}): Promise<BrowserProject & {root: FileSystemDirectoryHandle;
        directory: FileSystemDirectoryHandle}>;
    /** The stored folder, or `null` when it was deleted. */
    root(id: string): Promise<FileSystemDirectoryHandle | null>;
    /** The folder `projectPath` inside the entry's stored folder. Opening uses `root` instead. */
    directory(id: string): Promise<FileSystemDirectoryHandle | null>;
    /** The entry that holds `handle`, or `null` when it is not in the browser's storage. */
    find(handle: FileSystemHandle): Promise<BrowserProject | null>;
    touch(id: string): Promise<void>;
    rename(id: string, title: string): Promise<void>;
    remove(id: string): Promise<void>;
    storage(): Promise<BrowserStorageState>;
    /** Asks the browser to keep the storage. The browser may still say no. */
    persist(): Promise<boolean>;
    /** Runs `run` while no other tab of this origin works on the same entry. */
    exclusive<T>(id: string, run: () => Promise<T>): Promise<T>;
}

type StorageWindow = Window & {
    navigator: Navigator & {storage?: StorageManager & {getDirectory?(): Promise<FileSystemDirectoryHandle>}};
};
type IterableDirectory = FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>};

const base = 'turbowarp-plus';
const projectsDirectory = 'projects';
const infoDirectory = 'project-info';
const idPattern = /^[a-z0-9-]{1,64}$/u;
const pathPattern = /^(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/u;
const maxTitle = 200;
const infoMaxBytes = 16 * 1024;

const missing = (error: unknown) => error instanceof DOMException && ['NotFoundError', 'TypeMismatchError'].includes(error.name);

function cleanTitle(title: string) {
    const value = String(title).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maxTitle);
    return value || 'Untitled';
}

function parseInfo(id: string, text: string): BrowserProject | null {
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || typeof value.title !== 'string' ||
            !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) return null;
        const projectPath = typeof value.projectPath === 'string' && pathPattern.test(value.projectPath) &&
            !value.projectPath.split('/').some((part: string) => part === '.' || part === '..') ? value.projectPath : '';
        return {id, title: cleanTitle(value.title), projectPath, createdAt: value.createdAt, updatedAt: value.updatedAt};
    } catch {
        return null;
    }
}

async function writeText(directory: FileSystemDirectoryHandle, name: string, text: string) {
    const writable = await (await directory.getFileHandle(name, {create: true})).createWritable();
    try {
        await writable.write(new TextEncoder().encode(text));
        await writable.close();
    } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
    }
}

async function resolvePath(root: FileSystemDirectoryHandle, path: string) {
    let directory = root;
    for (const part of path ? path.split('/') : []) directory = await directory.getDirectoryHandle(part);
    return directory;
}

/** The browser's project folders, or `null` when the browser has no origin private file system. */
export function openBrowserProjects(view: Window): BrowserProjects | null {
    const navigator = (view as StorageWindow).navigator;
    const storage = navigator?.storage;
    if (typeof storage?.getDirectory !== 'function' || typeof view.crypto?.randomUUID !== 'function') return null;
    const locks = navigator.locks;
    let opened: Promise<{projects: FileSystemDirectoryHandle; info: FileSystemDirectoryHandle}> | undefined;
    const folders = () => opened ??= (async () => {
        const top = await (await storage.getDirectory!()).getDirectoryHandle(base, {create: true});
        return {
            projects: await top.getDirectoryHandle(projectsDirectory, {create: true}),
            info: await top.getDirectoryHandle(infoDirectory, {create: true})
        };
    })().catch(error => {opened = undefined; throw error;});
    const checkId = (id: string) => {
        if (!idPattern.test(id)) throw new DOMException('Unknown browser project', 'NotFoundError');
    };
    const readInfo = async (id: string) => {
        checkId(id);
        try {
            const file = await (await (await folders()).info.getFileHandle(`${id}.json`)).getFile();
            return file.size > infoMaxBytes ? null : parseInfo(id, await file.text());
        } catch (error) {
            if (missing(error)) return null;
            throw error;
        }
    };
    const writeInfo = async (project: BrowserProject) => {
        const {id, ...info} = project;
        await writeText((await folders()).info, `${id}.json`, `${JSON.stringify(info, null, 2)}\n`);
    };
    const root = async (id: string) => {
        checkId(id);
        try {
            return await (await folders()).projects.getDirectoryHandle(id);
        } catch (error) {
            if (missing(error)) return null;
            throw error;
        }
    };
    const exclusive = <T>(id: string, run: () => Promise<T>): Promise<T> => {
        checkId(id);
        return locks ? locks.request(`turbowarp-plus-browser-project:${id}`, run) as Promise<T> : run();
    };
    const projects: BrowserProjects = {
        async list() {
            const {info} = await folders();
            const found: BrowserProject[] = [];
            for await (const entry of (info as IterableDirectory).values()) {
                const id = entry.kind === 'file' && entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
                if (!idPattern.test(id)) continue;
                const project = await readInfo(id).catch(() => null);
                if (project && await root(id).catch(() => null)) found.push(project);
            }
            return found.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
        },
        async create(title, {projectPath = ''} = {}) {
            if (!pathPattern.test(projectPath) || projectPath.split('/').some(part => part === '.' || part === '..')) {
                throw new TypeError('Invalid project path');
            }
            const id = view.crypto.randomUUID().toLowerCase();
            const now = Date.now();
            const project = {id, title: cleanTitle(title), projectPath, createdAt: now, updatedAt: now};
            const top = await (await folders()).projects.getDirectoryHandle(id, {create: true});
            let directory = top;
            for (const part of projectPath ? projectPath.split('/') : []) directory = await directory.getDirectoryHandle(part, {create: true});
            await writeInfo(project);
            // Best effort: the first folder is a good moment to ask, and the answer does not change what happens.
            void projects.persist().catch(() => false);
            return {...project, root: top, directory};
        },
        root,
        async directory(id) {
            const project = await readInfo(id);
            const top = project && await root(id);
            if (!top) return null;
            try {
                return await resolvePath(top, project.projectPath);
            } catch (error) {
                if (missing(error)) return null;
                throw error;
            }
        },
        async find(handle) {
            const path = await (await folders()).projects.resolve(handle).catch(() => null);
            return path?.length && idPattern.test(path[0]) ? readInfo(path[0]) : null;
        },
        async touch(id) {
            const project = await readInfo(id);
            if (project) await writeInfo({...project, updatedAt: Math.max(Date.now(), project.updatedAt)});
        },
        async rename(id, title) {
            const project = await readInfo(id);
            if (!project) throw new DOMException('Unknown browser project', 'NotFoundError');
            await writeInfo({...project, title: cleanTitle(title), updatedAt: Math.max(Date.now(), project.updatedAt)});
        },
        remove: id => exclusive(id, async () => {
            const {projects: stored, info} = await folders();
            // The folder goes first, so an interrupted removal leaves no listed entry without its folder.
            await stored.removeEntry(id, {recursive: true}).catch(error => {if (!missing(error)) throw error;});
            await info.removeEntry(`${id}.json`).catch(error => {if (!missing(error)) throw error;});
        }),
        async storage() {
            const [estimate, persisted] = await Promise.all([
                storage.estimate?.().catch(() => undefined),
                storage.persisted?.().catch(() => false) ?? false
            ]);
            return {usage: estimate?.usage, quota: estimate?.quota, persisted: Boolean(persisted)};
        },
        async persist() {
            return Boolean(await storage.persist?.());
        },
        exclusive
    };
    return projects;
}
