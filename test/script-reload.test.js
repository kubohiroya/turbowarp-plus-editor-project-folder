import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountProjectFolder} from '../dist/index.js';

const stringify = value => `${JSON.stringify(value, null, 2)}\n`;
const block = (opcode, {next = null, parent = null, inputs = {}, fields = {}, x, y} = {}) =>
    ({opcode, next, parent, inputs, fields, shadow: false, topLevel: parent === null, ...(parent === null ? {x: x ?? 0, y: y ?? 0} : {})});
const variables = {'var-1': ['score', 0]};
const sprite = (blocks, name = 'Cat') => ({isStage: false, name, variables: {}, blocks});
const stage = blocks => ({isStage: true, name: 'Stage', variables, blocks});
const project = (catBlocks, birdBlocks = {bird: block('event_whenflagclicked')}, stageBlocks = {}) =>
    ({targets: [stage(stageBlocks), sprite(catBlocks), sprite(birdBlocks, 'Bird')]});
const baseCat = () => ({
    flag: block('event_whenflagclicked', {next: 'move'}),
    move: block('motion_movesteps', {parent: 'flag'}),
    other: block('event_whenkeypressed', {x: 300})
});

// A compact stand-in for the VM's Blocks container: scripts start at topLevel blocks, and a deleted block
// takes its `next` chain and its input children with it.
class Blocks {
    constructor(blocks) {
        this._blocks = {};
        this._scripts = [];
        for (const [id, value] of Object.entries(blocks)) this.createBlock({...structuredClone(value), id});
        this.failOn = null;
    }
    getBlock(id) {return this._blocks[id];}
    createBlock(value) {
        if (this.failOn === value.id) throw new Error('VM failure');
        if (Object.hasOwn(this._blocks, value.id)) return;
        this._blocks[value.id] = value;
        if (value.topLevel) this._scripts.push(value.id);
    }
    deleteBlock(id) {
        const value = this._blocks[id];
        if (!value) return;
        if (value.next) this.deleteBlock(value.next);
        for (const input of Object.values(value.inputs)) if (typeof input[1] === 'string') this.deleteBlock(input[1]);
        this._scripts = this._scripts.filter(script => script !== id);
        delete this._blocks[id];
    }
    resetCache() {}
    changeBlock() {}
    moveBlock() {}
    toJSON() {
        return Object.fromEntries(Object.entries(this._blocks).map(([id, {id: _, ...rest}]) => {
            const fields = Object.fromEntries(Object.entries(rest.fields).map(([name, field]) =>
                [name, Array.isArray(field) ? field : [field.value, field.id]]));
            return [id, {...rest, fields}];
        }));
    }
}

// Mirrors the VM's sb3 deserializeBlocks for these fixtures: ids come back and variable fields gain types.
const deserializeBlocks = blocks => {
    for (const [id, value] of Object.entries(blocks)) {
        value.id = id;
        value.fields = Object.fromEntries(Object.entries(value.fields).map(([name, [fieldValue, fieldId]]) =>
            [name, {name, value: fieldValue, ...(fieldId === undefined ? {} : {id: fieldId}),
                ...(name === 'VARIABLE' ? {variableType: ''} : {})}]));
    }
    return blocks;
};

