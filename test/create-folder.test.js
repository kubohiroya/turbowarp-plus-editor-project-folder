import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProjectFolder, mountProjectFolder} from '../dist/index.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const notFound = () => new DOMException('Missing entry', 'NotFoundError');
const project = {targets: [{isStage: true, name: 'Stage', costumes: [], sounds: []}]};
const seed = new Map([
    ['project.source.json', bytes(project)],
    ['sb3-source.json', bytes({formatVersion: 1, project: 'project.source.json',
        embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets', archiveEntries: ['project.json']})],
    ['embedded-extensions.json', bytes({formatVersion: 1, extensions: []})]
]);

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
    await assert.rejects(createProjectFolder({directory: nonempty, files: seed, storage}), {code: 'conflict'});
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
