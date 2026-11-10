import * as React from 'react';
import {asyncDataLoaderFeature, hotkeysCoreFeature, selectionFeature} from '@headless-tree/core';
import type {ItemInstance} from '@headless-tree/core';
import {useTree} from '@headless-tree/react/react17';
import {isObject, manifestFile, projectFile} from './source.js';
import type {Json, Project} from './source.js';

export type ExplorerMark = 'added' | 'modified' | 'deleted' | 'untracked';
export type ExplorerEntry = {path: string; name: string; kind: 'file' | 'directory'};
export type ProjectFolderExplorerProps = {
    /** The folder to show: a project folder or a repository root. It is only read. */
    directory: FileSystemDirectoryHandle;
    /** 'ja…' shows Japanese text; anything else shows English. */
    locale?: string;
    /** Extra text for an entry, by path relative to `directory`, such as `assets/<md5>.svg`. */
    descriptions?: ReadonlyMap<string, string>;
    /** Git status for an entry, by path relative to `directory`. */
    marks?: ReadonlyMap<string, ExplorerMark>;
    /** Called when a file is opened with Enter, Space or a click. */
    onOpen?(entry: ExplorerEntry): void;
    /** The tree's accessible name. Defaults to "Project folder". */
    label?: string;
};

const messages = {
    en: {
        label: 'Project folder', loading: 'Loading…', empty: 'This folder is empty.',
        failed: 'This folder could not be read.', denied: 'Permission to read this folder was not granted.',
        separator: ', ',
        marks: {added: 'Added', modified: 'Modified', deleted: 'Deleted', untracked: 'Untracked'},
        project: 'Project data', manifest: 'Folder manifest', extensions: 'Embedded extensions',
        assetsDirectory: 'Costume and sound files', extensionsDirectory: 'Extension files',
        costume: (sprite: string, name: string) => `${sprite} · costume ${name}`,
        backdrop: (name: string) => `Stage · backdrop ${name}`,
        sound: (sprite: string, name: string) => `${sprite} · sound ${name}`,
        stageSound: (name: string) => `Stage · sound ${name}`
    },
    ja: {
        label: '作品フォルダ', loading: '読み込んでいます…', empty: 'このフォルダは空です。',
        failed: 'このフォルダを読み込めません。', denied: 'このフォルダを読む許可がありません。',
        separator: '、',
        marks: {added: '追加', modified: '変更', deleted: '削除', untracked: '未追跡'},
        project: '作品データ', manifest: '作品フォルダの目録', extensions: '埋め込み拡張の一覧',
        assetsDirectory: 'コスチュームと音のファイル', extensionsDirectory: '拡張のファイル',
        costume: (sprite: string, name: string) => `${sprite} のコスチューム ${name}`,
        backdrop: (name: string) => `ステージの背景 ${name}`,
        sound: (sprite: string, name: string) => `${sprite} の音 ${name}`,
        stageSound: (name: string) => `ステージの音 ${name}`
    }
};
const messagesFor = (locale = 'en') => locale.toLowerCase().startsWith('ja') ? messages.ja : messages.en;

/**
 * Describes the files of a project folder for `ProjectFolderExplorer`'s `descriptions`: the project, manifest and
 * extension files, and each asset file with the costumes and sounds that use it. `folder` is the project folder's
 * path inside the explorer's root ('' when the root is the project folder). Malformed entries are skipped.
 */
