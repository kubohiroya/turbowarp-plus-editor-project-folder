import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {extensionIntegrity, importSb3} from '@kubohiroya/sb3-toolchain';
import {blockPaletteCommentReference, formatBlockPaletteComment} from '@kubohiroya/sb3-toolchain/browser';
import {followProjectFolder, mountProjectFolder, projectFolderActions} from '../dist/index.js';

const stringify = value => `${JSON.stringify(value, null, 2)}\n`;
const md5 = data => createHash('md5').update(data).digest('hex');
const bytes = text => new TextEncoder().encode(text);
const svg = color => bytes(`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${color}"/></svg>`);
const reference = (name, data) => ({name, assetId: md5(data), md5ext: `${md5(data)}.svg`, dataFormat: 'svg'});
const red = svg('red'), blue = svg('blue'), green = svg('green');

// An in-memory folder with the File System Access calls the session uses.
function folder(project, assets, {embedded = {formatVersion: 1, extensions: []}, scripts = [], palette, manifest = {}} = {}) {
    let clock = 1_000;
    const entry = data => ({data, lastModified: clock++});
    const root = new Map([
        ['project.source.json', entry(bytes(stringify(project)))],
        ['embedded-extensions.json', entry(bytes(stringify(embedded)))],
        ['sb3-source.json', entry(bytes(stringify({formatVersion: palette ? 2 : 1, project: 'project.source.json', note: 'kept',
            embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets',
            archiveEntries: ['project.json', ...assets.map(([name]) => name)],
            ...palette ? {blockPalette: 'block-palette.json'} : {}, ...manifest})))]
    ]);
    if (palette) root.set('block-palette.json', entry(bytes(stringify(palette))));
    const assetFiles = new Map(assets.map(([name, data]) => [name, entry(data)]));
    const extensionFiles = new Map(scripts.map(([name, data]) => [name, entry(data)]));
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
            if (name === 'extensions') return directory(extensionFiles, 'extensions/');
            throw new DOMException('missing', 'NotFoundError');
        }
    });
    const text = name => new TextDecoder().decode(root.get(name).data);
    return {directory: {...directory(root, ''), name: 'Folder'}, root, assetFiles, extensionFiles, log, failures,
        project: () => JSON.parse(text('project.source.json')), manifest: () => JSON.parse(text('sb3-source.json')),
        palette: () => root.has('block-palette.json') ? JSON.parse(text('block-palette.json')) : null,
        embedded: () => JSON.parse(text('embedded-extensions.json'))};
}

