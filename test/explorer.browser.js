import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';
import {chromium, expect} from '@playwright/test';
import {build} from 'vite';

// localhost is a secure context, which the File System Access API needs. Playwright answers every request.
const origin = 'http://localhost:41016';
const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
const asset = (id, name, format) => ({name, assetId: id, md5ext: `${id}.${format}`, dataFormat: format});
const project = {targets: [
    {isStage: true, name: 'Stage', costumes: [asset(a, 'backdrop1', 'svg')], sounds: []},
    {isStage: false, name: 'Cat', costumes: [asset(a, 'cat-a', 'svg'), asset(b, 'cat-b', 'png')], sounds: [asset(c, 'Meow', 'wav')]}
]};
const manifest = {formatVersion: 1, project: 'project.source.json', embeddedExtensions: 'embedded-extensions.json',
    assetsDirectory: 'assets', archiveEntries: ['project.json', `${a}.svg`, `${b}.png`, `${c}.wav`]};

// A cat face, so the screenshot shows what a costume thumbnail looks like.
const costumeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
<path d="M8 6l10 9h12l10-9v20a16 16 0 0 1-32 0z" fill="#ffab19" stroke="#c77b00" stroke-width="2"/>
<circle cx="18" cy="26" r="3" fill="#333"/><circle cx="30" cy="26" r="3" fill="#333"/>
<path d="M21 33q3 3 6 0" fill="none" stroke="#333" stroke-width="2"/></svg>`;

// A small RGBA PNG: a blue disc on a transparent background.
function discPng(size) {
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const out = Buffer.alloc(body.length + 8);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(zlib.crc32(body), body.length + 4);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // RGBA
    const rows = [];
    for (let y = 0; y < size; y++) {
        const row = Buffer.alloc(1 + size * 4);
        for (let x = 0; x < size; x++) {
            const inside = (x - size / 2 + 0.5) ** 2 + (y - size / 2 + 0.5) ** 2 < (size / 2 - 1) ** 2;
            if (inside) row.set([76, 151, 255, 255], 1 + x * 4);
        }
        rows.push(row);
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
// Over the explorer's 2 MiB thumbnail limit; its content is never read.
const largeImage = Buffer.alloc(2 * 1024 * 1024 + 1);

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
    const write = (name, value) => writeFile(path.join(folder, name), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    for (const name of ['assets', 'docs', 'extensions', '.git']) await mkdir(path.join(folder, name));
    await write('project.source.json', project);
    await write('sb3-source.json', manifest);
    await write('embedded-extensions.json', {formatVersion: 1, extensions: []});
    await write('README.md', '# Cat\n');
    await write('.gitignore', 'node_modules\n');
    await write('.git/HEAD', 'ref: refs/heads/main\n');
    await write('docs/notes.txt', 'notes\n');
    await write('docs/scan.png', largeImage);
    await write('extensions/hello.js', 'export default class {}\n');
    await write(`assets/${a}.svg`, costumeSvg);
    await write(`assets/${b}.png`, discPng(32));
    await write(`assets/${c}.wav`, 'RIFF');
    return folder;
}

let harness;
async function open(t, {withFolder = true} = {}) {
    harness ??= await bundleHarness(t);
    const browser = await chromium.launch({headless: true});
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
                if (!event.dataTransfer.types.includes('Files')) return;
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

test('creates folders and moves files and folder trees with drag feedback', async t => {
    const page = await open(t, {withFolder: false});
    await page.evaluate(async () => {
        const setDragImage = DataTransfer.prototype.setDragImage;
        DataTransfer.prototype.setDragImage = function (image, x, y) {
            window.dragPreview = {name: image.textContent, icon: image.querySelector('[data-icon]')?.dataset.icon};
            setDragImage.call(this, image, x, y);
        };
        await window.renderWritableExplorer();
    });
    const row = path => page.locator(`[data-path="${path}"]`);
    const unavailable = page.locator('[data-move-unavailable]');
    const active = page.locator('[data-move-active]');
    const createFolder = async name => {
        await row('destination').click({button: 'right'});
        await page.getByRole('menuitem', {name: '新規フォルダを作成'}).click();
        const dialog = page.getByRole('dialog', {name: '新規フォルダを作成'});
        await dialog.getByRole('textbox', {name: 'フォルダ名'}).fill(name);
        await dialog.getByRole('button', {name: '新規フォルダを作成'}).click();
    };
    await createFolder('整理');
    await expect(row('destination/整理')).toBeVisible();
    await createFolder('整理');
    await expect(page.getByRole('alert')).toContainText('同じ名前のファイルまたはフォルダがあります。');
    await row('source').click();
    await expect(row('source/note.txt')).toBeVisible();

    const center = async item => {
        const box = await row(item).boundingBox();
        assert.ok(box);
        return [box.x + box.width / 2, box.y + box.height / 2];
    };
    const startDrag = async item => {
        const [x, y] = await center(item);
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 12, y, {steps: 4});
        await expect(row(item)).toHaveAttribute('data-move-unavailable', '');
    };
    const hover = async item => {
        const [x, y] = await center(item);
        await page.mouse.move(x, y);
        await page.mouse.move(x + 1, y);
    };

    await startDrag('source');
    assert.deepEqual(await page.evaluate(() => window.dragPreview), {name: 'source', icon: 'folder-open'});
    await expect(row('source/empty')).toHaveAttribute('data-move-unavailable', '');
    await expect(row('collision')).toHaveAttribute('data-move-unavailable', '');
    await expect(row('destination')).not.toHaveAttribute('data-move-unavailable', '');
    await hover('source/empty');
    await expect(active).toHaveCount(0);
    await hover('destination');
    await expect(row('destination')).toHaveAttribute('data-move-active', '');
    await expect(row('destination').locator('.twpf-explorer-name')).toHaveCSS('font-weight', '700');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(unavailable).toHaveCount(0);
    await expect(row('source/note.txt')).toBeVisible();

    await startDrag('source/note.txt');
    assert.deepEqual(await page.evaluate(() => window.dragPreview), {name: 'note.txt', icon: 'text'});
    await expect(row('source')).toHaveAttribute('data-move-unavailable', '');
    await expect(row('collision')).toHaveAttribute('data-move-unavailable', '');
    await expect(row('destination/整理')).not.toHaveAttribute('data-move-unavailable', '');
    await hover('destination/整理');
    await expect(row('destination/整理')).toHaveAttribute('data-move-active', '');
    await page.mouse.up();
    await expect(row('destination/整理/note.txt')).toBeVisible();
    await expect(row('source/note.txt')).toHaveCount(0);
    await expect(unavailable).toHaveCount(0);

    await startDrag('source');
    await expect(row('destination')).not.toHaveAttribute('data-move-unavailable', '');
    await hover('destination');
    await page.mouse.up();
    await expect(row('destination/source')).toBeVisible();
    await expect(row('source')).toHaveCount(0);
    await row('destination/source').click();
    await expect(row('destination/source/empty')).toBeVisible();
    assert.equal(await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const destination = await root.getDirectoryHandle('destination');
        const created = await destination.getDirectoryHandle('整理');
        return (await (await created.getFileHandle('note.txt')).getFile()).text();
    }), 'notes\0data');
});

const names = async page => page.locator('[role="treeitem"] .twpf-explorer-name').allTextContents();

test('shows unsaved and Git change markers in the file list', async t => {
    const page = await open(t);
    await page.evaluate(() => window.renderFileStatuses('ja'));
    const file = page.getByRole('treeitem', {name: 'project.source.json、未保存の変更あり、Git のインデックスに追加済み、保存済・未コミットの変更'});
    assert.equal(await file.locator('[data-tw-plus-unsaved-marker]').textContent(), ' *');
    await expect(file.locator('.twpf-explorer-name')).toHaveCSS('font-weight', '700');
    await expect(page.getByRole('treeitem', {name: 'README.md、未追跡'}).locator('.twpf-explorer-marker')).toHaveText('✨');
    await expect(page.getByRole('treeitem', {name: '.gitignore'}).locator('.twpf-explorer-marker')).toHaveCount(0);
    await page.locator('[data-path="docs"]').click();
    const deleted = page.locator('[data-path="docs/old.txt"]');
    await expect(deleted).toHaveAccessibleName(/削除/);
    await expect(deleted).toHaveAttribute('aria-disabled', 'true');
    await expect(deleted.locator('.twpf-explorer-name')).toHaveCSS('text-decoration-line', 'line-through');
    await page.locator('[data-path="old-folder"]').click();
    await expect(page.locator('[data-path="old-folder/old.txt"] .twpf-explorer-name')).toHaveCSS('text-decoration-line', 'line-through');
    await file.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.opened.at(-1).path), 'project.source.json');
});

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
    await expect(tree.getByRole('treeitem', {name: 'project.source.json, Saved, not committed, Project data'})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: 'README.md, Untracked'})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: 'README.md, Untracked'})).not.toHaveAttribute('aria-expanded');

    await assets.click();
    await expect(assets).toHaveAttribute('aria-expanded', 'true');
    const svg = tree.getByRole('treeitem', {name: `${a}.svg, Stage · backdrop backdrop1, Cat · costume cat-a`});
    await expect(svg).toHaveAttribute('aria-level', '2');
    await expect(tree.getByRole('treeitem', {name: `${c}.wav, Cat · sound Meow`})).toHaveAttribute('aria-level', '2');
    assert.deepEqual((await names(page)).slice(0, 4), ['assets', `${a}.svg`, `${b}.png`, `${c}.wav`]);
    assert.deepEqual(await page.evaluate(() => window.opened), [], 'a folder is not opened as a file');

    await svg.click();
    assert.deepEqual(await page.evaluate(() => window.opened), [{path: `assets/${a}.svg`, name: `${a}.svg`, kind: 'file'}]);
    await assets.click();
    await expect(assets).toHaveAttribute('aria-expanded', 'false');
    await expect(svg).toHaveCount(0);
});

test('places folder and file descriptions below their names in a narrow tree', async t => {
    const page = await open(t);
    await page.evaluate(async () => {
        document.getElementById('root').style.width = '235px';
        await window.renderExplorer('en');
    });
    const tree = page.getByRole('tree');
    const assets = tree.getByRole('treeitem', {name: 'assets, Costume and sound files'});
    await assets.click();
    const asset = tree.getByRole('treeitem', {name: `${a}.svg, Stage · backdrop backdrop1, Cat · costume cat-a`});
    const source = tree.getByRole('treeitem', {name: 'project.source.json, Saved, not committed, Project data'});
    for (const item of [assets, asset, source]) {
        const description = item.locator('.twpf-explorer-description');
        await expect(description).toBeVisible();
        await expect(description).toHaveCSS('background-color', 'rgba(128, 128, 128, 0.12)');
        const layout = await item.evaluate(row => {
            const label = row.querySelector('.twpf-explorer-label');
            const description = row.querySelector('.twpf-explorer-description');
            const labelBox = label.getBoundingClientRect();
            const descriptionBox = description.getBoundingClientRect();
            return {
                below: descriptionBox.top >= labelBox.bottom,
                aligned: descriptionBox.left === labelBox.left,
                fontScale: parseFloat(getComputedStyle(description).fontSize) / parseFloat(getComputedStyle(label).fontSize),
                fits: description.scrollWidth === description.clientWidth
            };
        });
        assert.deepEqual(layout, {below: true, aligned: true, fontScale: 0.75, fits: true});
    }
    const description = asset.locator('.twpf-explorer-description');
    assert.ok(await description.evaluate(element =>
        element.getBoundingClientRect().height > 2 * parseFloat(getComputedStyle(element).lineHeight)));
    await expect(asset).toHaveAttribute('title', `${a}.svg, Stage · backdrop backdrop1, Cat · costume cat-a`);
    await expect(tree.locator('[data-path="README.md"] .twpf-explorer-description')).toHaveCount(0);
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
    await expect(item(`${b}.png`)).toBeFocused();
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
    await expect(tree.getByRole('treeitem', {name: 'project.source.json、保存済・未コミットの変更、作品データ'})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: 'sb3-source.json、作品フォルダの目録'})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: 'embedded-extensions.json、埋め込み拡張の一覧'})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: 'README.md、未追跡'})).toBeVisible();
    await tree.getByRole('treeitem', {name: 'assets、コスチュームと音のファイル'}).click();
    await expect(tree.getByRole('treeitem', {name: `${a}.svg、ステージの背景 backdrop1、Cat のコスチューム cat-a`})).toBeVisible();
    await expect(tree.getByRole('treeitem', {name: `${c}.wav、Cat の音 Meow`})).toBeVisible();
    await expect(page.locator('.twpf-explorer-icon img:not([hidden])')).toHaveCount(2);
    const screenshot = process.env.TWPF_EXPLORER_SCREENSHOT;
    if (screenshot) await page.locator('#root').screenshot({path: screenshot});
});

test('shows an icon for each kind of entry and thumbnails for images', async t => {
    const page = await open(t);
    await page.evaluate(() => window.renderExplorer('en'));
    const tree = page.getByRole('tree');
    const row = file => tree.locator(`[data-path="${file}"]`);
    const icon = file => row(file).locator('.twpf-explorer-icon');
    const expectIcons = async kinds => {
        for (const [file, kind] of Object.entries(kinds)) await expect(icon(file), file).toHaveAttribute('data-icon', kind);
    };
    await expectIcons({'assets': 'folder', 'docs': 'folder', 'extensions': 'folder', '.gitignore': 'file',
        'embedded-extensions.json': 'json', 'project.source.json': 'project', 'sb3-source.json': 'project',
        'README.md': 'text'});

    const svgName = `${a}.svg, Stage · backdrop backdrop1, Cat · costume cat-a`;
    await row('assets').click();
    await row('docs').click();
    await row('extensions').click();
    await expectIcons({'assets': 'folder-open', [`assets/${a}.svg`]: 'image', [`assets/${b}.png`]: 'image',
        [`assets/${c}.wav`]: 'sound', 'docs/notes.txt': 'text', 'docs/scan.png': 'image', 'extensions/hello.js': 'code'});

    for (const file of [`assets/${a}.svg`, `assets/${b}.png`]) {
        await expect(icon(file)).toHaveAttribute('data-thumbnail', 'loaded');
        await expect(icon(file).locator('img')).toHaveAttribute('src', /^blob:/u);
        await expect(icon(file).locator('img')).toHaveAttribute('alt', '');
        await expect(icon(file).locator('svg')).toHaveCount(0);
    }
    await expect(row(`assets/${a}.svg`)).toHaveAttribute('aria-label', svgName);
    await expect(tree.getByRole('treeitem', {name: svgName})).toBeVisible();
    await expect(icon('docs/scan.png')).toHaveAttribute('data-thumbnail', 'skipped');
    await expect(icon('docs/scan.png').locator('img')).toHaveCount(0);
    await expect(icon('docs/scan.png').locator('svg')).toHaveCount(1);
    await expect(icon(`assets/${c}.wav`)).not.toHaveAttribute('data-thumbnail');

    // Collapsing a folder removes its rows, and their object URLs go with them.
    const urls = await page.evaluate(() => window.objectUrls);
    assert.equal(urls.created.length, 2);
    await row('assets').click();
    assert.deepEqual((await page.evaluate(() => window.objectUrls.revoked)).sort(), [...urls.created].sort());
    await row('assets').click();
    await expect(icon(`assets/${b}.png`)).toHaveAttribute('data-thumbnail', 'loaded');
    await page.evaluate(() => window.unmountExplorer());
    const after = await page.evaluate(() => window.objectUrls);
    assert.equal(after.created.length, 4);
    assert.deepEqual([...after.revoked].sort(), [...after.created].sort());
});

test('loads a thumbnail only when its row is shown', async t => {
    const page = await open(t);
    // The tree starts below the fold, and the folder is expanded without scrolling to it.
    await page.addStyleTag({content: '#root{margin-top:150vh}'});
    await page.evaluate(() => window.renderExplorer('en'));
    await page.locator('[data-path="assets"]').evaluate(button => button.click());
    const png = page.locator(`[data-path="assets/${b}.png"] .twpf-explorer-icon`);
    await expect(png).toHaveAttribute('data-thumbnail', 'waiting');
    await png.scrollIntoViewIfNeeded();
    await expect(png).toHaveAttribute('data-thumbnail', 'loaded');
});

test('shows a message in the tree when the folder cannot be read', async t => {
    const page = await open(t, {withFolder: false});
    await page.evaluate(() => window.renderDenied('ja'));
    await expect(page.getByRole('tree', {name: '作品フォルダ'}).getByRole('treeitem', {name: 'このフォルダを読む許可がありません。'}))
        .toBeVisible();
    await page.evaluate(() => window.renderDenied('en'));
    await expect(page.getByRole('treeitem', {name: 'Permission to read this folder was not granted.'})).toBeVisible();
});
