import {EditorView} from '@codemirror/view';
import {mountTextFile} from '../src/text-file-editor.ts';

globalThis.mountFile = async ({content, locale = 'ja', path = 'project.source.json', opfs = false}) => {
    globalThis.fileSession?.dispose();
    let saved = content;
    const handle = {
        getFile: async () => new File([saved], 'project.source.json'),
        isSameEntry: async other => other === handle,
        createWritable: async () => {
            let pending;
            return {write: async bytes => {pending = new TextDecoder().decode(bytes);},
                close: async () => {saved = pending;}, abort: async () => {}};
        }
    };
    let actualHandle;
    if (opfs) {
        const directory = await navigator.storage.getDirectory();
        actualHandle = await directory.getFileHandle(path, {create: true});
        const writable = await actualHandle.createWritable();
        await writable.write(content);
        await writable.close();
    }
    globalThis.fileSession = mountTextFile(document.getElementById('root'), {
        path, extension: path.split('.').pop(), content, locale, limit: 4 * 1024 * 1024,
        readHandle: async () => actualHandle ?? handle,
        readBaseline: async () => ({branch: 'main', head: 'abc12345', bytes: new TextEncoder().encode(content)}),
        close() {}
    });
    globalThis.readSaved = async () => actualHandle ? (await actualHandle.getFile()).text() : saved;
    globalThis.writeExternal = async text => {
        if (!actualHandle) {saved = text; return;}
        const writable = await actualHandle.createWritable();
        await writable.write(text);
        await writable.close();
    };
};

globalThis.replaceContent = content => {
    const view = EditorView.findFromDOM(document.querySelector('.twpf-file-edit .cm-editor'));
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: content}});
};