export function describeProjectFolder(project: Project, locale?: string, {manifest, folder = ''}: {
    manifest?: Json; folder?: string;
} = {}): Map<string, string> {
    const message = messagesFor(locale);
    const prefix = folder.replace(/^\/+|\/+$/gu, '');
    const at = (name: string) => prefix ? `${prefix}/${name}` : name;
    const assetsDirectory = isObject(manifest) && typeof manifest.assetsDirectory === 'string' && manifest.assetsDirectory ?
        manifest.assetsDirectory.replace(/^\/+|\/+$/gu, '') : 'assets';
    const extensions = isObject(manifest) && typeof manifest.embeddedExtensions === 'string' ?
        manifest.embeddedExtensions : 'embedded-extensions.json';
    const descriptions = new Map<string, string>([
        [at(projectFile), message.project],
        [at(manifestFile), message.manifest],
        [at(extensions), message.extensions],
        [at(assetsDirectory), message.assetsDirectory],
        [at('extensions'), message.extensionsDirectory]
    ]);
    const users = new Map<string, string[]>();
    for (const target of Array.isArray(project.targets) ? project.targets : []) {
        if (!isObject(target)) continue;
        const sprite = typeof target.name === 'string' ? target.name : '';
        for (const kind of ['costumes', 'sounds'] as const) {
            const entries = target[kind];
            if (!Array.isArray(entries)) continue;
            for (const entry of entries) {
                if (!isObject(entry) || typeof entry.assetId !== 'string' || typeof entry.dataFormat !== 'string') continue;
                const file = typeof entry.md5ext === 'string' ? entry.md5ext : `${entry.assetId}.${entry.dataFormat}`;
                const name = typeof entry.name === 'string' ? entry.name : '';
                const text = kind === 'costumes' ?
                    (target.isStage ? message.backdrop(name) : message.costume(sprite, name)) :
                    (target.isStage ? message.stageSound(name) : message.sound(sprite, name));
                const path = at(`${assetsDirectory}/${file}`);
                const list = users.get(path) ?? [];
                if (!list.includes(text)) list.push(text);
                users.set(path, list);
            }
        }
    }
    for (const [path, list] of users) descriptions.set(path, list.join(message.separator));
    return descriptions;
}

type Node = {name: string; path: string; kind: 'file' | 'directory' | 'error'; message?: string};
type Message = typeof messages.en;
const rootId = '/';
// '\0' cannot appear in a file name, so the error row never collides with a real entry.
const errorId = (parent: string) => `${parent}\0error`;
type IterableDirectory = FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>};

const failure = (error: unknown, message: Message) =>
    error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError') ?
        message.denied : message.failed;

const prefix = 'twpf-explorer';
// Colors come from the host's text color, so the tree follows light and dark themes.
const css = `.${prefix}{font:inherit;color:inherit}
.${prefix}-item{display:flex;align-items:baseline;gap:.4em;width:100%;box-sizing:border-box;margin:0;border:0;border-radius:3px;
padding-block:.15em;padding-inline-end:.4em;background:none;color:inherit;font:inherit;text-align:start;cursor:pointer;white-space:nowrap}
.${prefix}-item:hover{background:rgba(128,128,128,.12)}
.${prefix}-item[aria-selected="true"]{background:rgba(128,128,128,.24)}
.${prefix}-item:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
.${prefix}-caret{display:inline-block;width:1em;flex:none;text-align:center}
.${prefix}-name{overflow:hidden;text-overflow:ellipsis}
.${prefix}-mark{flex:none;font-size:.85em;padding:0 .3em;border:1px solid currentColor;border-radius:3px;opacity:.85}
.${prefix}-description{overflow:hidden;text-overflow:ellipsis;opacity:.7;font-size:.9em}
.${prefix}-status{opacity:.7;font-style:italic;padding-block:.15em}`;

const indent = (level: number) => ({paddingInlineStart: `${0.25 + level * 1.1}em`});

