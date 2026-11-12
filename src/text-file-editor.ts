import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {css} from '@codemirror/lang-css';
import {html} from '@codemirror/lang-html';
import {javascript} from '@codemirror/lang-javascript';
import {json} from '@codemirror/lang-json';
import {markdown} from '@codemirror/lang-markdown';
import {python} from '@codemirror/lang-python';
import {xml} from '@codemirror/lang-xml';
import {yaml} from '@codemirror/lang-yaml';
import {HighlightStyle, StreamLanguage, syntaxHighlighting} from '@codemirror/language';
import {shell} from '@codemirror/legacy-modes/mode/shell';
import {MergeView} from '@codemirror/merge';
import {EditorState} from '@codemirror/state';
import {drawSelection, EditorView, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers} from '@codemirror/view';
import {tags} from '@lezer/highlight';
import type {FileBaseline} from './file-preview.js';

const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const encoder = new TextEncoder();

export function decodeText(bytes: ArrayBuffer | Uint8Array): string | null {
    try {
        const content = decoder.decode(bytes as ArrayBuffer | Uint8Array<ArrayBuffer>);
        return /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(content) ? null : content;
    } catch {
        return null;
    }
}

const languageFor = (extension: string) => {
    switch (extension) {
    case 'js': case 'mjs': case 'cjs': return javascript();
    case 'jsx': return javascript({jsx: true});
    case 'ts': case 'mts': case 'cts': return javascript({typescript: true});
    case 'tsx': return javascript({typescript: true, jsx: true});
    case 'json': case 'jsonc': return json();
    case 'yaml': case 'yml': return yaml();
    case 'md': case 'markdown': return markdown();
    case 'html': case 'htm': return html();
    case 'css': return css();
    case 'xml': return xml();
    case 'py': return python();
    case 'sh': case 'bash': return StreamLanguage.define(shell);
    default: return [];
    }
};

const highlighting = syntaxHighlighting(HighlightStyle.define([
    {tag: [tags.comment, tags.quote], class: 'twpf-syntax-comment'},
    {tag: [tags.keyword, tags.bool, tags.null, tags.meta], class: 'twpf-syntax-keyword'},
    {tag: [tags.string, tags.regexp], class: 'twpf-syntax-string'},
    {tag: [tags.propertyName, tags.attributeName, tags.tagName, tags.heading], class: 'twpf-syntax-name'},
    {tag: [tags.number, tags.atom, tags.literal], class: 'twpf-syntax-number'}
]));

const styles = `
.twpf-text-file{display:flex;flex-direction:column;height:100%;min-height:0;font:inherit}
.twpf-file-toolbar,.twpf-diff-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:.4rem;padding:.5rem .7rem;
border-bottom:1px solid var(--ui-black-transparent,rgba(128,128,128,.25))}
.twpf-file-path{font-size:.83em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-inline-end:auto;min-width:0}
.twpf-file-actions{display:flex;gap:.25rem}
.twpf-text-file button{font:inherit;font-size:.85em;color:inherit;background:transparent;border:1px solid
var(--ui-black-transparent,rgba(128,128,128,.45));border-radius:.3rem;padding:.25rem .55rem;cursor:pointer}
.twpf-text-file button[aria-pressed=true]{background:var(--motion-primary,#2468b7);border-color:transparent;color:#fff}
.twpf-text-file button:disabled{opacity:.55;cursor:default}
.twpf-file-status,.twpf-diff-status{margin:0;padding:.35rem .7rem;font-size:.82em}
.twpf-file-edit,.twpf-file-diff{flex:1;min-height:0}
.twpf-file-edit>.cm-editor{height:100%}
.twpf-file-diff{display:flex;flex-direction:column}
.twpf-text-file [hidden]{display:none}
.twpf-diff-headings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));font-size:.83em;
border-bottom:1px solid var(--ui-black-transparent,rgba(128,128,128,.25))}
.twpf-diff-headings span{padding:.4rem .7rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.twpf-diff-content{flex:1;min-height:0;overflow:auto}
.twpf-diff-content .cm-mergeViewEditor+.cm-mergeViewEditor{border-inline-start:1px solid var(--ui-black-transparent,rgba(128,128,128,.25))}
.twpf-text-file .cm-content{font:.875rem/1.55 monospace}
.twpf-text-file .cm-gutters{background:transparent;color:inherit;border-color:rgba(128,128,128,.25);font:.78rem/1.74 monospace}
.twpf-text-file .cm-activeLine,.twpf-text-file .cm-activeLineGutter{background:rgba(128,128,128,.12)}
.twpf-text-file .cm-collapsedLines{color:inherit;background:rgba(128,128,128,.12);border-color:rgba(128,128,128,.24)}
.twpf-syntax-comment{color:light-dark(#586576,#a6b0bc)}
.twpf-syntax-keyword{color:light-dark(#80359b,#dda7ef)}
.twpf-syntax-string{color:light-dark(#1b6c45,#9ddaac)}
.twpf-syntax-name{color:light-dark(#145e97,#99cfff)}
.twpf-syntax-number{color:light-dark(#8d440e,#f0b28a)}
`;

