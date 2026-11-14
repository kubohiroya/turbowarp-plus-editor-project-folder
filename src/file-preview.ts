interface FilePreviewSession {
    requestClose(): void;
    dispose(): void;
    save?: () => Promise<void>;
    readonly fileEdit?: {
        directory: FileSystemDirectoryHandle;
        path: string;
        isDirty(): boolean;
        readUnsaved(): Uint8Array | undefined;
        save(): Promise<void>;
    };
}

export interface FilePreviewRequest {
    reference: {providerId: string; documentId: string};
    filename: string;
    title: string;
    transient: true;
    mount(element: HTMLElement, close: () => void, onSaveAvailable?: () => void): FilePreviewSession;
}

export type FileBaseline = {branch: string | undefined; head: string | null; bytes: Uint8Array | null};
export type ReadFileBaseline = (directory: FileSystemDirectoryHandle, path: string, limit: number) =>
    Promise<FileBaseline | null>;

const mimeTypes = new Map(Object.entries({
    apng: 'image/apng', avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', ico: 'image/x-icon',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
    aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac', m4a: 'audio/mp4',
    mp3: 'audio/mpeg', oga: 'audio/ogg', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
    m4v: 'video/mp4', mov: 'video/quicktime', mp4: 'video/mp4', ogv: 'video/ogg', webm: 'video/webm'
}));
export const textLimit = 4 * 1024 * 1024;

const styles = `
.twpf-preview{box-sizing:border-box;height:100%;overflow:auto;padding:1rem;color:var(--text-primary,inherit);
background:var(--ui-primary,transparent)}
.twpf-preview:has(.twpf-text-file){padding:0;overflow:hidden}
.twpf-preview img,.twpf-preview video{display:block;max-width:100%;max-height:100%;margin:auto;object-fit:contain}
.twpf-preview audio{width:min(100%,32rem)}
`;

const messages = {
    en: {
        loading: 'Loading file…', failed: 'This file could not be read.',
        unsupported: 'This file cannot be previewed.', mediaError: 'This media could not be opened.',
        large: 'This text file is too large to open (4 MiB limit).'
    },
    ja: {
        loading: 'ファイルを読み込んでいます…', failed: 'このファイルを読み込めません。',
        unsupported: 'このファイルはプレビューできません。', mediaError: 'このメディアを開けません。',
        large: 'このテキストファイルは開けるサイズの上限（4 MiB）を超えています。'
    }
};

async function fileAt(directory: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
    const parts = path.split('/');
    const name = parts.pop()!;
    for (const part of parts) directory = await directory.getDirectoryHandle(part);
    return directory.getFileHandle(name);
}

export function createFilePreview(directory: FileSystemDirectoryHandle, documentId: string,
    {name, path}: {name: string; path: string}, locale: string, readBaseline?: ReadFileBaseline): FilePreviewRequest {
    return {
        reference: {providerId: 'turbowarp-plus-project-folder', documentId},
        filename: name,
        title: name,
        transient: true,
        mount(element, close, onSaveAvailable) {
            const message = locale.toLowerCase().startsWith('ja') ? messages.ja : messages.en;
            const {ownerDocument: document} = element;
            const panel = document.createElement('div');
            panel.className = 'twpf-preview';
            const style = document.createElement('style');
            style.textContent = styles;
            const status = document.createElement('p');
            status.setAttribute('role', 'status');
            status.textContent = message.loading;
            panel.append(style, status);
            element.append(panel);
            let disposed = false;
            let url: string | undefined;
            let media: HTMLMediaElement | undefined;
            let textSession: ReturnType<typeof import('./text-file-editor.js').mountTextFile> | undefined;
            const readHandle = () => fileAt(directory, path);

            const show = (node: HTMLElement) => status.replaceWith(node);
            const load = async () => {
                const file = await (await readHandle()).getFile();
                if (disposed) return;
                const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
                const mime = mimeTypes.get(extension) ?? file.type;
                const kind = mime.split('/')[0];
                if (kind === 'image' || kind === 'audio' || kind === 'video') {
                    url = URL.createObjectURL(mime === file.type ? file : file.slice(0, file.size, mime));
                    const view = document.createElement(kind === 'image' ? 'img' : kind);
                    view.addEventListener('error', () => {
                        status.textContent = message.mediaError;
                        view.replaceWith(status);
                    }, {once: true});
                    if (view.tagName === 'IMG') {
                        // An SVG loaded through an img cannot run scripts in the editor.
                        (view as HTMLImageElement).alt = name;
                    } else {
                        media = view as HTMLMediaElement;
                        media.controls = true;
                        media.preload = 'metadata';
                        media.setAttribute('aria-label', name);
                    }
                    view.src = url;
                    show(view);
                    return;
                }
                if (file.size > textLimit) {
                    status.textContent = message.large;
                    return;
                }
                const [bytes, {decodeText, mountTextFile}] = await Promise.all([
                    file.arrayBuffer(), import('./text-file-editor.js')
                ]);
                if (disposed) return;
                const content = decodeText(bytes);
                if (content === null) {
                    status.textContent = message.unsupported;
                    return;
                }
                textSession = mountTextFile(panel, {
                    path, extension, content, locale, limit: textLimit, readHandle, close,
                    readBaseline: readBaseline && (() => readBaseline(directory, path, textLimit)),
                    hostSaveShortcut: Boolean(onSaveAvailable), onDirtyChange: onSaveAvailable
                });
                status.remove();
                onSaveAvailable?.();
            };
            void load().catch(() => {if (!disposed) status.textContent = message.failed;});
            return {
                get save() {return textSession?.save;},
                get fileEdit() {return textSession && {directory, path, isDirty: textSession.isDirty,
                    readUnsaved: textSession.readUnsaved, save: textSession.save};},
                requestClose() {if (textSession) textSession.requestClose(); else close();},
                dispose() {
                    disposed = true;
                    textSession?.dispose();
                    media?.pause();
                    if (url) URL.revokeObjectURL(url);
                    panel.remove();
                }
            };
        }
    };
}
