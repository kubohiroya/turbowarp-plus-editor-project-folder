/**
 * The expanded folders and the selected entry of each project folder's explorer, for this page. It outlives the
 * explorer, which unmounts whenever the side panel shows another view, so the tree comes back as it was left, and
 * the Editor's screen state reads it from here when a project is saved.
 */

export interface ExplorerTreeState {
    /** Folder paths relative to the project folder, such as `assets`. */
    expanded: readonly string[];
    /** The selected entry, a path relative to the project folder. */
    selected?: string;
}

/** The folder the Editor keeps its own files in. The explorer and its search leave it out, like `.git`. */
export const editorDirectory = '.tw-plus';
/** The screen state of the Editor, inside `editorDirectory`. */
export const screenStateFile = 'workspace.json';
export const hiddenEntry = (name: string) => ['.git', editorDirectory].includes(name.toLowerCase());

const limit = 1000;
const states = new WeakMap<FileSystemDirectoryHandle, ExplorerTreeState>();
const listeners = new WeakMap<FileSystemDirectoryHandle, Set<(state: ExplorerTreeState) => void>>();

const validPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
    value.length <= 1024 && value.split('/').every(part => part && part !== '.' && part !== '..' && !hiddenEntry(part) &&
    !/[\\\u0000]/u.test(part));

/** Read a tree state saved in a file, keeping only well-formed paths. */
export function parseExplorerState(value: unknown): ExplorerTreeState | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const {expanded, selected} = value as Record<string, unknown>;
    if (!Array.isArray(expanded)) return;
    return {expanded: [...new Set(expanded.filter(validPath))].slice(0, limit),
        ...(validPath(selected) && {selected})};
}

export const readExplorerState = (directory: FileSystemDirectoryHandle) => states.get(directory);

/** Remember the tree of `directory`. With `notify`, a mounted explorer of that folder shows it too. */
export function writeExplorerState(directory: FileSystemDirectoryHandle, state: ExplorerTreeState, notify = false) {
    states.set(directory, state);
    if (notify) for (const listener of [...listeners.get(directory) ?? []]) listener(state);
}

export function subscribeExplorerState(directory: FileSystemDirectoryHandle, listener: (state: ExplorerTreeState) => void) {
    let set = listeners.get(directory);
    if (!set) listeners.set(directory, set = new Set());
    set.add(listener);
    return () => {set.delete(listener);};
}
