import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {mountProjectFolder, projectFolderActions} from '../dist/index.js';

const stringify = value => `${JSON.stringify(value, null, 2)}\n`;
const md5 = data => createHash('md5').update(data).digest('hex');
const bytes = text => new TextEncoder().encode(text);
const svg = color => bytes(`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${color}"/></svg>`);
const reference = (name, data) => ({name, assetId: md5(data), md5ext: `${md5(data)}.svg`, dataFormat: 'svg'});
const red = svg('red'), blue = svg('blue'), green = svg('green');

// An in-memory folder with the File System Access calls the session uses.
function folder(project, assets) {
    let clock = 1_000;
    const entry = data => ({data, lastModified: clock++});
    const root = new Map([
        ['project.source.json', entry(bytes(stringify(project)))],
        ['embedded-extensions.json', entry(bytes(stringify({formatVersion: 1, extensions: []})))],
        ['sb3-source.json', entry(bytes(stringify({formatVersion: 1, project: 'project.source.json', note: 'kept',
            embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets',
            archiveEntries: ['project.json', ...assets.map(([name]) => name)]})))]
    ]);
    const assetFiles = new Map(assets.map(([name, data]) => [name, entry(data)]));
    const log = [];
    const failures = new Set();
    const directory = (files, prefix) => ({
        kind: 'directory',
        async getFileHandle(name, options = {}) {
            if (!files.has(name)) {
                if (!options.create) throw new DOMException('missing', 'NotFoundError');
                files.set(name, entry(new Uint8Array()));
            }
            return {
                kind: 'file', name,
                async getFile() {
                    const file = files.get(name);
                    if (!file) throw new DOMException('missing', 'NotFoundError');
                    return new File([file.data], name, {lastModified: file.lastModified});
                },
                async createWritable() {
                    let pending = new Uint8Array();
                    return {
                        async write(data) {pending = new Uint8Array(data);},
                        async close() {
                            if (failures.has(prefix + name)) throw new DOMException('failed', 'InvalidStateError');
                            files.set(name, entry(pending));
                            log.push(`write ${prefix}${name}`);
                        },
                        async abort() {}
                    };
                }
            };
        },
        async removeEntry(name) {
            files.delete(name);
            log.push(`remove ${prefix}${name}`);
        },
        values: () => [...files.keys()].map(name => ({kind: 'file', name}))[Symbol.iterator](),
        async getDirectoryHandle(name) {
            if (name === 'assets') return directory(assetFiles, 'assets/');
            if (name === 'extensions') return directory(new Map(), 'extensions/');
            throw new DOMException('missing', 'NotFoundError');
        }
    });
    const text = name => new TextDecoder().decode(root.get(name).data);
    return {directory: {...directory(root, ''), name: 'Folder'}, root, assetFiles, log, failures,
        project: () => JSON.parse(text('project.source.json')), manifest: () => JSON.parse(text('sb3-source.json'))};
}

function editor(initial, assetData) {
    let state = structuredClone(initial);
    const AssetType = {Sound: {name: 'Sound'}, ImageVector: {name: 'ImageVector'}, ImageBitmap: {name: 'ImageBitmap'}};
    const runtimeTargets = () => state.targets.map(target => ({
        id: target.runtimeId, isStage: target.isStage, isOriginal: true, getName: () => target.name,
        sprite: {costumes: (target.costumes ?? []).map(entry => ({asset: {assetId: entry.assetId, dataFormat: entry.dataFormat,
            data: assetData.get(entry.md5ext)}})), sounds: []}
    }));
    const stage = {};
    const vm = {
        runtime: {
            storage: {AssetType, addHelper() {},
                createAsset: (type, dataFormat, data) => ({assetId: md5(data), dataFormat, data})},
            get targets() {return runtimeTargets();},
            getTargetForStage: () => stage, on() {}, off() {}
        },
        on() {}, off() {}, quit() {},
        async loadProject(text) {
            state = JSON.parse(text);
            state.targets.forEach((target, index) => {target.runtimeId = `id${index}`;});
        },
        toJSON: () => JSON.stringify({...state, targets: state.targets.map(({runtimeId: _, ...target}) => target)})
    };
    const status = {style: {}, dataset: {}, setAttribute() {}, remove() {}, isConnected: true, textContent: ''};
    const document = {
        defaultView: {showDirectoryPicker: () => assert.fail('Unexpected picker call'), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
            addEventListener() {}, removeEventListener() {}},
        createElement: tag => tag === 'output' ? status : {style: {}, dataset: {}, setAttribute() {}, remove() {}, append() {},
            addEventListener() {}, children: []},
        addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
        body: {append() {}}
    };
    const host = {isProjectDirty: () => false, beforeLoad() {}, onOpened() {}, onSaved() {}};
    const mounted = mountProjectFolder({vm, document, host, autoReload: false});
    return {
        mounted, status,
        edit(change) {change(state.targets);},
        async save() {
            const before = status.textContent;
            projectFolderActions(vm).save();
            for (let index = 0; index < 50 && status.textContent === before; index++) await new Promise(resolve => setImmediate(resolve));
            const text = status.textContent;
            status.textContent = '';
            return text;
        }
    };
}

