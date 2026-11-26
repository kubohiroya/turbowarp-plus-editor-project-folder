import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {mountProjectFolder, projectFolderActions} from '../dist/index.js';
import {parseExplorerState, readExplorerState, subscribeExplorerState} from '../dist/index.js';

const stringify = value => `${JSON.stringify(value, null, 2)}\n`;
const bytes = text => new TextEncoder().encode(text);
const md5 = data => createHash('md5').update(data).digest('hex');
const red = bytes('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red"/></svg>');
const costume = {name: 'backdrop', assetId: md5(red), md5ext: `${md5(red)}.svg`, dataFormat: 'svg'};
const project = () => ({targets: [{isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {},
    comments: {}, currentCostume: 0, costumes: [costume], sounds: [], volume: 100, layerOrder: 0, tempo: 60}],
monitors: [], extensions: [], meta: {semver: '3.0.0'}});

/** An in-memory project folder, with the `.tw-plus` directory the Editor creates when it saves. */
function folder(screenState) {
    let clock = 1_000;
    const entry = data => ({data, lastModified: clock++});
    const directories = new Map([
        ['', new Map([
            ['project.source.json', entry(bytes(stringify(project())))],
            ['embedded-extensions.json', entry(bytes(stringify({formatVersion: 1, extensions: []})))],
            ['sb3-source.json', entry(bytes(stringify({formatVersion: 1, project: 'project.source.json',
                embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets',
                archiveEntries: ['project.json', costume.md5ext]})))]
        ])],
        ['assets', new Map([[costume.md5ext, entry(red)]])]
    ]);
    if (screenState !== undefined) directories.set('.tw-plus', new Map([['workspace.json', entry(bytes(screenState))]]));
    const writes = [];
    let workspaceReads = 0;
    let workspaceWriters = 0;
    let blocked;
    let beforeWorkspaceCommit;
    const workspace = (path, name) => path === '.tw-plus' && name === 'workspace.json';
    const directory = path => ({
        kind: 'directory', name: path || 'Folder',
        async getFileHandle(name, options = {}) {
            const files = directories.get(path);
            if (!files.has(name)) {
                if (!options.create) throw new DOMException('missing', 'NotFoundError');
                files.set(name, entry(new Uint8Array()));
            }
            return {
                kind: 'file', name,
                async getFile() {
                    const file = files.get(name);
                    if (workspace(path, name) && blocked === 'metadata') throw new DOMException('File locked', 'NotReadableError');
                    const snapshot = new File([file.data], name, {lastModified: file.lastModified});
                    if (workspace(path, name)) {
                        const text = snapshot.text.bind(snapshot);
                        snapshot.text = async () => {
                            workspaceReads++;
                            if (blocked === 'contents') throw new DOMException('File locked', 'NotReadableError');
                            return text();
                        };
                    }
                    return snapshot;
                },
                async createWritable() {
                    if (workspace(path, name)) workspaceWriters++;
                    let pending = new Uint8Array();
                    return {
                        async write(data) {
                            pending = new Uint8Array(data);
                            if (workspace(path, name) && beforeWorkspaceCommit) {
                                const operation = beforeWorkspaceCommit;
                                beforeWorkspaceCommit = undefined;
                                operation();
                            }
                        },
                        async close() {
                            files.set(name, entry(pending));
                            writes.push(path ? `${path}/${name}` : name);
                        },
                        async abort() {}
                    };
                }
            };
        },
        async removeEntry(name) {directories.get(path).delete(name);},
        values: () => [...directories.get(path).keys()].map(name => ({kind: 'file', name}))[Symbol.iterator](),
        async getDirectoryHandle(name, options = {}) {
            if (path) throw new DOMException('missing', 'NotFoundError');
            if (!directories.has(name)) {
                if (!options.create) throw new DOMException('missing', 'NotFoundError');
                directories.set(name, new Map());
            }
            return directory(name);
        }
    });
    const read = () => {
        const file = directories.get('.tw-plus')?.get('workspace.json');
        return file && new TextDecoder().decode(file.data);
    };
    return {directory: directory(''), writes, read,
        get workspaceReads() {return workspaceReads;}, get workspaceWriters() {return workspaceWriters;},
        lock(where) {blocked = where;},
        onBeforeWorkspaceCommit(fn) {beforeWorkspaceCommit = fn;},
        replace(text, keepTimestamp = false) {
            const files = directories.get('.tw-plus');
            const previous = files.get('workspace.json');
            files.set('workspace.json', keepTimestamp ? {...previous, data: bytes(text)} : entry(bytes(text)));
        }
    };
}

/** The Editor's screen state as the workbench provides it, with the slices the test registers. */
function screenState() {
    const slices = new Map();
    let nextLoad;
    let time = 0;
    return {
        slices,
        prepared: [],
        prepareLoad(text) {this.prepared.push(text); nextLoad = text;},
        /** Called as the workbench calls a slice once the VM loaded the project. */
        finishLoad() {
            const state = nextLoad === undefined ? undefined : JSON.parse(nextLoad);
            nextLoad = undefined;
            for (const [key, slice] of slices) if (state && key in state.slices) slice.apply?.(state.slices[key]);
        },
        register(key, slice) {
            slices.set(key, slice);
            return () => slices.delete(key);
        },
        serialize() {
            const captured = Object.fromEntries([...slices].map(([key, slice]) => [key, slice.capture()])
                .filter(([, value]) => value !== undefined));
            return JSON.stringify({version: 1, savedAt: ++time, slices: {drawer: 'project', ...captured}});
        }
    };
}