function folder(initial) {
    let clock = 1_000;
    const files = new Map();
    const write = (name, text) => files.set(name, {text, lastModified: clock++});
    write('project.source.json', stringify(initial));
    write('embedded-extensions.json', stringify({formatVersion: 1, extensions: []}));
    write('sb3-source.json', stringify({formatVersion: 1, project: 'project.source.json',
        embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets', archiveEntries: ['project.json']}));
    return {
        directory: {
            name: 'Folder',
            async getFileHandle(name) {
                return {name, async getFile() {
                    const file = files.get(name);
                    return new File([file.text], name, {lastModified: file.lastModified});
                }};
            },
            async getDirectoryHandle() {return {values: () => []};}
        },
        writeProject: value => write('project.source.json', stringify(value))
    };
}

const settle = async () => {for (let index = 0; index < 30; index++) await new Promise(resolve => setImmediate(resolve));};

function element(tag) {
    const listeners = new Map();
    return {tag, style: {}, dataset: {}, hidden: false, disabled: false, textContent: '', isConnected: true, children: [],
        setAttribute() {}, remove() {}, append(...children) {this.children.push(...children);},
        addEventListener(type, listener) {listeners.set(type, listener);}, click() {listeners.get('click')?.();}};
}

function setup(initial, {deserialize = deserializeBlocks} = {}) {
    const disk = folder(initial);
    const state = {loads: 0, applied: []};
    let targets = [];
    const makeTarget = data => {
        const target = {
            isStage: data.isStage, isOriginal: true, getName: () => data.name, comments: {},
            variables: data.variables, blocks: new Blocks(data.blocks),
            lookupVariableById: id => target.variables[id] ?? targets[0].variables[id]
        };
        return target;
    };
    const load = value => {targets = value.targets.map(makeTarget);};
    const stageObject = {};
    const vm = {
        runtime: {storage: {addHelper() {}}, get targets() {return targets;}, getTargetForStage: () => stageObject, on() {}, off() {}},
        on() {}, off() {}, quit() {},
        async loadProject(text) {state.loads++; load(JSON.parse(text));},
        toJSON: () => JSON.stringify({targets: targets.map(target => ({isStage: target.isStage, name: target.getName(),
            variables: target.variables, blocks: target.blocks.toJSON()}))})
    };
    const timers = [];
    const listeners = new Map();
    const created = [];
    const document = {
        visibilityState: 'visible',
        defaultView: {
            showDirectoryPicker() {}, setTimeout(callback) {timers.push(callback); return timers.length;}, clearTimeout() {},
            setInterval: () => 0, clearInterval() {}, addEventListener(type, listener) {listeners.set(type, listener);},
            removeEventListener() {}, confirm: () => true
        },
        createElement(tag) {const made = element(tag); created.push(made); return made;},
        addEventListener() {}, removeEventListener() {}, body: {append() {}}
    };
    const host = {
        isProjectDirty: () => false, beforeLoad() {}, onOpened() {}, onSaved() {},
        blockReload: {isRunning: () => false, subscribe: () => () => {}, onApplied(list) {state.applied.push(list);},
            ...(deserialize ? {deserializeBlocks: deserialize} : {})}
    };
    const mounted = mountProjectFolder({vm, document, host});
    const notice = created.find(entry => entry.tag === 'aside');
    return {
        disk, state, mounted, notice, button: notice.children[1],
        target: name => targets.find(entry => entry.getName() === name),
        ids: name => Object.keys(targets.find(entry => entry.getName() === name).blocks._blocks).sort(),
        async open() {assert.equal(await mounted.openDirectory(disk.directory, () => true), 'opened');},
        async change(value) {
            disk.writeProject(value);
            listeners.get('focus')();
            await settle();
            while (timers.length) {timers.shift()(); await settle();}
        }
    };
}

test('adds a block in place and keeps other scripts and targets', async t => {
    const editor = setup(project(baseCat()));
    t.after(() => editor.mounted.dispose());
    await editor.open();
    const bird = editor.target('Bird');
    const other = editor.target('Cat').blocks.getBlock('other');
    const cat = baseCat();
    cat.move.next = 'turn';
    cat.turn = block('motion_turnright', {parent: 'move'});
    await editor.change(project(cat));
    assert.deepEqual(editor.ids('Cat'), ['flag', 'move', 'other', 'turn']);
    assert.equal(editor.target('Cat').blocks.getBlock('turn').parent, 'move');
    assert.equal(editor.target('Bird'), bird, 'other targets are untouched');
    assert.equal(editor.target('Cat').blocks.getBlock('other'), other, 'unchanged scripts keep their blocks');
    assert.equal(editor.state.loads, 1, 'no whole reload');
    assert.equal(editor.state.applied.length, 1);
    assert.equal(editor.notice.hidden, true);
});

test('removes a script and moves a block between scripts', async t => {
    const editor = setup(project(baseCat()));
    t.after(() => editor.mounted.dispose());
    await editor.open();
    const cat = baseCat();
    delete cat.flag;
    cat.move = block('motion_movesteps', {parent: 'other'});
    cat.other.next = 'move';
    await editor.change(project(cat));
    assert.deepEqual(editor.ids('Cat'), ['move', 'other']);
    assert.deepEqual(editor.target('Cat').blocks._scripts, ['other']);
    assert.equal(editor.target('Cat').blocks.getBlock('other').next, 'move');
    assert.equal(editor.state.loads, 1);
});

test('accepts a variable the project has and refuses one it does not', async t => {
    const editor = setup(project(baseCat()));
    t.after(() => editor.mounted.dispose());
    await editor.open();
    const known = baseCat();
    known.set = block('data_setvariableto', {x: 500, fields: {VARIABLE: ['score', 'var-1']}});
    await editor.change(project(known));
    assert.ok(editor.target('Cat').blocks.getBlock('set'));

    const unknown = structuredClone(known);
    unknown.change = block('data_changevariableby', {x: 600, fields: {VARIABLE: ['lives', 'var-missing']}});
    await editor.change(project(unknown));
    assert.equal(editor.target('Cat').blocks.getBlock('change'), undefined, 'the VM is unchanged');
    assert.equal(editor.button.textContent, 'Reload Whole Project');
    assert.equal(editor.state.loads, 1);
});

test('refuses blocks from an extension the project does not use', async t => {
    const editor = setup(project(baseCat()));
    t.after(() => editor.mounted.dispose());
    await editor.open();
    const cat = baseCat();
    cat.pen = block('pen_clear', {x: 700});
    await editor.change(project(cat));
    assert.equal(editor.target('Cat').blocks.getBlock('pen'), undefined);
    assert.equal(editor.button.textContent, 'Reload Whole Project');
});

test('needs a whole reload when the host gives no deserializer', async t => {
    const editor = setup(project(baseCat()), {deserialize: null});
    t.after(() => editor.mounted.dispose());
    await editor.open();
    const cat = baseCat();
    cat.turn = block('motion_turnright', {x: 50});
    await editor.change(project(cat));
    assert.equal(editor.target('Cat').blocks.getBlock('turn'), undefined);
    assert.equal(editor.button.textContent, 'Reload Whole Project');
});

test('restores every target when the VM fails part way', async t => {
    const editor = setup(project(baseCat()));
    t.after(() => editor.mounted.dispose());
    await editor.open();
    const catBefore = editor.ids('Cat');
    const birdBefore = editor.ids('Bird');
    const scriptsBefore = [...editor.target('Cat').blocks._scripts];
    editor.target('Bird').blocks.failOn = 'bird2';
    const cat = baseCat();
    cat.turn = block('motion_turnright', {x: 50});
    await editor.change(project(cat, {bird: block('event_whenflagclicked'), bird2: block('looks_show', {x: 9})}));
    assert.deepEqual(editor.ids('Cat'), catBefore, 'the first target is rolled back too');
    assert.deepEqual(editor.ids('Bird'), birdBefore);
    assert.deepEqual(editor.target('Cat').blocks._scripts, scriptsBefore);
    assert.equal(editor.target('Cat').blocks.getBlock('flag').topLevel, true);
    assert.equal(editor.state.applied.length, 0);
    assert.equal(editor.button.textContent, 'Reload Whole Project');
});
