import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from '@playwright/test';
import {build} from 'vite';

// localhost is a secure context, which the File System Access API needs. Playwright answers every request.
const origin = 'http://localhost:41016';
const a = 'a'.repeat(32), c = 'c'.repeat(32);
const asset = (id, name, format) => ({name, assetId: id, md5ext: `${id}.${format}`, dataFormat: format});
const project = {targets: [
    {isStage: true, name: 'Stage', costumes: [asset(a, 'backdrop1', 'svg')], sounds: []},
    {isStage: false, name: 'Cat', costumes: [asset(a, 'cat-a', 'svg')], sounds: [asset(c, 'Meow', 'wav')]}
]};
const manifest = {formatVersion: 1, project: 'project.source.json', embeddedExtensions: 'embedded-extensions.json',
    assetsDirectory: 'assets', archiveEntries: ['project.json', `${a}.svg`, `${c}.wav`]};

async function bundleHarness(t) {
    const out = await mkdtemp(path.join(tmpdir(), 'twpf-explorer-harness-'));
    t.after(() => rm(out, {recursive: true, force: true}));
    await build({
        configFile: false, logLevel: 'silent', root: fileURLToPath(new URL('..', import.meta.url)),
        // Development React reports invalid props and other warnings to the console, which the tests reject.
        define: {'process.env.NODE_ENV': '"development"'},
        build: {outDir: out, emptyOutDir: false, minify: false, target: 'es2020', write: true,
            rolldownOptions: {input: fileURLToPath(new URL('./explorer-page.js', import.meta.url)),
                output: {entryFileNames: 'harness.js', format: 'es'}}}
    });
    return readFile(path.join(out, 'harness.js'));
}

