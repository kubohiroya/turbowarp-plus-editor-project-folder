import assert from 'node:assert/strict';
import {test} from 'node:test';
import {describeProjectFolder} from '../dist/explorer.js';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), d = 'd'.repeat(32);
const asset = (id, name, format) => ({name, assetId: id, md5ext: `${id}.${format}`, dataFormat: format});
const project = () => ({targets: [
    {isStage: true, name: 'Stage', costumes: [asset(a, 'backdrop1', 'svg')], sounds: [asset(c, 'pop', 'wav')]},
    {isStage: false, name: 'Cat', costumes: [asset(b, 'cat-a', 'svg'), asset(a, 'plain', 'svg')], sounds: [asset(d, 'Meow', 'wav')]},
    {isStage: false, name: 'Dog', costumes: [asset(b, 'dog-a', 'svg')], sounds: [asset(c, 'pop', 'wav')]}
]});

test('describes the folder files and who uses each asset, in English', () => {
    assert.deepEqual(Object.fromEntries(describeProjectFolder(project(), 'en')), {
        'project.source.json': 'Project data',
        'sb3-source.json': 'Folder manifest',
        'embedded-extensions.json': 'Embedded extensions',
        assets: 'Costume and sound files',
        extensions: 'Extension files',
        [`assets/${a}.svg`]: 'Stage · backdrop backdrop1, Cat · costume plain',
        [`assets/${b}.svg`]: 'Cat · costume cat-a, Dog · costume dog-a',
        [`assets/${c}.wav`]: 'Stage · sound pop, Dog · sound pop',
        [`assets/${d}.wav`]: 'Cat · sound Meow'
    });
});

test('describes the folder in Japanese', () => {
    const descriptions = describeProjectFolder(project(), 'ja-JP');
    assert.equal(descriptions.get('project.source.json'), '作品データ');
    assert.equal(descriptions.get('sb3-source.json'), '作品フォルダの目録');
    assert.equal(descriptions.get('embedded-extensions.json'), '埋め込み拡張の一覧');
    assert.equal(descriptions.get(`assets/${a}.svg`), 'ステージの背景 backdrop1、Cat のコスチューム plain');
    assert.equal(descriptions.get(`assets/${b}.svg`), 'Cat のコスチューム cat-a、Dog のコスチューム dog-a');
    assert.equal(descriptions.get(`assets/${c}.wav`), 'ステージの音 pop、Dog の音 pop');
    assert.equal(descriptions.get(`assets/${d}.wav`), 'Cat の音 Meow');
});

test('uses English for other locales and the default', () => {
    assert.equal(describeProjectFolder(project()).get('project.source.json'), 'Project data');
    assert.equal(describeProjectFolder(project(), 'fr').get(`assets/${d}.wav`), 'Cat · sound Meow');
});

test('a user listed twice for the same asset is described once', () => {
    const value = project();
    value.targets[1].costumes.push(asset(b, 'cat-a', 'svg'));
    assert.equal(describeProjectFolder(value, 'en').get(`assets/${b}.svg`), 'Cat · costume cat-a, Dog · costume dog-a');
});

test('reads the asset directory from the manifest and places the folder under a path', () => {
    const descriptions = describeProjectFolder(project(), 'en', {
        manifest: {formatVersion: 1, assetsDirectory: 'media', embeddedExtensions: 'embedded-extensions.json'},
        folder: 'games/cat/'
    });
    assert.equal(descriptions.get('games/cat/project.source.json'), 'Project data');
    assert.equal(descriptions.get('games/cat/media'), 'Costume and sound files');
    assert.equal(descriptions.get(`games/cat/media/${d}.wav`), 'Cat · sound Meow');
    assert.equal(descriptions.has(`assets/${d}.wav`), false);
    assert.equal(describeProjectFolder(project(), 'en', {manifest: {}}).get(`assets/${d}.wav`), 'Cat · sound Meow');
});

test('skips malformed entries without failing', () => {
    const value = {targets: [{isStage: true, name: 'Stage', costumes: [null, {name: 'x'}], sounds: 'none'}]};
    assert.deepEqual([...describeProjectFolder(value, 'en').keys()],
        ['project.source.json', 'sb3-source.json', 'embedded-extensions.json', 'assets', 'extensions']);
});