function Explorer({directory, locale, descriptions, marks, onOpen, label}: ProjectFolderExplorerProps) {
    const message = messagesFor(locale);
    const [handles] = React.useState(() => new Map<string, FileSystemDirectoryHandle>([[rootId, directory]]));
    const [rootLoaded, setRootLoaded] = React.useState(false);
    const collator = React.useMemo(() => new Intl.Collator(locale, {numeric: true, sensitivity: 'base'}), [locale]);

    const directoryAt = async (id: string) => {
        let handle = handles.get(id);
        if (handle) return handle;
        handle = directory;
        for (const name of id.split('/')) handle = await handle.getDirectoryHandle(name);
        handles.set(id, handle);
        return handle;
    };
    const tree = useTree<Node>({
        rootItemId: rootId,
        initialState: {expandedItems: [], selectedItems: [], focusedItem: null},
        getItemName: item => item.getItemData()?.name ?? '',
        isItemFolder: item => item.getItemData()?.kind === 'directory',
        createLoadingItemData: () => ({name: '', path: '', kind: 'file'}),
        onPrimaryAction: item => {
            const data = item.getItemData();
            if (data?.kind === 'file') onOpen?.({path: data.path, name: data.name, kind: 'file'});
        },
        onLoadedChildren: id => {if (id === rootId) setRootLoaded(true);},
        dataLoader: {
            getItem: async id => {
                if (id === rootId) return {name: directory.name, path: '', kind: 'directory'};
                const parts = id.split('/');
                const name = parts.pop()!;
                const parent = parts.length ? await directoryAt(parts.join('/')) : directory;
                try {
                    await parent.getDirectoryHandle(name);
                    return {name, path: id, kind: 'directory'};
                } catch {
                    await parent.getFileHandle(name);
                    return {name, path: id, kind: 'file'};
                }
            },
            getChildrenWithData: async id => {
                try {
                    const handle = await directoryAt(id);
                    const base = id === rootId ? '' : `${id}/`;
                    const nodes: Node[] = [];
                    for await (const entry of (handle as IterableDirectory).values()) {
                        if (entry.kind === 'directory' && entry.name === '.git') continue;
                        const path = base + entry.name;
                        if (entry.kind === 'directory') handles.set(path, entry as FileSystemDirectoryHandle);
                        nodes.push({name: entry.name, path, kind: entry.kind});
                    }
                    nodes.sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) ||
                        collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
                    return nodes.map(data => ({id: data.path, data}));
                } catch (error) {
                    return [{id: errorId(id), data: {name: failure(error, message), path: '', kind: 'error'}}];
                }
            }
        },
        features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature]
    });
    // The React 17 hook of Headless Tree 1.8.0 never marks the tree as mounted, unlike its React 18 hook, so every state
    // update and rebuild would wait forever. Marking it here also runs the rebuild that the hook queued on mount.
    React.useEffect(() => {
        tree.setMounted(true);
        return () => tree.setMounted(false);
    }, [tree]);

    const renderItem = (item: ItemInstance<Node>) => {
        const data = item.getItemData();
        const level = item.getItemMeta().level;
        const folder = item.isFolder();
        const expanded = folder && item.isExpanded();
        const mark = data && data.kind !== 'error' ? marks?.get(data.path) : undefined;
        const markLabel = mark ? message.marks[mark] : '';
        const description = data && data.kind !== 'error' ? descriptions?.get(data.path) : undefined;
        const accessibleName = [item.getItemName(), markLabel, description].filter(Boolean).join(message.separator);
        const rows = [
            <button {...item.getProps()} key={item.getId()} type="button" aria-label={accessibleName}
                className={`${prefix}-item${data?.kind === 'error' ? ` ${prefix}-error` : ''}`} style={indent(level)}
                data-path={data?.path}>
                <span className={`${prefix}-caret`} aria-hidden="true">{folder ? (expanded ? '▾' : '▸') : ''}</span>
                <span className={`${prefix}-name`}>{item.getItemName()}</span>
                {markLabel ? <span className={`${prefix}-mark`} aria-hidden="true">{markLabel}</span> : null}
                {description ? <span className={`${prefix}-description`} aria-hidden="true">{description}</span> : null}
            </button>
        ];
        if (expanded && item.isLoading()) {
            rows.push(<div key={`${item.getId()}\0loading`} className={`${prefix}-status`} role="status"
                style={indent(level + 1)}>{message.loading}</div>);
        }
        return rows;
    };
    const items = tree.getItems();
    return (
        <div className={prefix}>
            <style>{css}</style>
            <div {...tree.getContainerProps(label ?? message.label)}>
                {items.map(renderItem)}
            </div>
            {items.length ? null : (
                <div className={`${prefix}-status`} role="status">{rootLoaded ? message.empty : message.loading}</div>
            )}
        </div>
    );
}

let nextKey = 0;
const keys = new WeakMap<FileSystemDirectoryHandle, number>();
const keyFor = (directory: FileSystemDirectoryHandle) => {
    if (!keys.has(directory)) keys.set(directory, nextKey++);
    return keys.get(directory)!;
};

/**
 * A read-only tree of a folder for the Editor's side panel, built on Headless Tree. Folders load when expanded, folders
 * sort before files, and `.git` is hidden. Keyboard: arrow keys, Home and End move and expand; Enter or Space opens a
 * file. Needs React 16.14–18 from the host.
 */
export function ProjectFolderExplorer(props: ProjectFolderExplorerProps) {
    // A new directory starts a new tree, so cached entries and expanded folders never leak between folders.
    return <Explorer key={keyFor(props.directory)} {...props} />;
}
