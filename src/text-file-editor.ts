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
import {Compartment, EditorState} from '@codemirror/state';
import {drawSelection, EditorView, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers} from '@codemirror/view';
import {tags} from '@lezer/highlight';
import type {FileBaseline} from './file-preview.js';
import {textMinimap} from './text-minimap.js';
import {connectExternalFileEditor} from './external-file-editor.js';

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
.twpf-text-shell{position:relative;height:100%;min-height:0}
.twpf-text-file{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;font:inherit}
.twpf-text-file[inert]{opacity:.45}
.twpf-external-overlay{position:absolute;z-index:10;inset:0;display:flex;align-items:center;justify-content:center;
background:rgba(128,128,128,.16);padding:1rem;box-sizing:border-box}
.twpf-external-overlay[hidden]{display:none}
.twpf-external-card{max-width:28rem;padding:1rem;border-radius:.5rem;background:var(--ui-primary,#fff);
color:var(--text-primary,inherit);box-shadow:0 3px 15px rgba(0,0,0,.2);font:inherit}
.twpf-external-card h3{margin:0 0 .7rem;font-size:1rem}
.twpf-external-card p{margin:0 0 1rem;font-size:.9rem}
.twpf-external-card div{display:flex;flex-wrap:wrap;gap:.5rem}
.twpf-external-card button{font:inherit;color:inherit;border:1px solid var(--ui-black-transparent,#888);
border-radius:.3rem;background:var(--ui-secondary,#eee);padding:.4rem .6rem;cursor:pointer}
.twpf-external-card button:disabled{opacity:.55;cursor:default}
.twpf-file-toolbar{position:absolute;z-index:5;top:.5rem;right:1.25rem;display:flex;flex-wrap:wrap;
justify-content:flex-end;gap:.4rem;max-width:calc(100% - 2rem);padding:.3rem;border-radius:.5rem;
background:var(--ui-primary,#fff);box-shadow:0 1px 6px rgba(0,0,0,.18);opacity:.94}
.twpf-diff-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:.4rem;padding:.5rem .7rem;
border-bottom:1px solid var(--ui-black-transparent,rgba(128,128,128,.25))}
.twpf-file-actions{display:flex;gap:.25rem}
.twpf-file-modes{display:inline-flex;overflow:hidden;border:1px solid var(--ui-black-transparent,rgba(128,128,128,.35));
border-radius:999px;background:var(--ui-secondary,rgba(128,128,128,.1))}
.twpf-text-file .twpf-file-modes>button{border:0;border-radius:0;background:transparent;white-space:nowrap}
.twpf-text-file .twpf-file-modes>button+button{border-inline-start:1px solid var(--ui-black-transparent,rgba(128,128,128,.35))}
.twpf-file-modes>button[aria-checked=true]{background:var(--motion-primary,#2468b7);color:#fff}
.twpf-file-modes>button:focus-visible{outline:2px solid var(--motion-primary,#2468b7);outline-offset:-3px}
.twpf-text-file button{font:inherit;font-size:.85em;color:inherit;background:transparent;border:1px solid
var(--ui-black-transparent,rgba(128,128,128,.45));border-radius:.3rem;padding:.25rem .55rem;cursor:pointer}
.twpf-text-file button[aria-pressed=true]{background:var(--motion-primary,#2468b7);border-color:transparent;color:#fff}
.twpf-text-file button:disabled{opacity:.55;cursor:default}
.twpf-text-file button:has(svg){display:inline-flex;align-items:center;justify-content:center;gap:.3rem}
.twpf-text-file button svg{width:1rem;height:1rem;flex:none}
.twpf-file-status,.twpf-diff-status{margin:0;padding:.35rem .7rem;font-size:.82em}
.twpf-file-status{position:absolute;z-index:5;bottom:.5rem;left:.5rem;max-width:calc(100% - 10rem);
max-height:40%;overflow:auto;border-radius:.3rem;background:var(--ui-primary,#fff);box-shadow:0 1px 6px rgba(0,0,0,.18)}
.twpf-file-snackbar{position:absolute;z-index:6;bottom:1rem;left:50%;transform:translateX(-50%);
box-sizing:border-box;max-width:calc(100% - 2rem);margin:0;padding:.65rem 1rem;border-radius:.35rem;
background:#323232;color:#fff;font-size:.9em;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none}
.twpf-file-edit,.twpf-file-diff{flex:1;min-height:0}
.twpf-file-diff{padding-top:var(--twpf-toolbar-height,3.25rem)}
.twpf-file-edit>.cm-editor{height:100%}
.twpf-text-file .cm-scroller{overflow:auto}
.twpf-text-minimap{position:absolute;z-index:4;right:1.25rem;bottom:1.25rem;width: min(7rem,25%);
height:min(10.5rem,35%);overflow:hidden;border:1px solid var(--ui-black-transparent,rgba(128,128,128,.4));
border-radius:.3rem;background:var(--ui-primary,#fff);opacity:.85;cursor:pointer;touch-action:none}
.twpf-text-minimap:focus-visible{outline:2px solid var(--motion-primary,#2468b7);outline-offset:2px}
.twpf-text-minimap canvas{display:block;width:100%;height:100%;pointer-events:none}
.twpf-text-minimap-viewport{position:absolute;left:0;right:0;box-sizing:border-box;min-height:2px;
border:1px solid var(--motion-primary,#2468b7);background:rgba(76,151,255,.2);pointer-events:none}
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
        text: 'Normal view', textHint: 'Edit the file content in this tab', diff: 'Diff view', diffHint: 'Compare with the latest commit',
        viewMode: 'View mode', external: 'Edit in VSCode', importExternal: 'Finish and import edits',
        externalTitle: 'Editing in VSCode', cancelExternal: 'Finish without importing',
        externalUnavailable: 'Open the Editor through the local companion to edit this file in VSCode.',
        externalOpening: 'Opening VSCode…', externalHint: 'Save in VSCode, then choose “Finish and import edits”. This tab stays locked until you finish.',
        externalReading: 'Reading external edits…', externalImported: 'External edits imported. Save the file to keep them.',
        externalFailed: 'External editing failed. Your edits are still here. Check the local companion and try again.',
        externalReplace: 'This tab has also changed. Replace its current content with the file saved in VSCode?',
        externalChanged: 'This tab changed while reading. Import the external edits again to compare.',
        changes: 'Changes only', whole: 'Full file', refresh: 'Reload latest commit',
        save: 'Save file', unsaved: 'Unsaved changes', saving: 'Saving…', saved: 'Saved.',
        conflict: 'The file changed outside this tab. Your edits are still here. Reopen the file to load the current version.',
        saveFailed: 'The file could not be saved.', tooLarge: 'The text file exceeds the 4 MiB limit.',
        close: 'Discard the unsaved edits to this file?', loading: 'Reading the latest commit…',
        noGit: 'No accessible Git repository for this file. Select its repository in Local Git to compare.',
        readFailed: 'The committed version could not be read.', unsupported: 'The committed version is not a UTF-8 text file.',
        missing: 'This file is not in the latest commit.', unborn: 'This branch has no commits yet.',
        same: 'No differences.', formatting: 'The line endings or UTF-8 BOM differ.',
        before: 'Latest commit', after: 'Current content', collapsed: '$ unchanged lines', minimap: 'File minimap'
    },
    ja: {
        text: '通常表示', textHint: 'この画面でファイルの内容を編集', diff: '差分表示', diffHint: '最新コミットと現在の内容を比較',
        viewMode: '表示モード', external: 'VSCodeで編集', importExternal: '終了して取り込む',
        externalTitle: 'VSCodeで編集中', cancelExternal: '取り込まずに終了',
        externalUnavailable: 'VSCodeで編集するには、ローカル連携からEditorを開いてください。',
        externalOpening: 'VSCodeを開いています…', externalHint: 'VSCodeで保存後、「終了して取り込む」を押してください。終了までこのタブの操作はできません。',
        externalReading: '外部の編集内容を読み込んでいます…', externalImported: '外部編集を取り込みました。ファイルを保存してください。',
        externalFailed: '外部編集を利用できませんでした。編集内容は保持しています。ローカル連携を確認して再試行してください。',
        externalReplace: 'この画面にも変更があります。VSCodeで保存した内容で、この画面の内容を置き換えますか？',
        externalChanged: '読み込み中にこの画面の内容が変わりました。もう一度取り込みを行ってください。',
        changes: '変更箇所のみ', whole: '全体', refresh: '最新コミットを読み直す',
        save: 'ファイルを保存', unsaved: '未保存の変更があります', saving: '保存中…', saved: '保存しました',
        conflict: 'ファイルがこのタブの外で変更されました。編集内容はタブに残っています。現在の内容を読むにはファイルを開き直してください。',
        saveFailed: 'ファイルを保存できませんでした。', tooLarge: 'テキストファイルの上限（4 MiB）を超えています。',
        close: 'このファイルの未保存の編集を破棄しますか？', loading: '最新コミットを読み込んでいます…',
        noGit: 'このファイルの Git リポジトリを参照できません。比較するにはローカル Git でリポジトリを選んでください。',
        readFailed: 'コミット済みの内容を読み込めませんでした。', unsupported: 'コミット済みの内容は UTF-8 テキストとして表示できません。',
        missing: '最新コミットにこのファイルはありません。', unborn: 'このブランチにはまだコミットがありません。',
        same: '差分はありません。', formatting: '改行コードまたは UTF-8 BOM が異なります。',
        before: '最新コミット', after: '現在の内容', collapsed: '変更のない $ 行', minimap: 'ファイルのミニマップ'
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
    hostSaveShortcut?: boolean;
    onDirtyChange?(): void;
};

export function mountTextFile(parent: HTMLElement, options: TextFileOptions) {
    const {ownerDocument: document} = parent;
    const browser = document.defaultView;
    const message = options.locale.toLowerCase().startsWith('ja') ? messages.ja : messages.en;
    const element = <Tag extends 'div' | 'span' | 'p' | 'h3'>(tag: Tag, className: string) => {
        const node = document.createElement(tag);
        node.className = className;
        return node;
    };
    const button = (label: string, action: () => void, icon?: string) => {
        const node = document.createElement('button');
        node.type = 'button';
        node.textContent = label;
        if (icon) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.8');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('aria-hidden', 'true');
            svg.setAttribute('focusable', 'false');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', icon);
            svg.append(path);
            node.prepend(svg);
        }
        node.addEventListener('click', action);
        return node;
    };
    const press = (node: HTMLButtonElement, active: boolean) => node.setAttribute('aria-pressed', String(active));
    const setStatus = (node: HTMLElement, text: string) => {node.textContent = text; node.hidden = !text;};
    const shell = element('div', 'twpf-text-shell');
    const panel = element('div', 'twpf-text-file');
    const style = document.createElement('style');
    style.textContent = styles;
    const toolbar = element('div', 'twpf-file-toolbar');
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', options.path);
    const status = element('p', 'twpf-file-status');
    status.setAttribute('role', 'status');
    const snackbar = element('p', 'twpf-file-snackbar');
    snackbar.setAttribute('role', 'status');
    snackbar.setAttribute('aria-atomic', 'true');
    snackbar.hidden = true;
    let snackbarTimeout: number | undefined;
    const hideSnackbar = () => {
        browser?.clearTimeout(snackbarTimeout);
        snackbarTimeout = undefined;
        setStatus(snackbar, '');
    };
    const showSaved = () => {
        hideSnackbar();
        setStatus(snackbar, message.saved);
        snackbarTimeout = browser?.setTimeout(hideSnackbar, 4000);
    };
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
    let externalBusy = false;
    let externalLocked = false;
    let externalEditor: Awaited<ReturnType<typeof connectExternalFileEditor>> = null;
    let externalOriginal: string | undefined;
    let disposed = false;
    let comparison: boolean | undefined;
    let changesOnly = true;
    let readVersion = 0;
    let baselineLoading = false;
    const collapseUnchanged = {margin: 0, minSize: 1};
    const text = button(message.text, () => showDiff(false), 'M14 3H5v18h14V8l-5-5v5h5M8 12h8M8 16h8');
    text.title = message.textHint;
    const diff = button(message.diff, () => showDiff(true), 'M4 3h16v18H4zM12 3v18M6.5 8h3M14.5 8h3M16 6.5v3');
    diff.title = message.diffHint;
    const saveButton = button(message.save, () => void save(), 'M4 3h13l4 4v14H3V3h1M7 3v6h10V3M7 21v-8h10v8');
    const externalButton = button(message.external, () => void openExternal(), 'M14 3h7v7M21 3l-11 11M11 5H3v16h16v-8');
    externalButton.disabled = true;
    externalButton.title = message.externalUnavailable;
    const overlay = element('div', 'twpf-external-overlay');
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', message.externalTitle);
    const externalCard = element('div', 'twpf-external-card');
    const externalTitle = element('h3', '');
    externalTitle.textContent = message.externalTitle;
    const externalStatus = element('p', '');
    externalStatus.setAttribute('role', 'status');
    const importButton = button(message.importExternal, () => void importExternal());
    const cancelExternal = button(message.cancelExternal, () => {
        if (externalBusy || disposed) return;
        externalEditor?.end();
        setExternalLocked(false);
        updateSaveState();
        externalButton.focus();
    });
    const externalActions = element('div', '');
    externalActions.append(importButton, cancelExternal);
    externalCard.append(externalTitle, externalStatus, externalActions);
    overlay.append(externalCard);
    const changes = button(message.changes, () => changeVisibility(true));
    const whole = button(message.whole, () => changeVisibility(false));
    const refresh = button(message.refresh, () => void loadBaseline());
    const modes = element('div', 'twpf-file-modes');
    modes.setAttribute('role', 'radiogroup');
    modes.setAttribute('aria-label', message.viewMode);
    text.setAttribute('role', 'radio');
    diff.setAttribute('role', 'radio');
    modes.append(text, diff);
    modes.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const active = event.key === 'Home' ? false : event.key === 'End' ? true : !comparison;
        showDiff(active);
        (active ? diff : text).focus();
    });
    toolbar.append(modes, saveButton, externalButton);
    const ranges = element('div', 'twpf-file-actions');
    ranges.append(changes, whole);
    diffToolbar.append(ranges, refresh);
    panel.append(style, toolbar, status, snackbar, editPane, diffPane);
    shell.append(panel, overlay);
    parent.append(shell);
    const toolbarObserver = browser && new browser.ResizeObserver(() => {
        panel.style.setProperty('--twpf-toolbar-height', `calc(${toolbar.getBoundingClientRect().height}px + 1rem)`);
    });
    toolbarObserver?.observe(toolbar);

    const editing = new Compartment();
    const view = new EditorView({
        parent: editPane, doc: savedDoc,
        extensions: [
            common, editing.of([]), mixed ? EditorState.lineSeparator.of('\n') : [], history(), drawSelection(), highlightSpecialChars(),
            highlightActiveLine(), textMinimap(message.minimap),
            EditorView.contentAttributes.of({'aria-label': options.path}),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.updateListener.of(update => {if (update.docChanged) updateSaveState(undefined, true);})
        ]
    });
    const dirty = () => !view.state.doc.eq(savedDoc);
    const serialize = () => bom + (newline === '\n' ? view.state.doc.toString() : view.state.doc.toString().replace(/\n/gu, newline));

    let wasDirty = false;
    function updateSaveState(text = saving ? message.saving : dirty() ? message.unsaved : '', contentChanged = false) {
        const isDirty = dirty();
        saveButton.disabled = saving || externalBusy || externalLocked || !isDirty;
        externalButton.disabled = saving || externalBusy || externalLocked || !externalEditor;
        importButton.disabled = saving || externalBusy;
        cancelExternal.disabled = externalBusy;
        setStatus(status, text);
        if (isDirty !== wasDirty || contentChanged && isDirty) {
            wasDirty = isDirty;
            options.onDirtyChange?.();
        }
    }

    function setExternalLocked(active: boolean) {
        externalLocked = active;
        if (active) {
            for (const button of panel.querySelectorAll('button')) {
                button.disabled = true;
            }
        } else {
            text.disabled = diff.disabled = false;
            changes.disabled = whole.disabled = baselineLoading || !merge;
            refresh.disabled = baselineLoading || !options.readBaseline;
        }
        panel.inert = active;
        overlay.hidden = !active;
        view.dispatch({effects: editing.reconfigure(active ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [])});
        updateSaveState(status.textContent || '');
    }

    async function openExternal() {
        if (!externalEditor || saving || externalBusy || disposed) return;
        externalBusy = true;
        setExternalLocked(true);
        externalStatus.textContent = message.externalOpening;
        updateSaveState(message.externalOpening);
        const initial = serialize();
        const reopening = externalEditor.active;
        try {
            await externalEditor.open(initial);
            if (disposed) return;
            if (!reopening) externalOriginal = initial;
            externalStatus.textContent = message.externalHint;
            updateSaveState(message.externalHint);
            importButton.focus();
        } catch {
            if (!disposed) {
                setExternalLocked(false);
                updateSaveState(message.externalFailed);
            }
        } finally {
            externalBusy = false;
            if (!disposed) {
                updateSaveState(status.textContent || '');
                if (externalLocked) importButton.focus();
            }
        }
    }

    async function importExternal() {
        if (!externalEditor?.active || saving || externalBusy || disposed) return;
        externalBusy = true;
        externalStatus.textContent = message.externalReading;
        updateSaveState(message.externalReading);
        const beforeRead = serialize();
        try {
            const source = await externalEditor.read();
            if (disposed) return;
            if (serialize() !== beforeRead) {
                externalStatus.textContent = message.externalChanged;
                return updateSaveState(message.externalChanged);
            }
            if (beforeRead !== externalOriginal && source !== beforeRead && !browser?.confirm(message.externalReplace)) {
                externalStatus.textContent = message.externalHint;
                return updateSaveState();
            }
            const imported = EditorState.create({doc: source.replace(/^\uFEFF/u, ''),
                extensions: mixed ? EditorState.lineSeparator.of('\n') : []}).doc;
            view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: imported}});
            externalOriginal = serialize();
            externalEditor.end();
            setExternalLocked(false);
            showDiff(false);
            updateSaveState(message.externalImported);
            view.focus();
        } catch {
            if (!disposed) {
                externalStatus.textContent = message.externalFailed;
                updateSaveState(message.externalFailed);
            }
        } finally {
            externalBusy = false;
            if (!disposed) updateSaveState(status.textContent || '');
        }
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
        if (saving || externalBusy || externalLocked || disposed || !dirty()) return;
        const doc = view.state.doc;
        const content = serialize();
        const bytes = encoder.encode(content);
        if (bytes.byteLength > options.limit) return updateSaveState(message.tooLarge);
        hideSnackbar();
        saving = true;
        updateSaveState();
        let result = message.saveFailed;
        let didSave = false;
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
            didSave = true;
            result = dirty() ? message.unsaved : '';
        } catch (error) {
            if (['NotFoundError', 'TypeMismatchError'].includes((error as DOMException).name)) result = message.conflict;
        } finally {
            await writable?.abort().catch(() => {});
            saving = false;
            if (!disposed) {
                updateSaveState(result);
                if (didSave) showSaved();
            }
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
        text.setAttribute('aria-checked', String(!active));
        diff.setAttribute('aria-checked', String(active));
        text.tabIndex = active ? -1 : 0;
        diff.tabIndex = active ? 0 : -1;
        if (active) void loadBaseline();
        else {
            ++readVersion;
            baselineLoading = false;
            destroyDiff();
        }
    }

    async function loadBaseline() {
        const version = ++readVersion;
        baselineLoading = true;
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
            changes.disabled = whole.disabled = externalLocked;
            changeVisibility(changesOnly);
            const notice = !base.head ? message.unborn : !base.bytes ? message.missing :
                merge.chunks.length ? '' : text === edited ? message.same : message.formatting;
            setStatus(diffStatus, notice);
        } catch (error) {
            if (current()) setStatus(diffStatus, (error as {code?: string})?.code === 'large' ? message.tooLarge : message.readFailed);
        } finally {
            if (current()) {
                baselineLoading = false;
                refresh.disabled = externalLocked || !options.readBaseline;
            }
        }
    }

    const beforeUnload = (event: BeforeUnloadEvent) => {
        if (!dirty() && !externalLocked) return;
        event.preventDefault();
        event.returnValue = '';
    };
    panel.addEventListener('keydown', event => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
        // Let the main window's save shortcut choose the target when the host manages it.
        if (options.hostSaveShortcut && panel.ownerDocument === document) return;
        event.preventDefault();
        event.stopPropagation();
        void save();
    });
    browser?.addEventListener('beforeunload', beforeUnload);
    showDiff(false);
    updateSaveState();
    if (browser) void connectExternalFileEditor(browser, options.path.split('/').pop()!, options.extension, options.limit)
        .then(editor => {
            if (disposed) {editor?.close(); return;}
            externalEditor = editor;
            if (editor) externalButton.title = message.external;
            updateSaveState(status.textContent || '');
        });
    return {
        save,
        isDirty: dirty,
        readUnsaved: () => !disposed && dirty() ? encoder.encode(serialize()) : undefined,
        requestClose() {
            if (!saving && !externalLocked && (!dirty() || browser?.confirm(message.close))) options.close();
        },
        dispose() {
            disposed = true;
            hideSnackbar();
            toolbarObserver?.disconnect();
            externalEditor?.close();
            browser?.removeEventListener('beforeunload', beforeUnload);
            destroyDiff();
            view.destroy();
            shell.remove();
        }
    };
}
