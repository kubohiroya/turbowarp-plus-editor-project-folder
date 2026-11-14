import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProjectFolder, mountProjectFolder, projectFolderOverwriteWarning} from '../dist/index.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const notFound = () => new DOMException('Missing entry', 'NotFoundError');
const project = {targets: [{isStage: true, name: 'Stage', costumes: [], sounds: []}]};
const seed = new Map([
    ['project.source.json', bytes(project)],
    ['sb3-source.json', bytes({formatVersion: 1, project: 'project.source.json',
        embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets', archiveEntries: ['project.json']})],
    ['embedded-extensions.json', bytes({formatVersion: 1, extensions: []})]
]);
const readText = async (directory, name) => (await (await directory.getFileHandle(name)).getFile()).text();
async function writeText(directory, name, text) {
    const file = await directory.getFileHandle(name, {create: true});
    const writable = await file.createWritable();
    await writable.write(new TextEncoder().encode(text));
    await writable.close();
}

function memoryDirectory(name, onClose = () => {}) {
    const children = new Map();
    const handle = (child, kind, options, make) => {
        if (!children.has(child)) {
            if (!options?.create) throw notFound();
            children.set(child, make());
        }
        const entry = children.get(child);
        if (entry.kind !== kind) throw new DOMException('Wrong kind', 'TypeMismatchError');
        return entry;
    };
    return {
        children, name, kind: 'directory', values: () => children.values(), async isSameEntry(other) {return this === other;},
        async getDirectoryHandle(child, options) {return handle(child, 'directory', options, () => memoryDirectory(child, onClose));},
        async getFileHandle(child, options) {
            return handle(child, 'file', options, () => {
                let data = new Uint8Array();
                let revision = 0;
                return {
                    name: child, kind: 'file', async isSameEntry(other) {return this === other;},
                    async getFile() {return new File([data], child, {lastModified: revision});},
                    async createWritable() {
                        let next;
                        return {async write(value) {next = value;}, async abort() {},
                            async close() {onClose(child); data = next; revision++;}};
                    }
                };
            });
        },
        async removeEntry(child) {
            if (children.get(child)?.children?.size) throw new DOMException('Not empty', 'InvalidModificationError');
            children.delete(child);
        }
    };
}

test('creating an empty v1 project attaches it for subsequent saves with absent empty directories', async t => {
    const directory = memoryDirectory('created');
    const stage = {};
    const storage = {addHelper() {}};
    let state = project;
    let opened = 0;
    let saved = 0;
    const vm = {
        runtime: {storage, getTargetForStage: () => stage, on() {}, off() {}},
        on() {}, off() {}, quit() {}, toJSON: () => JSON.stringify(state),
        async loadProject(text) {state = JSON.parse(text);}
    };
    const document = {
        defaultView: {showDirectoryPicker: async () => directory, clearTimeout() {}},
        body: {append() {}}, createElement: () => ({dataset: {}, style: {}, setAttribute() {}, remove() {}})
    };
    const folder = mountProjectFolder({vm, document, host: {
        isProjectDirty: () => true, beforeLoad() {}, onOpened() {opened++;}, onSaved() {saved++;}
    }});
    t.after(() => folder.dispose());
    assert.equal(await folder.createFromSnapshot({prepareFiles: async () => seed}), 'opened');
    assert.equal(folder.directory, directory);
    assert.equal(opened, 1);
    assert.equal(directory.children.has('assets'), false);
    assert.equal(directory.children.has('extensions'), false);

    state = {targets: [{...project.targets[0], volume: 42}]};
    assert.equal((await folder.save()).status, 'saved');
    assert.equal(saved, 1);
    const file = await (await directory.getFileHandle('project.source.json')).getFile();
    assert.equal(JSON.parse(await file.text()).targets[0].volume, 42);
});

test('rejects nonempty destinations and invalid paths, and rolls back files after a partial write', async () => {
    const storage = {};
    const nonempty = memoryDirectory('nonempty');
    await nonempty.getFileHandle('keep.txt', {create: true});
    await assert.rejects(createProjectFolder({directory: nonempty, files: seed, storage}), {code: 'directoryNotEmpty'});
    assert.deepEqual([...nonempty.children.keys()], ['keep.txt']);

    const invalid = memoryDirectory('invalid');
    await assert.rejects(createProjectFolder({directory: invalid, storage,
        files: new Map([...seed, ['../escape.txt', bytes(null)]])}), {code: 'unsupported'});
    assert.equal(invalid.children.size, 0);

    const interrupted = memoryDirectory('interrupted', name => {
        if (name === 'project.source.json') throw new Error('write failed');
    });
    await assert.rejects(createProjectFolder({directory: interrupted, files: seed, storage}), /write failed/);
    assert.equal(interrupted.children.size, 0);
});

test('confirmed overwrite replaces the project files and keeps unrelated root entries', async () => {
    const directory = memoryDirectory('existing');
    await writeText(directory, 'keep.txt', 'Keep this file');
    await writeText(directory, 'project.source.json', 'old project');
    await writeText(directory, 'extensions', 'file where the extensions directory goes');
    const assets = await directory.getDirectoryHandle('assets', {create: true});
    await writeText(assets, 'old.svg', 'old asset');
    const stale = await assets.getDirectoryHandle('old', {create: true});
    await writeText(stale, 'nested.svg', 'nested asset');

    const source = await createProjectFolder({directory, files: seed, storage: {}, overwrite: true});
    assert.deepEqual(source.project, project);
    assert.equal(await readText(directory, 'keep.txt'), 'Keep this file');
    assert.deepEqual(JSON.parse(await readText(directory, 'project.source.json')), project);
    assert.equal(directory.children.has('extensions'), false);
    assert.equal(assets.children.size, 0);
});

test('declining the Japanese overwrite prompt leaves the folder and the current project untouched', async t => {
    const directory = memoryDirectory('existing');
    await writeText(directory, 'project.source.json', 'old project');
    const vm = {runtime: {storage: {}, getTargetForStage: () => stage, on() {}, off() {}}, on() {}, off() {}};
    const stage = {};
    const document = {
        defaultView: {showDirectoryPicker: async () => directory, clearTimeout() {}, confirm(message) {
            assert.equal(message, '指定されたフォルダは空ではありません。フォルダに保存されている内容が上書きされる場合があります。よろしいですか？');
            return false;
        }},
        body: {append() {}}, createElement: () => ({dataset: {}, style: {}, setAttribute() {}, remove() {}})
    };
    const folder = mountProjectFolder({vm, document, locale: 'ja', host: {}});
    t.after(() => folder.dispose());
    assert.equal(projectFolderOverwriteWarning('ja'), '指定されたフォルダに保存されている内容は上書きされます');
    assert.equal(await folder.createFromSnapshot({prepareFiles: async () => assert.fail('Cancelled before preparing the snapshot')}), 'cancelled');
    assert.equal(await readText(directory, 'project.source.json'), 'old project');
    assert.equal(folder.directory, null);
});

test('failed overwrite restores replaced project files and removed source entries', async () => {
    let interrupted = false;
    const directory = memoryDirectory('interrupted', name => {
        if (interrupted && name === 'project.source.json') throw new Error('write failed');
    });
    await writeText(directory, 'project.source.json', 'old project');
    await writeText(directory, 'sb3-source.json', 'old manifest');
    const assets = await directory.getDirectoryHandle('assets', {create: true});
    const stale = await assets.getDirectoryHandle('old', {create: true});
    await writeText(stale, 'nested.svg', 'nested asset');
    interrupted = true;

    await assert.rejects(createProjectFolder({directory, files: seed, storage: {}, overwrite: true}), /write failed/);
    assert.equal(await readText(directory, 'project.source.json'), 'old project');
    assert.equal(await readText(directory, 'sb3-source.json'), 'old manifest');
    assert.equal(await readText(await assets.getDirectoryHandle('old'), 'nested.svg'), 'nested asset');
    assert.equal(directory.children.has('embedded-extensions.json'), false);
});
