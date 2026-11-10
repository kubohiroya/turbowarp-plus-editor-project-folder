import * as React from 'react';
import {asyncDataLoaderFeature, hotkeysCoreFeature, selectionFeature} from '@headless-tree/core';
import type {ItemInstance} from '@headless-tree/core';
import {useTree} from '@headless-tree/react/react17';
import {isObject, manifestFile, projectFile} from './source.js';
import {followProjectFolder} from './folder-registry.js';
import type {FollowedFolder} from './folder-registry.js';
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
        noFolder: 'Open a project folder to show its files here.', open: 'Open Project Folder…',
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
        noFolder: 'プロジェクトフォルダを開くと、ここにファイルを表示します。', open: 'プロジェクトフォルダを開く…',
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
.${prefix}-item{display:flex;align-items:center;gap:.4em;width:100%;box-sizing:border-box;margin:0;border:0;border-radius:3px;
padding-block:.15em;padding-inline-end:.4em;background:none;color:inherit;font:inherit;text-align:start;cursor:pointer;white-space:nowrap}
.${prefix}-item:hover{background:rgba(128,128,128,.12)}
.${prefix}-item[aria-selected="true"]{background:rgba(128,128,128,.24)}
.${prefix}-item:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
.${prefix}-caret{display:inline-block;width:1em;flex:none;text-align:center}
.${prefix}-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none}
.${prefix}-icon img{width:20px;height:20px;object-fit:contain;border-radius:2px;
background:repeating-conic-gradient(rgba(128,128,128,.22) 0 25%,transparent 0 50%) 0 0/8px 8px}
.${prefix}-icon img[hidden]{display:none}
.${prefix}-name{overflow:hidden;text-overflow:ellipsis}
.${prefix}-mark{flex:none;font-size:.85em;padding:0 .3em;border:1px solid currentColor;border-radius:3px;opacity:.85}
.${prefix}-description{overflow:hidden;text-overflow:ellipsis;opacity:.7;font-size:.9em}
.${prefix}-status{opacity:.7;font-style:italic;padding-block:.15em}
.${prefix}-empty{padding:.5em}
.${prefix}-empty p{margin:0 0 .6em}
.${prefix}-empty button{color:inherit;background:transparent;border:1px solid currentColor;border-radius:4px;padding:.2em .6em;font:inherit;cursor:pointer}`;

const indent = (level: number) => ({paddingInlineStart: `${0.25 + level * 1.1}em`});

type IconKind = 'folder' | 'folder-open' | 'project' | 'json' | 'image' | 'sound' | 'code' | 'text' | 'file';
const page = 'M3.5 1.5h6l3 3v10h-9z';
const corner = 'M9.5 1.5v3h3';
// 16px outlines drawn with currentColor, so they follow the host's text color.
const icons: Record<IconKind, string[]> = {
    'folder': ['M1.5 3.5h4l1.5 1.5h7.5v8h-13z'],
    'folder-open': ['M1.5 13V3.5h4l1.5 1.5h6v2', 'M1.5 13l2-6h11l-2 6z'],
    'project': ['M8 1.5l6 3v7l-6 3-6-3v-7z', 'M2 4.5l6 3 6-3', 'M8 7.5v7'],
    'json': [page, corner, 'M7 7c-1 0-1 .6-1 1.4s-.3 1.1-.8 1.1c.5 0 .8.4.8 1.1S6 12 7 12',
        'M9 7c1 0 1 .6 1 1.4s.3 1.1.8 1.1c-.5 0-.8.4-.8 1.1S10 12 9 12'],
    'image': ['M1.5 2.5h13v11h-13z', 'M1.5 11l4-4 3 3 2-2 4 4', 'M12.2 5.5a1.2 1.2 0 1 1-2.4 0a1.2 1.2 0 1 1 2.4 0'],
    'sound': ['M2 6h3l3.5-3v10L5 10H2z', 'M10.5 5.5a3.5 3.5 0 0 1 0 5', 'M12.5 3.5a6.5 6.5 0 0 1 0 9'],
    'code': ['M5.5 4.5L2 8l3.5 3.5', 'M10.5 4.5L14 8l-3.5 3.5', 'M9 3l-2 10'],
    'text': [page, corner, 'M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3'],
    'file': [page, corner]
};
const extensionIcons: Record<string, IconKind> = {
    json: 'json', svg: 'image', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', webp: 'image',
    wav: 'sound', mp3: 'sound', ogg: 'sound', js: 'code', mjs: 'code', ts: 'code', md: 'text', txt: 'text'
};
const iconFor = (name: string): IconKind => name === projectFile || name === manifestFile ? 'project' :
    extensionIcons[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'file';
// Larger images are left as icons: decoding them for a 20px preview costs more than it shows.
const thumbnailLimit = 2 * 1024 * 1024;
type Thumbnail = 'waiting' | 'loading' | 'loaded' | 'skipped' | 'failed';

function Icon({kind, path, readFile}: {kind: IconKind; path: string; readFile?: (path: string) => Promise<File>}) {
    const ref = React.useRef<HTMLSpanElement>(null);
    const [state, setState] = React.useState<Thumbnail>('waiting');
    const [url, setUrl] = React.useState<string>();
    // A row keeps its path for its lifetime (rows are keyed by path, and a new directory remounts the tree).
    React.useEffect(() => {
        if (!readFile) return undefined;
        let live = true;
        let created: string | undefined;
        const load = async () => {
            setState('loading');
            try {
                const file = await readFile(path);
                if (!live) return;
                if (file.size > thumbnailLimit) return setState('skipped');
                created = URL.createObjectURL(file);
                setUrl(created);
            } catch {
                if (live) setState('failed');
            }
        };
        // Only rows that are shown read their file, so a large assets folder does not read every image at once.
        let observer: IntersectionObserver | undefined;
        if (typeof IntersectionObserver === 'function' && ref.current) {
            observer = new IntersectionObserver(entries => {
                if (!entries.some(entry => entry.isIntersecting)) return;
                observer?.disconnect();
                void load();
            });
            observer.observe(ref.current);
        } else {
            void load();
        }
        return () => {
            live = false;
            observer?.disconnect();
            if (created) URL.revokeObjectURL(created);
        };
    }, [path]);
    return (
        <span ref={ref} className={`${prefix}-icon`} aria-hidden="true" data-icon={kind}
            data-thumbnail={readFile ? state : undefined}>
            {state === 'loaded' ? null : (
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2"
                    strokeLinecap="round" strokeLinejoin="round" focusable="false">
                    {icons[kind].map(d => <path key={d} d={d} />)}
                </svg>
            )}
            {/* An <img> never runs an SVG's scripts, unlike markup inserted into the page. */}
            {url && state !== 'failed' ? (
                <img src={url} alt="" decoding="async" hidden={state !== 'loaded'}
                    onLoad={() => setState('loaded')} onError={() => setState('failed')} />
            ) : null}
        </span>
    );
}

function Explorer({directory, locale, descriptions, marks, onOpen, label}: ProjectFolderExplorerProps) {
    const message = messagesFor(locale);
    const [handles] = React.useState(() => new Map<string, FileSystemDirectoryHandle>([[rootId, directory]]));
    const [files] = React.useState(() => new Map<string, FileSystemFileHandle>());
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
    const readFile = async (path: string) => {
        let handle = files.get(path);
        if (!handle) {
            const parts = path.split('/');
            const name = parts.pop()!;
            handle = await (parts.length ? await directoryAt(parts.join('/')) : directory).getFileHandle(name);
        }
        return handle.getFile();
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
                        else files.set(path, entry as FileSystemFileHandle);
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
        const icon = !data || data.kind === 'error' ? undefined :
            folder ? (expanded ? 'folder-open' : 'folder') : iconFor(data.name);
        const accessibleName = [item.getItemName(), markLabel, description].filter(Boolean).join(message.separator);
        const rows = [
            <button {...item.getProps()} key={item.getId()} type="button" aria-label={accessibleName}
                className={`${prefix}-item${data?.kind === 'error' ? ` ${prefix}-error` : ''}`} style={indent(level)}
                data-path={data?.path}>
                <span className={`${prefix}-caret`} aria-hidden="true">{folder ? (expanded ? '▾' : '▸') : ''}</span>
                {icon ? <Icon kind={icon} path={data!.path} readFile={icon === 'image' ? readFile : undefined} /> : null}
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

/** Follows marks for the files under `directory`, by path relative to it. Returns the function that stops it. */
export type FollowMarks = (directory: FileSystemDirectoryHandle,
    update: (marks: ReadonlyMap<string, ExplorerMark>) => void) => () => void;
type FolderViewProps = {vm: object; locale?: string; marks?: FollowMarks};

const readJson = async (directory: FileSystemDirectoryHandle, name: string): Promise<Json> =>
    JSON.parse(await (await (await directory.getFileHandle(name)).getFile()).text());

function FolderView({vm, locale, marks: followMarks}: FolderViewProps) {
    const message = messagesFor(locale);
    const [{folder, directory, version}, setFollowed] = React.useState<{
        folder?: FollowedFolder; directory: FileSystemDirectoryHandle | null; version: number;
    }>({directory: null, version: 0});
    React.useEffect(() => followProjectFolder(vm, (folder, directory) =>
        setFollowed(previous => ({folder, directory, version: previous.version + 1}))), [vm]);
    // The descriptions come from the folder's project file as last saved, read again after each save.
    const [descriptions, setDescriptions] = React.useState<ReadonlyMap<string, string>>();
    React.useEffect(() => {
        let current = true;
        setDescriptions(undefined);
        if (!directory) return;
        Promise.all([readJson(directory, projectFile), readJson(directory, manifestFile).catch(() => undefined)]).then(([project, manifest]) => {
            if (current && isObject(project)) setDescriptions(describeProjectFolder(project as Project, locale, {manifest}));
        }, () => {});
        return () => {current = false;};
    }, [directory, version, locale]);
    const [marks, setMarks] = React.useState<ReadonlyMap<string, ExplorerMark>>();
    React.useEffect(() => {
        setMarks(undefined);
        if (!directory || !followMarks) return;
        return followMarks(directory, setMarks);
    }, [directory, followMarks]);
    if (!folder) return null;
    if (!directory) {
        return <div className={`${prefix}-empty`}>
            <style>{css}</style>
            <p>{message.noFolder}</p>
            <button type="button" onClick={() => folder.open(locale ?? 'en')}>{message.open}</button>
        </div>;
    }
    return <ProjectFolderExplorer directory={directory} locale={locale} descriptions={descriptions} marks={marks}/>;
}

/**
 * Renders the explorer of the project folder open for `vm`, for a side panel of the host: its files with what each is
 * for, and `marks` (such as the Git status) when given. It follows the folder as it opens, closes and saves; with no
 * folder open it offers Open Project Folder…, and it renders nothing while no project folder is mounted for `vm`.
 * Pass the same `marks` function across renders, or the marks are followed again.
 */
export function renderProjectFolderExplorer(createElement: (component: any, props: any, ...children: any[]) => any,
    {vm, locale = 'en', marks}: FolderViewProps) {
    return createElement(FolderView, {vm, locale, marks});
}