const messages = {
    en: {
        edit: 'Edit', diff: 'Diff', changes: 'Changes only', whole: 'Full file', refresh: 'Reload latest commit',
        save: 'Save file', unsaved: 'Unsaved changes', saving: 'Saving…', saved: 'File saved.',
        conflict: 'The file changed outside this tab. Your edits are still here. Reopen the file to load the current version.',
        saveFailed: 'The file could not be saved.', tooLarge: 'The text file exceeds the 4 MiB limit.',
        close: 'Discard the unsaved edits to this file?', loading: 'Reading the latest commit…',
        noGit: 'No accessible Git repository for this file. Select its repository in Local Git to compare.',
        readFailed: 'The committed version could not be read.', unsupported: 'The committed version is not a UTF-8 text file.',
        missing: 'This file is not in the latest commit.', unborn: 'This branch has no commits yet.',
        same: 'No differences.', formatting: 'The line endings or UTF-8 BOM differ.',
        before: 'Latest commit', after: 'Current content', collapsed: '$ unchanged lines'
    },
    ja: {
        edit: '編集', diff: '差分', changes: '変更箇所のみ', whole: '全体', refresh: '最新コミットを読み直す',
        save: 'ファイルを保存', unsaved: '未保存の変更があります', saving: '保存中…', saved: 'ファイルを保存しました。',
        conflict: 'ファイルがこのタブの外で変更されました。編集内容はタブに残っています。現在の内容を読むにはファイルを開き直してください。',
        saveFailed: 'ファイルを保存できませんでした。', tooLarge: 'テキストファイルの上限（4 MiB）を超えています。',
        close: 'このファイルの未保存の編集を破棄しますか？', loading: '最新コミットを読み込んでいます…',
        noGit: 'このファイルの Git リポジトリを参照できません。比較するにはローカル Git でリポジトリを選んでください。',
        readFailed: 'コミット済みの内容を読み込めませんでした。', unsupported: 'コミット済みの内容は UTF-8 テキストとして表示できません。',
        missing: '最新コミットにこのファイルはありません。', unborn: 'このブランチにはまだコミットがありません。',
        same: '差分はありません。', formatting: '改行コードまたは UTF-8 BOM が異なります。',
        before: '最新コミット', after: '現在の内容', collapsed: '変更のない $ 行'
    }
};

type TextFileOptions = {
    path: string;
    extension: string;
    content: string;
    locale: string;
    limit: number;
    readHandle(): Promise<FileSystemFileHandle>;
    readBaseline?(): Promise<FileBaseline | null>;
    close(): void;
};