function editor(initial, assetData) {
    let state = structuredClone(initial);
    const AssetType = {Sound: {name: 'Sound'}, ImageVector: {name: 'ImageVector'}, ImageBitmap: {name: 'ImageBitmap'},
        Font: {name: 'Font'}};
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
        get assets() {
            return (state.customFonts ?? []).filter(font => !font.system && typeof font.md5ext === 'string').map(font => {
                const [assetId, dataFormat] = font.md5ext.split('.');
                return {assetId, dataFormat, data: assetData.get(font.md5ext)};
            });
        },
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
        mounted, status, vm,
        edit(change) {change(state.targets);},
        editProject(change) {change(state);},
        snapshot() {return JSON.parse(vm.toJSON());},
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

test('saves system, web and file fonts alongside embedded and remote extensions', async t => {
    const project = initialProject();
    const first = bytes('first font file'), next = bytes('next font file');
    const firstName = `${md5(first)}.ttf`, nextName = `${md5(next)}.woff2`;
    const system = {system: true, family: 'A System Font', fallback: 'Sans Serif'};
    const web = {system: true, family: 'Roboto Mono', fallback: 'Serif',
        webFont: {provider: 'google-fonts', id: 'roboto-mono'}};
    const firstFile = {system: false, family: 'First Font', fallback: 'Sans Serif', md5ext: firstName};
    const nextFile = {system: false, family: 'Next Font', fallback: 'Serif', md5ext: nextName};
    const legacy = {system: false, family: 'Legacy without asset', fallback: 'Serif'};
    project.customFonts = [system, web, firstFile, legacy];
    project.extensions = ['embedded', 'remote'];
    project.extensionURLs = {embedded: 'embedded-extension:extensions/embedded.js', remote: 'https://example.org/remote.js'};
    const script = bytes('Scratch.extensions.register({});\n');
    const embedded = {formatVersion: 1, extensions: [
        {id: 'embedded', path: 'extensions/embedded.js', mediaType: 'text/javascript', parameters: [], encoding: 'base64'}
    ]};
    const disk = folder(project, [[`${md5(red)}.svg`, red], [`${md5(blue)}.svg`, blue], [firstName, first]], {
        embedded, scripts: [['embedded.js', script]]
    });
    const {mounted, edit, editProject, save, snapshot} = editor(project, new Map([[firstName, first], [nextName, next]]));
    t.after(() => mounted.dispose());
    assert.equal(await mounted.openDirectory(disk.directory, () => true), 'opened');
    assert.equal(snapshot().extensionURLs.embedded, `data:text/javascript;base64,${Buffer.from(script).toString('base64')}`);

    edit(targets => {targets[1].name = 'Kitten';});
    await save();
    assert.deepEqual(disk.project().customFonts, [system, web, firstFile, legacy]);
    assert.deepEqual(disk.assetFiles.get(firstName).data, first);
    assert.ok(disk.manifest().archiveEntries.includes(firstName));

    editProject(state => {state.customFonts = [system, web, nextFile, legacy];});
    await save();
    assert.deepEqual(disk.project().customFonts, [system, web, nextFile, legacy]);
    assert.deepEqual(disk.assetFiles.get(nextName).data, next);
    assert.ok(disk.manifest().archiveEntries.includes(nextName));
    assert.ok(!disk.assetFiles.has(firstName));
    assert.ok(!disk.manifest().archiveEntries.includes(firstName));
    assert.deepEqual(disk.project().extensionURLs, project.extensionURLs);
    assert.deepEqual(disk.embedded(), embedded);
    assert.deepEqual(disk.extensionFiles.get('embedded.js').data, script);
});

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
    let folder;
    t.after(followProjectFolder(app.vm, current => {folder = current;}));
    const manifest = disk.manifest();
    app.edit(targets => {targets[1].costumes.push(reference('cat2', green));});
    const pending = new Set(['project.source.json', 'sb3-source.json', `assets/${md5(green)}.svg`]);
    assert.deepEqual(folder.unsavedPaths(), pending);
    disk.failures.add('project.source.json');
    assert.match(await app.save(), /^Could not access the project folder/u);
    assert.equal(disk.assetFiles.has(`${md5(green)}.svg`), false);
    assert.deepEqual(disk.manifest(), manifest);
    assert.equal(disk.project().targets[1].costumes.length, 1);
    assert.deepEqual(folder.unsavedPaths(), pending);
    disk.failures.clear();
    disk.log.length = 0;
    assert.equal(await app.save(), 'Project folder saved.');
    assert.equal(disk.project().targets[1].costumes.length, 2);
    assert.deepEqual(folder.unsavedPaths(), new Set());
});

test('refuses a new costume whose data the Editor does not have', async t => {
    const {disk, app} = await setup(t);
    const missing = svg('black');
    app.edit(targets => {targets[1].costumes.push(reference('ghost', missing));});
    assert.match(await app.save(), /^This project or edit cannot be saved to a project folder yet/u);
    assert.deepEqual(disk.log, []);
});

const extension = (id, value = '元') => bytes(`// Name: ${id}\n// ID: ${id}\n// By: Fixture\n// Description: Test extension\n// License: MPL-2.0\n` +
    (id === 'second' ? '// Unsandboxed: optional\n' : '') +
    `Scratch.extensions.register(new class { getInfo() { return {id: '${id}', name: '${id}', blocks: []}; } value() { return '${value}'; } });\n`);