async function makeFolder(t) {
    const folder = await mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'twpf-explorer-'));
    t.after(() => rm(folder, {recursive: true, force: true}));
    const write = (name, value) => writeFile(path.join(folder, name), typeof value === 'string' ? value : JSON.stringify(value));
    for (const name of ['assets', 'docs', 'extensions', '.git']) await mkdir(path.join(folder, name));
    await write('project.source.json', project);
    await write('sb3-source.json', manifest);
    await write('embedded-extensions.json', {formatVersion: 1, extensions: []});
    await write('README.md', '# Cat\n');
    await write('.gitignore', 'node_modules\n');
    await write('.git/HEAD', 'ref: refs/heads/main\n');
    await write('docs/notes.txt', 'notes\n');
    await write(`assets/${a}.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await write(`assets/${c}.wav`, 'RIFF');
    return folder;
}

let harness;
async function open(t, {withFolder = true} = {}) {
    harness ??= await bundleHarness(t);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (['error', 'warning'].includes(message.type())) errors.push(message.text());});
    t.after(() => assert.deepEqual(errors, []));
    await page.route(`${origin}/**`, route => new URL(route.request().url()).pathname === '/harness.js' ?
        route.fulfill({body: harness, contentType: 'text/javascript'}) :
        route.fulfill({body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/harness.js"></script>',
            contentType: 'text/html'}));
    // The directory picker cannot be scripted, so the folder is dropped on the page and kept as a handle.
    await page.addInitScript(() => {
        for (const type of ['dragenter', 'dragover', 'drop']) {
            window.addEventListener(type, async event => {
                event.preventDefault();
                if (type === 'drop') window.droppedDirectory = await event.dataTransfer.items[0].getAsFileSystemHandle();
            }, {capture: true});
        }
    });
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => typeof window.renderExplorer === 'function');
    if (withFolder) {
        const folder = await makeFolder(t);
        const cdp = await page.context().newCDPSession(page);
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
            await cdp.send('Input.dispatchDragEvent', {type, x: 10, y: 10, data: {items: [], files: [folder], dragOperationsMask: 1}});
        }
        await page.waitForFunction(() => window.droppedDirectory?.kind === 'directory');
    }
    return page;
}

const names = async page => page.locator('[role="treeitem"] .twpf-explorer-name').allTextContents();

test('lists the folder with folders first and .git hidden, and loads a folder when it is expanded', async t => {
    const page = await open(t);
    assert.equal(await page.evaluate(() => window.renderExplorer('en')), '16.14.0');
    const tree = page.getByRole('tree', {name: 'Project folder'});
    await expect(tree.getByRole('treeitem')).toHaveCount(8);
    assert.deepEqual(await names(page), ['assets', 'docs', 'extensions',
        '.gitignore', 'embedded-extensions.json', 'project.source.json', 'README.md', 'sb3-source.json']);

    const assets = tree.getByRole('treeitem', {name: 'assets, Costume and sound files'});
    await expect(assets).toHaveAttribute('aria-expanded', 'false');
    await expect(assets).toHaveAttribute('aria-level', '1');
    await expect(tree.getByRole('treeitem', {name: 'project.source.json, Modified, Project data'})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: 'README.md, Untracked'})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: 'README.md, Untracked'})).not.toHaveAttribute('aria-expanded');

    await assets.click();
    await expect(assets).toHaveAttribute('aria-expanded', 'true');
    const svg = tree.getByRole('treeitem', {name: `${a}.svg, Stage · backdrop backdrop1, Cat · costume cat-a`});
    await expect(svg).toHaveAttribute('aria-level', '2');
    await expect(tree.getByRole('treeitem', {name: `${c}.wav, Cat · sound Meow`})).toHaveAttribute('aria-level', '2');
    assert.deepEqual((await names(page)).slice(0, 3), ['assets', `${a}.svg`, `${c}.wav`]);
    assert.deepEqual(await page.evaluate(() => window.opened), [], 'a folder is not opened as a file');

    await svg.click();
    assert.deepEqual(await page.evaluate(() => window.opened), [{path: `assets/${a}.svg`, name: `${a}.svg`, kind: 'file'}]);
    await assets.click();
    await expect(assets).toHaveAttribute('aria-expanded', 'false');
    await expect(svg).toHaveCount(0);
});

test('moves, expands and opens with the keyboard', async t => {
    const page = await open(t);
    await page.evaluate(() => window.renderExplorer('en'));
    const tree = page.getByRole('tree');
    const item = name => tree.getByRole('treeitem', {name: new RegExp(`^${name.replace(/[.]/gu, '\\.')}(,|$)`, 'u')});
    await expect(item('assets')).toHaveAttribute('tabindex', '0');
    await item('assets').focus();

    await page.keyboard.press('ArrowDown');
    await expect(item('docs')).toBeFocused();
    await page.keyboard.press('End');
    await expect(item('sb3-source.json')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item('assets')).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(item('assets')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(`${a}.svg`)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(item(`${a}.svg`)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(`${c}.wav`)).toBeFocused();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.opened), [{path: `assets/${c}.wav`, name: `${c}.wav`, kind: 'file'}]);

    await page.keyboard.press('ArrowLeft');
    await expect(item('assets')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(item('assets')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowDown');
    await expect(item('docs')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(item('docs')).toHaveAttribute('aria-expanded', 'true');
    await expect(item('notes.txt')).toHaveAttribute('aria-level', '2');
    assert.equal(await page.evaluate(() => window.opened.length), 1, 'Enter on a folder expands it without opening');
});

test('shows Japanese labels and descriptions', async t => {
    const page = await open(t);
    await page.evaluate(() => window.renderExplorer('ja'));
    const tree = page.getByRole('tree', {name: '作品フォルダ'});
    await expect(tree.getByRole('treeitem', {name: 'project.source.json、変更、作品データ'})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: 'sb3-source.json、作品フォルダの目録'})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: 'embedded-extensions.json、埋め込み拡張の一覧'})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: 'README.md、未追跡'})).toBeVisible();
    await tree.getByRole('treeitem', {name: 'assets、コスチュームと音のファイル'}).click();
    await expect(tree.getByRole('treeitem', {name: `${a}.svg、ステージの背景 backdrop1、Cat のコスチューム cat-a`})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: `${c}.wav、Cat の音 Meow`})).toBeVisible();
    const screenshot = process.env.TWPF_EXPLORER_SCREENSHOT;
    if (screenshot) await page.locator('#root').screenshot({path: screenshot});
});

test('shows a message in the tree when the folder cannot be read', async t => {
    const page = await open(t, {withFolder: false});
    await page.evaluate(() => window.renderDenied('ja'));
    await expect(page.getByRole('tree', {name: '作品フォルダ'}).getByRole('treeitem', {name: 'このフォルダを読む許可がありません。'}))
        .toBeVisible();
    await page.evaluate(() => window.renderDenied('en'));
    await expect(page.getByRole('treeitem', {name: 'Permission to read this folder was not granted.'})).toBeVisible();
});
