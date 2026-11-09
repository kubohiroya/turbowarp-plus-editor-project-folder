import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FolderError, projectChanges} from '../src/source.ts';

const clone = value => structuredClone(value);
// Saved as JSON text; merged objects have no prototype.
const plain = value => value && JSON.parse(JSON.stringify(value));
const costume = (id, name) => ({name, assetId: id, md5ext: `${id}.svg`, dataFormat: 'svg', rotationCenterX: 0, rotationCenterY: 0});
const a = 'a'.repeat(32), b = 'b'.repeat(32);

// What the VM serializes after opening the folder.
const editorProject = () => ({
    targets: [
        {isStage: true, name: 'Stage', variables: {v1: ['score', 0]}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
            currentCostume: 0, costumes: [costume(a, 'backdrop1')], sounds: [], volume: 100, layerOrder: 0, tempo: 60},
        {isStage: false, name: 'Cat', variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
            currentCostume: 0, costumes: [costume(b, 'cat')], sounds: [], volume: 100, layerOrder: 1,
            visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around'}
    ],
    monitors: [],
    extensions: [],
    meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}
});
// The folder's file: its own key order and fields the Editor does not know.
const folderProject = () => {
    const project = editorProject();
    return {meta: project.meta, note: 'kept', targets: project.targets.map(target => ({...target, folderOnly: target.name,
        costumes: target.costumes.map(entry => ({...entry, folderOnly: true}))})), monitors: [], extensions: []};
};
const scope = error => error instanceof FolderError && error.code === 'unsupported';

test('saves run results and other non-block edits into the folder project, keeping unknown fields and order', () => {
    const before = editorProject();
    const after = clone(before);
    Object.assign(after.targets[1], {x: 120, y: -40, direction: 45, size: 150, visible: false, layerOrder: 2});
    after.targets[0].variables.v1 = ['score', 7];
    after.targets[0].variables.v2 = ['lives', 3];
    after.targets[1].costumes[0].name = 'cat-a';
    after.extensions = ['pen'];
    after.monitors = [{id: 'v1', mode: 'default', opcode: 'data_variable', params: {VARIABLE: 'score'}, spriteName: null,
        value: 7, width: 0, height: 0, x: 5, y: 5, visible: true}];
    const source = folderProject();
    const saved = plain(projectChanges(source, before, after));
    assert.deepEqual(Object.keys(saved), ['meta', 'note', 'targets', 'monitors', 'extensions']);
    assert.equal(saved.note, 'kept');
    const cat = saved.targets[1];
    assert.deepEqual({x: cat.x, y: cat.y, direction: cat.direction, size: cat.size, visible: cat.visible, layerOrder: cat.layerOrder},
        {x: 120, y: -40, direction: 45, size: 150, visible: false, layerOrder: 2});
    assert.equal(cat.folderOnly, 'Cat');
    assert.deepEqual(cat.costumes, [{...costume(b, 'cat-a'), folderOnly: true}]);
    assert.deepEqual(saved.targets[0].variables, {v1: ['score', 7], v2: ['lives', 3]});
    assert.deepEqual(saved.extensions, ['pen']);
    assert.equal(saved.monitors.length, 1);
    assert.deepEqual(source, folderProject(), 'the folder project read at open is not changed');
});

test('saves nothing without edits', () => {
    assert.equal(projectChanges(folderProject(), editorProject(), editorProject()), null);
});

test('keeps the folder target order unless the sprites were reordered', () => {
    const before = editorProject();
    before.targets.push({...clone(before.targets[1]), name: 'Dog'});
    const source = folderProject();
    source.targets.push({...clone(source.targets[1]), name: 'Dog', folderOnly: 'Dog'});
    const moved = clone(before);
    moved.targets[2].x = 9;
    assert.deepEqual(projectChanges(source, before, moved).targets.map(target => target.name), ['Stage', 'Cat', 'Dog']);
    const reordered = clone(before);
    reordered.targets = [reordered.targets[0], reordered.targets[2], reordered.targets[1]];
    assert.deepEqual(projectChanges(source, before, reordered).targets.map(target => target.name), ['Stage', 'Dog', 'Cat']);
});

test('matches sprites by runtime id: a rename keeps the folder entry, and sprites can be added and removed', () => {
    const before = editorProject();
    const ids = {before: ['s', 'c']};
    const renamed = clone(before);
    renamed.targets[1].name = 'Kitten';
    const saved = plain(projectChanges(folderProject(), before, renamed, {...ids, after: ['s', 'c']}));
    assert.deepEqual(saved.targets.map(target => [target.name, target.folderOnly]), [['Stage', 'Stage'], ['Kitten', 'Cat']]);
    const added = clone(before);
    added.targets.push({...clone(before.targets[1]), name: 'Dog', costumes: [costume('c'.repeat(32), 'dog')]});
    const withDog = plain(projectChanges(folderProject(), before, added, {...ids, after: ['s', 'c', 'd']}));
    assert.deepEqual(withDog.targets.map(target => target.name), ['Stage', 'Cat', 'Dog']);
    assert.equal(withDog.targets[2].folderOnly, undefined);
    const removed = clone(before);
    removed.targets.pop();
    assert.deepEqual(plain(projectChanges(folderProject(), before, removed, {...ids, after: ['s']})).targets.map(target => target.name), ['Stage']);
    // Without ids, a renamed sprite is a removed sprite and a new one.
    assert.equal(plain(projectChanges(folderProject(), before, renamed)).targets[1].folderOnly, undefined);
});

test('accepts new and removed costumes, and refuses unsupported assets and custom extensions', () => {
    const before = editorProject();
    const newCostume = clone(before);
    newCostume.targets[1].costumes.push(costume('c'.repeat(32), 'cat2'));
    assert.equal(plain(projectChanges(folderProject(), before, newCostume)).targets[1].costumes.length, 2);
    const removedCostume = clone(before);
    removedCostume.targets[0].costumes = [];
    assert.deepEqual(plain(projectChanges(folderProject(), before, removedCostume)).targets[0].costumes, []);
    const unsupportedFormat = clone(before);
    unsupportedFormat.targets[1].sounds.push({name: 'clip', assetId: 'd'.repeat(32), dataFormat: 'ogg', md5ext: `${'d'.repeat(32)}.ogg`});
    assert.throws(() => projectChanges(folderProject(), before, unsupportedFormat), scope);
    const custom = clone(before);
    custom.extensionURLs = {custom: 'https://example.invalid/custom.js'};
    assert.throws(() => projectChanges(folderProject(), before, custom), scope);
});

test('replaces a changed list whole when its items are not the same items in the folder', () => {
    const before = editorProject();
    before.monitors = [{id: 'm1', value: 1}, {id: 'm2', value: 2}];
    const source = folderProject();
    source.monitors = [{id: 'm2', value: 2, folderOnly: true}, {id: 'm1', value: 1}];
    const after = clone(before);
    after.monitors[0].value = 5;
    assert.deepEqual(plain(projectChanges(source, before, after)).monitors, after.monitors);
});