const ref = id => `embedded-extension:extensions/${id}.js`;
const dataUrl = data => `data:text/javascript;base64,${Buffer.from(data).toString('base64')}`;
const percentUrl = data => `data:text/javascript;charset=utf-8,${Array.from(data, byte =>
    `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('')}`;
const toolchain = createRequire(import.meta.url).resolve('@kubohiroya/sb3-toolchain/package.json');
const cli = join(dirname(toolchain), 'dist', 'bin.js');

test('saves embedded and remote extensions with toolchain-compatible metadata and rollback', async t => {
    const ids = ['first', 'second', 'stable'];
    const scripts = new Map(ids.map(id => [`${id}.js`, extension(id)]));
    const api = bytes(stringify({formatVersion: 1, id: 'first', blocks: [], menus: []}));
    scripts.set('first.manifest.json', api);
    const remote = 'https://example.invalid/custom.js';
    const project = initialProject();
    project.extensions = [...ids, 'remote'];
    project.extensionURLs = {...Object.fromEntries(ids.map(id => [id, ref(id)])), remote};
    const embedded = {formatVersion: 1, extensions: ids.map(id => ({
        id, path: `extensions/${id}.js`, mediaType: 'text/javascript', parameters: id === 'second' ? ['charset=utf-8'] : [],
        encoding: id === 'second' ? 'percent' : 'base64',
        ...(id === 'second' ? {} : {source: {provider: 'github', repository: 'owner/extensions', ref: 'main',
            resolvedCommit: 'a'.repeat(40), artifact: `${id}.js`, integrity: extensionIntegrity(scripts.get(`${id}.js`)),
            ...(id === 'first' ? {apiManifest: {artifact: 'manifest.json', path: 'extensions/first.manifest.json',
                formatVersion: 1, integrity: extensionIntegrity(api)}} : {})}})
    })), extensionBundles: [{id: 'bundle', name: 'Bundle', members: ids, recoveryCapsule: true,
        sandboxedNotice: {en: 'The second extension has limited sandbox functionality.'}}]};
    const assets = [[`${md5(red)}.svg`, red], [`${md5(blue)}.svg`, blue]];
    const disk = folder(project, assets, {embedded, scripts: [...scripts]});
    const app = editor(project, new Map(assets));
    t.after(() => app.mounted.dispose());
    assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');
    assert.deepEqual(app.snapshot().extensionURLs, {
        first: dataUrl(scripts.get('first.js')), second: percentUrl(scripts.get('second.js')),
        stable: dataUrl(scripts.get('stable.js')), remote
    });
    const initialManifest = disk.root.get('embedded-extensions.json');
    const untouched = new Map(disk.extensionFiles);
    app.edit(targets => {targets[1].x += 1;});
    assert.equal(await app.save(), 'Project folder saved.');
    assert.equal(disk.root.get('embedded-extensions.json'), initialManifest);
    assert.deepEqual(disk.extensionFiles, untouched);

    const working = await mkdtemp(join(tmpdir(), 'tw-project-extension-'));
    t.after(() => rm(working, {recursive: true, force: true}));
    const source = join(working, 'source');
    await mkdir(join(source, 'assets'), {recursive: true});
    await mkdir(join(source, 'extensions'));
    const writeSource = async () => {
        for (const [prefix, files] of [['', disk.root], ['assets', disk.assetFiles], ['extensions', disk.extensionFiles]]) {
            await Promise.all([...files].map(([name, entry]) => writeFile(join(source, prefix, name), entry.data)));
        }
    };
    await writeSource();
    execFileSync(process.execPath, [cli, 'build', source, '--output', join(working, 'bundled.sb3')]);
    const replacement = extension('first', '変更済み');
    const added = extension('added');
    app.editProject(edited => {
        edited.extensions = ['first', 'stable', 'remote', 'added'];
        delete edited.extensionURLs.second;
        edited.extensionURLs.first = dataUrl(replacement);
        edited.extensionURLs.added = dataUrl(added);
    });
    disk.failures.add('project.source.json');
    assert.match(await app.save(), /^Could not access the project folder/u);
    assert.deepEqual(disk.extensionFiles.get('first.js').data, scripts.get('first.js'));
    assert.equal(disk.extensionFiles.has('added.js'), false);
    assert.deepEqual(disk.embedded(), embedded);
    disk.failures.clear();
    disk.log.length = 0;
    assert.match(await app.save(), /Removed source metadata for replaced extensions: first.*sb3-toolchain/u);
    assert.deepEqual(disk.log, ['write extensions/first.js', 'write extensions/added.js', 'write embedded-extensions.json',
        'write project.source.json', 'remove extensions/first.manifest.json', 'remove extensions/second.js']);
    assert.deepEqual(disk.embedded().extensionBundles, [
        {id: 'bundle', name: 'Bundle', members: ['first', 'stable'], recoveryCapsule: true}
    ]);
    assert.equal(disk.embedded().extensions[0].source, undefined);
    assert.deepEqual(disk.embedded().extensions[1], embedded.extensions[2]);
    assert.equal(disk.embedded().extensions[2].source, undefined);
    assert.deepEqual(disk.project().extensionURLs, {first: ref('first'), stable: ref('stable'), remote, added: ref('added')});
    assert.equal(await app.save(), 'No changes to save.');
    await writeSource();
    await rm(join(source, 'extensions', 'second.js'));
    await rm(join(source, 'extensions', 'first.manifest.json'));
    const archive = join(working, 'roundtrip.sb3');
    execFileSync(process.execPath, [cli, 'build', source, '--output', archive]);
    const unbundled = join(working, 'unbundled.sb3');
    execFileSync(process.execPath, [cli, 'extensions', 'unbundle', archive, 'bundle', '--output', unbundled, '--yes']);
    const imported = join(working, 'imported');
    await importSb3({inputPath: unbundled, outputDirectory: imported});
    assert.deepEqual(JSON.parse(await readFile(join(imported, 'project.source.json'), 'utf8')), disk.project());
    for (const [name, entry] of disk.extensionFiles) {
        assert.deepEqual(await readFile(join(imported, 'extensions', name)), Buffer.from(entry.data));
    }
    app.editProject(edited => {
        edited.extensions = ['stable', 'remote', 'added'];
        delete edited.extensionURLs.first;
    });
    assert.equal(await app.save(), 'Project folder saved.');
    assert.deepEqual(disk.embedded().extensionBundles, []);
});

// Block palette settings (sb3-toolchain source format 2): the VM sees each setting as a comment; the folder keeps
// the comment as a reference and the settings in block-palette.json.
const catGroups = {formatVersion: 1, sprites: {Cat: {groups: ['events', 'control', 'pen']}}};
const paletteText = (document, target) => formatBlockPaletteComment(document, target);
const paletteComment = text => ({blockId: null, x: 0, y: 0, width: 200, height: 200, minimized: true, text});
const withPaletteReference = () => {
    const project = initialProject();
    project.targets[1].comments = {note: paletteComment('A plain note'), palette: paletteComment(blockPaletteCommentReference)};
    return project;
};
const assetsOf = () => [[`${md5(red)}.svg`, red], [`${md5(blue)}.svg`, blue]];

test('opens a format 2 folder with palette comments in full and keeps the settings with a renamed sprite', async t => {
    const disk = folder(withPaletteReference(), assetsOf(), {palette: catGroups});
    const app = editor(initialProject(), new Map(assetsOf()));
    t.after(() => app.mounted.dispose());
    assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');
    assert.equal(app.snapshot().targets[1].comments.palette.text, paletteText(catGroups, {isStage: false, name: 'Cat'}));
    assert.equal(app.snapshot().targets[1].comments.note.text, 'A plain note');
    assert.equal(await app.save(), 'No changes to save.');

    const manifest = disk.root.get('sb3-source.json');
    app.edit(targets => {targets[1].name = 'Kitten';});
    disk.log.length = 0;
    assert.equal(await app.save(), 'Project folder saved.');
    assert.deepEqual(disk.log, ['write block-palette.json', 'write project.source.json']);
    assert.deepEqual(disk.palette(), {formatVersion: 1, sprites: {Kitten: {groups: ['events', 'control', 'pen']}}});
    assert.equal(disk.project().targets[1].comments.palette.text, blockPaletteCommentReference);
    assert.equal(disk.root.get('sb3-source.json'), manifest);
});

test('a change to palette settings alone writes only block-palette.json', async t => {
    const disk = folder(withPaletteReference(), assetsOf(), {palette: catGroups});
    const app = editor(initialProject(), new Map(assetsOf()));
    t.after(() => app.mounted.dispose());
    assert.equal(await app.mounted.openDirectory(disk.directory, () => true), 'opened');
    const changed = {formatVersion: 1, sprites: {Cat: {groups: ['motion', 'looks']}}};
    app.edit(targets => {targets[1].comments.palette.text = paletteText(changed, {isStage: false, name: 'Cat'});});
    assert.deepEqual(app.mounted.unsavedPaths(), new Set(['block-palette.json']));
    assert.deepEqual(app.mounted.readUnsavedFile('block-palette.json'), bytes(stringify(changed)));
    disk.log.length = 0;
    assert.equal(await app.save(), 'Project folder saved.');
    assert.deepEqual(disk.log, ['write block-palette.json']);
    assert.deepEqual(disk.palette(), changed);
});

test('moves a folder to format 2 when palette settings appear, and back to format 1 when they go', async t => {
    const {disk, app} = await setup(t);
    const stage = {formatVersion: 1, order: ['events', 'control'], stage: {groups: ['events']}};
    app.edit(targets => {
        targets[0].comments = {palette: paletteComment(paletteText(stage, {isStage: true, name: 'Stage'}))};
    });
    disk.log.length = 0;
    assert.equal(await app.save(), 'Project folder saved.');
    assert.deepEqual(disk.log, ['write block-palette.json', 'write sb3-source.json', 'write project.source.json']);
    assert.deepEqual(disk.palette(), stage);
    assert.equal(disk.project().targets[0].comments.palette.text, blockPaletteCommentReference);
    assert.deepEqual(Object.keys(disk.manifest()),
        ['formatVersion', 'project', 'note', 'embeddedExtensions', 'assetsDirectory', 'archiveEntries', 'blockPalette']);
    assert.equal(disk.manifest().formatVersion, 2);

    app.edit(targets => {targets[0].comments = {};});
    disk.log.length = 0;
    assert.equal(await app.save(), 'Project folder saved.');
    assert.deepEqual(disk.log, ['write sb3-source.json', 'write project.source.json', 'remove block-palette.json']);
    assert.equal(disk.palette(), null);
    assert.equal(disk.manifest().formatVersion, 1);
    assert.equal(disk.manifest().blockPalette, undefined);
});

test('writes block palette settings that the toolchain checks and rebuilds byte for byte', async t => {
    const {disk, app} = await setup(t);
    const document = {formatVersion: 1, order: ['events', 'pen'], stage: {groups: ['events']},
        sprites: {Cat: {groups: ['events', 'pen', 'myExt/geometry']}}};
    app.edit(targets => {
        targets[0].comments = {stagePalette: paletteComment(paletteText(document, {isStage: true, name: 'Stage'}))};
        targets[1].comments = {catPalette: paletteComment(paletteText(document, {isStage: false, name: 'Cat'}))};
    });
    assert.equal(await app.save(), 'Project folder saved.');
    const working = await mkdtemp(join(tmpdir(), 'tw-project-palette-'));
    t.after(() => rm(working, {recursive: true, force: true}));
    const source = join(working, 'source');
    await mkdir(join(source, 'assets'), {recursive: true});
    for (const [prefix, files] of [['', disk.root], ['assets', disk.assetFiles]]) {
        await Promise.all([...files].map(([name, entry]) => writeFile(join(source, prefix, name), entry.data)));
    }
    execFileSync(process.execPath, [cli, 'check', source]);
    const archive = join(working, 'palette.sb3');
    execFileSync(process.execPath, [cli, 'build', source, '--output', archive]);
    // Since 0.26 the toolchain imports palette comments as plain comments in format 1, with the same text.
    const imported = join(working, 'imported');
    execFileSync(process.execPath, [cli, 'import', archive, '--output', imported, '--yes']);
    const importedProject = JSON.parse(await readFile(join(imported, 'project.source.json'), 'utf8'));
    assert.equal(JSON.parse(await readFile(join(imported, 'sb3-source.json'), 'utf8')).formatVersion, 1);
    assert.equal(importedProject.targets[0].comments.stagePalette.text, paletteText(document, {isStage: true, name: 'Stage'}));
    assert.equal(importedProject.targets[1].comments.catPalette.text, paletteText(document, {isStage: false, name: 'Cat'}));
});

test('refuses folders whose format or palette settings do not agree', async t => {
    const cases = [
        ['format 3', folder(initialProject(), assetsOf(), {manifest: {formatVersion: 3}})],
        ['format 2 without palette file', folder(initialProject(), assetsOf(), {manifest: {formatVersion: 2}})],
        ['format 1 naming a palette file', folder(initialProject(), assetsOf(), {manifest: {blockPalette: 'block-palette.json'}})],
        ['reference without settings', folder(withPaletteReference(), assetsOf(), {palette: {formatVersion: 1}})],
        ['settings for an unknown sprite', folder(withPaletteReference(), assetsOf(),
            {palette: {formatVersion: 1, sprites: {Cat: {groups: []}, Dog: {groups: []}}}})]
    ];
    for (const [label, disk] of cases) {
        const app = editor(initialProject(), new Map(assetsOf()));
        t.after(() => app.mounted.dispose());
        await assert.rejects(app.mounted.openDirectory(disk.directory, () => true), {code: 'unsupported'}, label);
    }
});
