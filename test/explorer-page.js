// Bundled by explorer.browser.js with React 16.14, the Editor's React version, and rendered over a dropped folder.
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {ProjectFolderExplorer, describeProjectFolder} from '../dist/explorer.js';

// Records object URLs, so a test can check that every thumbnail's URL is revoked.
globalThis.objectUrls = {created: [], revoked: []};
const {createObjectURL, revokeObjectURL} = URL;
URL.createObjectURL = object => {
    const url = createObjectURL(object);
    globalThis.objectUrls.created.push(url);
    return url;
};
URL.revokeObjectURL = url => {
    globalThis.objectUrls.revoked.push(url);
    revokeObjectURL(url);
};

const readJson = async (directory, name) => JSON.parse(await (await (await directory.getFileHandle(name)).getFile()).text());
const render = (props) => {
    globalThis.opened = [];
    ReactDOM.render(React.createElement(ProjectFolderExplorer, {...props, onOpen: entry => globalThis.opened.push(entry)}),
        document.getElementById('root'));
    return React.version;
};

globalThis.renderExplorer = async locale => {
    const directory = globalThis.droppedDirectory;
    const [project, manifest] = await Promise.all([readJson(directory, 'project.source.json'), readJson(directory, 'sb3-source.json')]);
    return render({directory, locale, descriptions: describeProjectFolder(project, locale, {manifest}),
        marks: new Map([['project.source.json', 'modified'], ['README.md', 'untracked']])});
};

globalThis.unmountExplorer = () => ReactDOM.unmountComponentAtNode(document.getElementById('root'));

globalThis.renderWritableExplorer = async () => {
    const directory = await navigator.storage.getDirectory();
    const source = await directory.getDirectoryHandle('source', {create: true});
    await source.getDirectoryHandle('empty', {create: true});
    const file = await source.getFileHandle('note.txt', {create: true});
    const stream = await file.createWritable();
    await stream.write('notes\0data');
    await stream.close();
    const collision = await directory.getDirectoryHandle('collision', {create: true});
    await collision.getDirectoryHandle('source', {create: true});
    await collision.getFileHandle('note.txt', {create: true});
    await directory.getDirectoryHandle('destination', {create: true});
    return render({directory, locale: 'ja', mutate: operation => operation(() => {})});
};

globalThis.renderFileStatuses = locale => render({directory: globalThis.droppedDirectory, locale,
    unsavedPaths: new Set(['project.source.json']),
    fileStatuses: new Map([
        ['project.source.json', {change: 'modified', staged: true}],
        ['README.md', {change: 'untracked'}],
        ['docs/old.txt', {change: 'deleted'}],
        ['old-folder/old.txt', {change: 'deleted'}]
    ])
});

// A folder whose permission was withdrawn: reading its entries fails.
globalThis.renderDenied = locale => render({locale, directory: {kind: 'directory', name: 'Denied',
    async getDirectoryHandle() {throw new DOMException('denied', 'NotAllowedError');},
    async getFileHandle() {throw new DOMException('denied', 'NotAllowedError');},
    values() {
        return {[Symbol.asyncIterator]: () => ({next: () => Promise.reject(new DOMException('denied', 'NotAllowedError'))})};
    }}});
