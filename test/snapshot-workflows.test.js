import test from 'node:test';
import assert from 'node:assert/strict';
import {createFolderSnapshotWorkflows} from '../dist/snapshot-workflows.js';
const files = new Map([['project.json', new Uint8Array([1])]]);
function fixture() {
    const writes = [];
    const folder = {locations: ['browser'], browserProjects: {},
        async createFromSnapshot(request) {await request.collectEdits(); const data = await request.prepareFiles(); writes.push(data); return 'opened';},
        async copyToFolder(request) {writes.push(request); await request.prepareFiles(); return {};},
        pickEmptyFolder: assert.fail};
    const options = {folder, view: {confirm: () => true}, locale: 'en', flushEdits: async () => {},
        unpackProject: () => ({files, warnings: []})};
    return {options, writes};
}
test('snapshot creation verifies the current project after serialization and before writing', async () => {
    const f=fixture(); let current=true;
    const flow=createFolderSnapshotWorkflows(f.options);
    assert.equal(await flow.createFolder(async () => {current=false; return new Uint8Array();}, () => current), false);
    assert.deepEqual(f.writes, []);
});
test('omitted files require confirmation; cancellation writes nothing', async () => {
    const f=fixture(); f.options.unpackProject=() => ({files,warnings:[{path:'external.bin'}]});
    f.options.view.confirm=question => {assert.match(question,/external.bin/); return false;};
    assert.equal(await createFolderSnapshotWorkflows(f.options).createFolder(async () => new Uint8Array(), () => true), false);
    assert.deepEqual(f.writes, []);
});
test('Save a Copy chooses browser storage without changing the loaded directory', async () => {
    const f=fixture(); const flow=createFolderSnapshotWorkflows(f.options);
    assert.deepEqual(flow.locations,{browser:true,device:false});
    assert.equal(await flow.copyFolder(async () => new Uint8Array(), () => true, 'Copy'), true);
    assert.equal(f.writes[0].destination,'browser'); assert.equal(f.writes[0].title,'Copy');
});
test('real errors propagate while AbortError cancels a copy', async () => {
    const f=fixture(); f.options.folder.copyToFolder=async () => {throw new Error('disk full');};
    await assert.rejects(createFolderSnapshotWorkflows(f.options).copyFolder(async () => new Uint8Array(), () => true), /disk full/);
    f.options.folder.copyToFolder=async () => {throw new DOMException('Cancelled','AbortError');};
    assert.equal(await createFolderSnapshotWorkflows(f.options).copyFolder(async () => new Uint8Array(), () => true), false);
});