const sprite = (name, costumes, extra = {}) => ({isStage: false, name, variables: {}, lists: {}, broadcasts: {}, blocks: {},
    comments: {}, currentCostume: 0, costumes, sounds: [], volume: 100, layerOrder: 1, visible: true, x: 0, y: 0, size: 100,
    direction: 90, draggable: false, rotationStyle: 'all around', ...extra});
const initialProject = () => ({targets: [
    {isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {}, currentCostume: 0,
        costumes: [reference('backdrop', red)], sounds: [], volume: 100, layerOrder: 0, tempo: 60},
    sprite('Cat', [reference('cat', blue)], {folderOnly: 'Cat'})
], monitors: [], extensions: [], meta: {semver: '3.0.0'}});
const setup = async t => {
    const disk = folder(initialProject(), [[`${md5(red)}.svg`, red], [`${md5(blue)}.svg`, blue]]);
    const assetData = new Map([[`${md5(red)}.svg`, red], [`${md5(blue)}.svg`, blue], [`${md5(green)}.svg`, green]]);
    const app = editor(initialProject(), assetData);
    t.after(() => app.mounted.dispose());
    assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');
    return {disk, app};
};

test('a renamed sprite keeps its folder entry, and saving writes the project file only', async t => {
    const {disk, app} = await setup(t);
    app.edit(targets => {targets[1].name = 'Kitten';});
    assert.equal(await app.save(), 'Project folder saved.');
    assert.deepEqual(disk.log, ['write project.source.json']);
    assert.deepEqual(disk.project().targets.map(target => [target.name, target.folderOnly]), [['Stage', undefined], ['Kitten', 'Cat']]);
});

test('adds a sprite with a new costume: the asset first, then the manifest and the project file', async t => {
    const {disk, app} = await setup(t);
    app.edit(targets => targets.push({...sprite('Dog', [reference('dog', green)]), runtimeId: 'dog'}));
    assert.equal(await app.save(), 'Project folder saved.');
    const name = `${md5(green)}.svg`;
    assert.deepEqual(disk.log, [`write assets/${name}`, 'write sb3-source.json', 'write project.source.json']);
    assert.deepEqual(disk.assetFiles.get(name).data, green);
    assert.deepEqual(disk.manifest().archiveEntries, ['project.json', `${md5(red)}.svg`, `${md5(blue)}.svg`, name]);
    assert.equal(disk.manifest().note, 'kept');
    assert.deepEqual(disk.project().targets.map(target => target.name), ['Stage', 'Cat', 'Dog']);
    // Saved again without edits, nothing is written and no external change is reported.
    disk.log.length = 0;
    assert.equal(await app.save(), 'No changes to save.');
    assert.deepEqual(disk.log, []);
});

test('removes a sprite and deletes the asset nothing refers to after the project file is written', async t => {
    const {disk, app} = await setup(t);
    app.edit(targets => targets.pop());
    assert.equal(await app.save(), 'Project folder saved.');
    const name = `${md5(blue)}.svg`;
    assert.deepEqual(disk.log, ['write sb3-source.json', 'write project.source.json', `remove assets/${name}`]);
    assert.equal(disk.assetFiles.has(name), false);
    assert.deepEqual(disk.manifest().archiveEntries, ['project.json', `${md5(red)}.svg`]);
});

test('a failed project write puts the manifest back and removes the new asset', async t => {
    const {disk, app} = await setup(t);
    const manifest = disk.manifest();
    app.edit(targets => {targets[1].costumes.push(reference('cat2', green));});
    disk.failures.add('project.source.json');
    assert.match(await app.save(), /^Could not access the project folder/u);
    assert.equal(disk.assetFiles.has(`${md5(green)}.svg`), false);
    assert.deepEqual(disk.manifest(), manifest);
    assert.equal(disk.project().targets[1].costumes.length, 1);
    disk.failures.clear();
    disk.log.length = 0;
    assert.equal(await app.save(), 'Project folder saved.');
    assert.equal(disk.project().targets[1].costumes.length, 2);
});

test('refuses a new costume whose data the Editor does not have', async t => {
    const {disk, app} = await setup(t);
    const missing = svg('black');
    app.edit(targets => {targets[1].costumes.push(reference('ghost', missing));});
    assert.match(await app.save(), /^This project or edit cannot be saved to a project folder yet/u);
    assert.deepEqual(disk.log, []);
});