export function mountTextFile(parent: HTMLElement, options: TextFileOptions) {
    const {ownerDocument: document} = parent;
    const browser = document.defaultView;
    const message = options.locale.toLowerCase().startsWith('ja') ? messages.ja : messages.en;
    const element = <Tag extends 'div' | 'span' | 'p'>(tag: Tag, className: string) => {
        const node = document.createElement(tag);
        node.className = className;
        return node;
    };
    const button = (label: string, action: () => void) => {
        const node = document.createElement('button');
        node.type = 'button';
        node.textContent = label;
        node.addEventListener('click', action);
        return node;
    };
    const press = (node: HTMLButtonElement, active: boolean) => node.setAttribute('aria-pressed', String(active));
    const setStatus = (node: HTMLElement, text: string) => {node.textContent = text; node.hidden = !text;};
    const panel = element('div', 'twpf-text-file');
    const style = document.createElement('style');
    style.textContent = styles;
    const toolbar = element('div', 'twpf-file-toolbar');
    const path = element('span', 'twpf-file-path');
    path.textContent = path.title = options.path;
    const status = element('p', 'twpf-file-status');
    status.setAttribute('role', 'status');
    const editPane = element('div', 'twpf-file-edit');
    const diffPane = element('div', 'twpf-file-diff');
    const diffToolbar = element('div', 'twpf-diff-toolbar');
    const headings = element('div', 'twpf-diff-headings');
    const left = element('span', '');
    const right = element('span', '');
    right.textContent = message.after;
    headings.append(left, right);
    const diffStatus = element('p', 'twpf-diff-status');
    diffStatus.setAttribute('role', 'status');
    const diffContent = element('div', 'twpf-diff-content');
    diffPane.append(diffToolbar, diffStatus, headings, diffContent);

    let saved = options.content;
    const bom = saved.startsWith('\uFEFF') ? '\uFEFF' : '';
    const initial = saved.slice(bom.length);
    const hasLF = initial.includes('\n');
    const hasCR = initial.includes('\r');
    const mixed = hasLF && hasCR && /(^|[^\r])\n|\r(?!\n)/u.test(initial);
    // When LF and CRLF are mixed, keep CRs in existing lines and use LF for new lines.
    const newline = hasCR && !mixed ? hasLF ? '\r\n' : '\r' : '\n';
    const common = [lineNumbers(), languageFor(options.extension), highlighting];
    let savedDoc = EditorState.create({doc: initial, extensions: mixed ? EditorState.lineSeparator.of('\n') : []}).doc;
    let merge: MergeView | undefined;
    let saving = false;
    let disposed = false;
    let comparison: boolean | undefined;
    let changesOnly = true;
    let readVersion = 0;
    const collapseUnchanged = {margin: 0, minSize: 1};
    const edit = button(message.edit, () => showDiff(false));
    const diff = button(message.diff, () => showDiff(true));
    const saveButton = button(message.save, () => void save());
    const changes = button(message.changes, () => changeVisibility(true));
    const whole = button(message.whole, () => changeVisibility(false));
    const refresh = button(message.refresh, () => void loadBaseline());
    const modes = element('div', 'twpf-file-actions');
    modes.append(edit, diff);
    toolbar.append(path, modes, saveButton);
    const ranges = element('div', 'twpf-file-actions');
    ranges.append(changes, whole);
    diffToolbar.append(ranges, refresh);
    panel.append(style, toolbar, status, editPane, diffPane);
    parent.append(panel);

    const view = new EditorView({
        parent: editPane, doc: savedDoc,
        extensions: [
            common, mixed ? EditorState.lineSeparator.of('\n') : [], history(), drawSelection(), highlightSpecialChars(),
            highlightActiveLine(), EditorView.contentAttributes.of({'aria-label': options.path}),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.updateListener.of(update => {if (update.docChanged) updateSaveState();})
        ]
    });
    const dirty = () => !view.state.doc.eq(savedDoc);
    const serialize = () => bom + (newline === '\n' ? view.state.doc.toString() : view.state.doc.toString().replace(/\n/gu, newline));

    function updateSaveState(text = saving ? message.saving : dirty() ? message.unsaved : '') {
        saveButton.disabled = saving || !dirty();
        setStatus(status, text);
    }

    async function unchanged(handle: FileSystemFileHandle) {
        try {
            const file = await handle.getFile();
            return file.size <= options.limit && decodeText(await file.arrayBuffer()) === saved;
        } catch (error) {
            if (['NotFoundError', 'TypeMismatchError'].includes((error as DOMException).name)) return false;
            throw error;
        }
    }

    async function save() {
        if (saving || disposed || !dirty()) return;
        const doc = view.state.doc;
        const content = serialize();
        const bytes = encoder.encode(content);
        if (bytes.byteLength > options.limit) return updateSaveState(message.tooLarge);
        saving = true;
        updateSaveState();
        let result = message.saveFailed;
        let writable: FileSystemWritableFileStream | undefined;
        try {
            const handle = await options.readHandle();
            if (!await unchanged(handle)) {
                result = message.conflict;
                return;
            }
            if (disposed) return;
            writable = await handle.createWritable({mode: 'exclusive'} as FileSystemCreateWritableOptions);
            await writable.write(bytes);
            const current = await options.readHandle();
            if (!await current.isSameEntry(handle) || !await unchanged(current)) {
                result = message.conflict;
                return;
            }
            if (disposed) return;
            await writable.close();
            writable = undefined;
            saved = content;
            savedDoc = doc;
            result = dirty() ? message.unsaved : message.saved;
        } catch (error) {
            if (['NotFoundError', 'TypeMismatchError'].includes((error as DOMException).name)) result = message.conflict;
        } finally {
            await writable?.abort().catch(() => {});
            saving = false;
            if (!disposed) updateSaveState(result);
        }
    }

    function destroyDiff() {
        merge?.destroy();
        merge = undefined;
    }

    function changeVisibility(onlyChanges: boolean) {
        changesOnly = onlyChanges;
        press(changes, onlyChanges);
        press(whole, !onlyChanges);
        merge?.reconfigure({collapseUnchanged: onlyChanges ? collapseUnchanged : undefined});
        diffContent.hidden = !merge || (onlyChanges && merge.chunks.length === 0);
    }

    function showDiff(active: boolean) {
        if (comparison === active) return;
        comparison = active;
        editPane.hidden = active;
        diffPane.hidden = !active;
        press(edit, !active);
        press(diff, active);
        if (active) void loadBaseline();
        else {
            ++readVersion;
            destroyDiff();
        }
    }

    async function loadBaseline() {
        const version = ++readVersion;
        destroyDiff();
        headings.hidden = true;
        changes.disabled = whole.disabled = true;
        refresh.disabled = true;
        changeVisibility(changesOnly);
        setStatus(diffStatus, message.loading);
        const current = () => !disposed && comparison && version === readVersion;
        try {
            const base = await options.readBaseline?.();
            if (!current()) return;
            if (!base) return setStatus(diffStatus, message.noGit);
            const text = base.bytes ? decodeText(base.bytes) : '';
            if (text === null) return setStatus(diffStatus, message.unsupported);
            const edited = serialize();
            if (encoder.encode(edited).byteLength > options.limit) return setStatus(diffStatus, message.tooLarge);
            left.textContent = [message.before, base.branch, base.head?.slice(0, 8)].filter(Boolean).join(' · ');
            left.title = base.head ?? left.textContent;
            const readOnly = (label: string) => [common, EditorState.readOnly.of(true), EditorView.editable.of(false),
                EditorView.contentAttributes.of({'aria-label': label, tabindex: '0'}),
                EditorState.phrases.of({'$ unchanged lines': message.collapsed})];
            merge = new MergeView({
                parent: diffContent,
                a: {doc: text.replace(/^\uFEFF/u, ''), extensions: readOnly(left.textContent)},
                b: {doc: edited.replace(/^\uFEFF/u, ''), extensions: readOnly(message.after)},
                diffConfig: {scanLimit: 500, timeout: 100}
            });
            headings.hidden = false;
            changes.disabled = whole.disabled = false;
            changeVisibility(changesOnly);
            const notice = !base.head ? message.unborn : !base.bytes ? message.missing :
                merge.chunks.length ? '' : text === edited ? message.same : message.formatting;
            setStatus(diffStatus, notice);
        } catch (error) {
            if (current()) setStatus(diffStatus, (error as {code?: string})?.code === 'large' ? message.tooLarge : message.readFailed);
        } finally {
            if (current()) refresh.disabled = !options.readBaseline;
        }
    }

    const beforeUnload = (event: BeforeUnloadEvent) => {
        if (!dirty()) return;
        event.preventDefault();
        event.returnValue = '';
    };
    panel.addEventListener('keydown', event => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
        event.preventDefault();
        event.stopPropagation();
        void save();
    });
    browser?.addEventListener('beforeunload', beforeUnload);
    showDiff(false);
    updateSaveState();
    return {
        requestClose() {
            if (!saving && (!dirty() || browser?.confirm(message.close))) options.close();
        },
        dispose() {
            disposed = true;
            browser?.removeEventListener('beforeunload', beforeUnload);
            destroyDiff();
            view.destroy();
            panel.remove();
        }
    };
}
