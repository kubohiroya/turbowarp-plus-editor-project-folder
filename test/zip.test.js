import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {zipDirectory, zipFileName} from '../dist/index.js';

function directory(name, tree) {
    const children = Object.entries(tree).map(([child, value]) => typeof value === 'string' || value instanceof Uint8Array ?
        {name: child, kind: 'file', async getFile() {return new File([value], child, {lastModified: Date.UTC(2026, 10, 17, 3, 4, 6)});}} :
        directory(child, value));
    return {name, kind: 'directory', values: async function * () {yield * children;}};
}

const tree = directory('root', {
    'project.source.json': '{"targets":[]}\n',
    'sb3-source.json': '{}',
    assets: {[`${'a'.repeat(32)}.png`]: new Uint8Array([137, 80, 78, 71, 0, 255])},
    extensions: {},
    'ねこ.txt': 'にゃー',
    '.git': {HEAD: 'ref: refs/heads/main\n'}
});

test('a folder becomes a ZIP that zipfile reads and checks, with empty folders and UTF-8 names', async t => {
    const out = await mkdtemp(path.join(tmpdir(), 'twpf-zip-'));
    t.after(() => rm(out, {recursive: true, force: true}));
    const file = path.join(out, 'project.zip');
    const blob = await zipDirectory(tree);
    assert.equal(blob.type, 'application/zip');
    await writeFile(file, new Uint8Array(await blob.arrayBuffer()));
    // Python's zipfile honors the UTF-8 flag and checks every CRC in testzip().
    const read = JSON.parse(execFileSync('python3', ['-I', '-c', `import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "names": sorted(z.namelist()), "text": z.read("ねこ.txt").decode(),
    "png": list(z.read("assets/${'a'.repeat(32)}.png"))}))`, file], {encoding: 'utf8'}));
    assert.equal(read.bad, null);
    assert.deepEqual(read.names, ['.git/HEAD', `assets/${'a'.repeat(32)}.png`, 'extensions/', 'project.source.json',
        'sb3-source.json', 'ねこ.txt']);
    assert.equal(read.text, 'にゃー');
    assert.deepEqual(read.png, [137, 80, 78, 71, 0, 255]);
});

test('excluded paths stay out of the ZIP and each entry carries the CRC of its bytes', async () => {
    const bytes = new Uint8Array(await (await zipDirectory(tree, {exclude: name => name === '.git'})).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const names = [];
    for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
        const size = view.getUint32(offset + 18, true);
        const nameLength = view.getUint16(offset + 26, true);
        const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
        const data = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
        assert.equal(view.getUint32(offset + 14, true), zlib.crc32(data), name);
        names.push(name);
        offset += 30 + nameLength + size;
    }
    assert.ok(!names.some(name => name.startsWith('.git')));
    assert.equal(names.length, 5);
});

test('the export file name keeps the title and drops characters a file system refuses', () => {
    assert.equal(zipFileName('ねこの冒険'), 'ねこの冒険.zip');
    assert.equal(zipFileName('a/b:c*?"<>|'), 'a_b_c______.zip');
    assert.equal(zipFileName(' .. '), 'project.zip');
});