function editor(screen, watch = false) {
    let scan;
    let observerSignal;
    let scheduled;
    let markedSaved = 0;
    const vmListeners = new Map();
    let state = project();
    const stage = {};
    const vm = {
        runtime: {
            storage: {AssetType: {ImageVector: {name: 'ImageVector'}}, addHelper() {},
                createAsset: (type, dataFormat, data) => ({assetId: md5(data), dataFormat, data})},
            get targets() {return state.targets.map(target => ({id: 'stage', isStage: true, isOriginal: true, getName: () => target.name}));},
            getTargetForStage: () => stage, on() {}, off() {}
        },
        on(event, listener) {vmListeners.set(event, listener);},
        off(event) {vmListeners.delete(event);},
        quit() {},
        async loadProject(text) {
            state = JSON.parse(text);
            // The workbench gives the slices their values after the VM finished loading.
            queueMicrotask(() => screen.finishLoad());
        },
        toJSON: () => JSON.stringify(state)
    };
    const status = {style: {}, dataset: {}, setAttribute() {}, remove() {}, isConnected: true, textContent: ''};
    const document = {
        defaultView: {showDirectoryPicker: () => assert.fail('Unexpected picker call'),
            FileSystemObserver: class {
                constructor(callback) {observerSignal = callback;}
                async observe() {}
                disconnect() {}
            },
            setTimeout: run => {scheduled = run; return 0;}, clearTimeout() {},
            setInterval: run => {scan = run; return 0;}, clearInterval() {}, addEventListener() {}, removeEventListener() {}},
        createElement: tag => tag === 'output' ? status : {style: {}, dataset: {}, setAttribute() {}, remove() {}, append() {},
            addEventListener() {}, children: []},
        addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', body: {append() {}}
    };
    const host = {isProjectDirty: () => false, beforeLoad() {}, onOpened() {},
        onSaved() {markedSaved++;}, screenState: screen};
    if (watch) host.blockReload = {isRunning: () => false, subscribe: () => () => {}, onApplied() {}};
    const mounted = mountProjectFolder({vm, document, host, autoReload: false});
    return {
        mounted,
        get markedSaved() {return markedSaved;},
        get status() {return status.textContent;},
        editTempo(tempo) {state.targets[0].tempo = tempo; vmListeners.get('PROJECT_CHANGED')?.();},
        async refresh() {scan(); await settle();},
        async observe() {observerSignal(); scheduled(); await settle();},
        async save() {
            projectFolderActions(vm).save();
            for (let index = 0; index < 50 && !status.textContent; index++) await new Promise(resolve => setImmediate(resolve));
            const text = status.textContent;
            status.textContent = '';
            return text;
        }
    };
}

const saved = (slices, savedAt = 1) => JSON.stringify({version: 1, savedAt, slices});
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a folder opens with the screen state it was saved with, including the tree of its explorer', async t => {
    const screen = screenState();
    const disk = folder(saved({drawer: 'project', projectFolder: {expanded: ['assets', '../outside', '.git'], selected: 'assets'}}));
    const app = editor(screen);
    t.after(() => app.mounted.dispose());
    const shown = [];
    const stop = subscribeExplorerState(disk.directory, state => shown.push(state));
    t.after(stop);
    assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');
    await settle();
    assert.deepEqual(screen.prepared, [disk.read()], 'the state is given to the next load before it starts');
    const tree = {expanded: ['assets'], selected: 'assets'};
    assert.deepEqual(readExplorerState(disk.directory), tree, 'paths outside the folder and hidden folders are dropped');
    assert.deepEqual(shown, [tree], 'a mounted explorer shows the tree');
});

test('a folder without a screen state opens with the default screen', async t => {
    const screen = screenState();
    const disk = folder();
    const app = editor(screen);
    t.after(() => app.mounted.dispose());
    assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');
    assert.deepEqual(screen.prepared, [undefined]);
});

test('saving writes the screen state into .tw-plus, but not when only the time of the save changed', async t => {
    const screen = screenState();
    const disk = folder();
    const app = editor(screen);
    t.after(() => app.mounted.dispose());
    assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');
    assert.equal(await app.save(), 'No changes to save.');
    assert.deepEqual(JSON.parse(disk.read()).slices, {drawer: 'project'});
    assert.deepEqual(disk.writes, ['.tw-plus/workspace.json'], 'an unchanged project still saves the screen');

    await app.save();
    assert.deepEqual(disk.writes, ['.tw-plus/workspace.json'], 'the same screen is not written again');

    screen.slices.get('projectFolder').capture = () => ({expanded: ['assets']});
    await app.save();
    assert.deepEqual(JSON.parse(disk.read()).slices.projectFolder, {expanded: ['assets']});
    assert.equal(disk.writes.length, 2);
});

