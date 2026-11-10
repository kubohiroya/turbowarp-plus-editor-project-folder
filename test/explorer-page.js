// Bundled by explorer.browser.js with React 16.14, the Editor's React version, and rendered over a dropped folder.
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {ProjectFolderExplorer, describeProjectFolder} from '../dist/explorer.js';

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

// A folder whose permission was withdrawn: reading its entries fails.
globalThis.renderDenied = locale => render({locale, directory: {kind: 'directory', name: 'Denied',
    async getDirectoryHandle() {throw new DOMException('denied', 'NotAllowedError');},
    async getFileHandle() {throw new DOMException('denied', 'NotAllowedError');},
    values() {
        return {[Symbol.asyncIterator]: () => ({next: () => Promise.reject(new DOMException('denied', 'NotAllowedError'))})};
    }}});