test('only a well-formed tree is read from a file', () => {
    assert.deepEqual(parseExplorerState({expanded: ['a', 'a', 'a/b', '', '/abs', 'x/../y', 3], selected: 'a/b'}),
        {expanded: ['a', 'a/b'], selected: 'a/b'});
    assert.deepEqual(parseExplorerState({expanded: [], selected: '.tw-plus/workspace.json'}), {expanded: []});
    for (const value of [null, [], 'tree', {expanded: 'a'}]) assert.equal(parseExplorerState(value), undefined);
});

test('an external screen state is passed to the host once and a save sees changes before the next scan', async t => {
    const screen = screenState();
    const updates = [];
    screen.applyFolderUpdate = (previous, text) => {
        updates.push([previous, text]);
        return true;
    };
    const initial = saved({blockPalette: {stage: {groups: ['sound']}}});
    const disk = folder(initial);
    const app = editor(screen, true);
    t.after(() => app.mounted.dispose());
    assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');

    async function change(text) {
        const parent = await disk.directory.getDirectoryHandle('.tw-plus');
        const file = await parent.getFileHandle('workspace.json');
        const writable = await file.createWritable();
        await writable.write(bytes(text));
        await writable.close();
    }
    const changed = saved({blockPalette: {stage: {groups: ['looks']}}}, 2);
    await change(changed);
    await app.refresh();
    await app.refresh();
    assert.deepEqual(updates, [[initial, changed]]);
    const latest = saved({blockPalette: {stage: {groups: ['events']}}}, 3);
    await change(latest);
    await app.save();
    assert.deepEqual(updates, [[initial, changed], [changed, latest]]);
    await app.refresh();
    assert.equal(updates.length, 2, 'the Editor does not replay its own save');
});

test('an unchanged workspace only reads metadata, and a watch notification rechecks equal-sized content', async t => {
    const initial = saved({blockPalette: {stage: {groups: ['sound']}}});
    const changed = saved({blockPalette: {stage: {groups: ['looks']}}});
    assert.equal(initial.length, changed.length);
    const disk = folder(initial);
    const screen = screenState();
    const updates = [];
    screen.applyFolderUpdate = (before, next) => {updates.push([before, next]); return true;};
    const app = editor(screen, true);
    t.after(() => app.mounted.dispose());
    assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');
    await app.refresh();
    await app.refresh();
    assert.equal(disk.workspaceReads, 1);
    disk.replace(changed, true);
    await app.observe();
    assert.deepEqual(updates, [[initial, changed]]);
    assert.equal(disk.workspaceReads, 2);
});

for (const locked of ['metadata', 'contents']) {
    test(`a workspace lock during ${locked} defers only the workspace write and retries after unlock`, async t => {
        const initial = saved({drawer: 'project'});
        const latest = saved({drawer: 'project', blockPalette: {stage: {groups: ['looks']}}});
        const disk = folder(initial);
        const screen = screenState();
        const updates = [];
        let selected;
        screen.register('blockPalette', {capture: () => selected});
        screen.applyFolderUpdate = (before, next) => {
            updates.push([before, next]);
            selected = JSON.parse(next).slices.blockPalette;
            return true;
        };
        const app = editor(screen, true);
        t.after(() => app.mounted.dispose());
        assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');
        disk.replace(latest);
        disk.lock(locked);
        app.editTempo(80);
        assert.match(await app.save(), /^Project folder saved\. Workspace settings could not be saved yet/);
        assert.deepEqual(disk.writes, ['project.source.json']);
        assert.equal(disk.workspaceWriters, 0);
        assert.equal(app.markedSaved, 0);
        assert.deepEqual(updates, []);

        await app.refresh();
        assert.equal(disk.workspaceWriters, 0);
        disk.lock(undefined);
        await app.refresh();
        assert.deepEqual(updates, [[initial, latest]]);
        assert.equal(app.markedSaved, 1);
        assert.equal(app.status, 'Workspace settings saved.');
        assert.equal(disk.read(), latest);
    });
}

test('a workspace replace during the save is preserved and a newer edit waits for another Save', async t => {
    const initial = saved({drawer: 'old'});
    const concurrent = saved({drawer: 'external'});
    const disk = folder(initial);
    const screen = screenState();
    screen.applyFolderUpdate = () => true;
    const app = editor(screen, true);
    t.after(() => app.mounted.dispose());
    assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');
    disk.onBeforeWorkspaceCommit(() => disk.replace(concurrent));
    assert.match(await app.save(), /^Project data is unchanged\. Workspace settings could not be saved yet/);
    assert.equal(disk.read(), concurrent);
    assert.deepEqual(disk.writes, []);
    assert.equal(app.markedSaved, 0);

    app.editTempo(90);
    await app.refresh();
    assert.equal(disk.workspaceWriters, 1);
    assert.equal(disk.read(), concurrent);
    assert.equal(await app.save(), 'Project folder saved.');
    assert.equal(JSON.parse(disk.read()).slices.drawer, 'project');
    assert.equal(app.markedSaved, 1);
});
