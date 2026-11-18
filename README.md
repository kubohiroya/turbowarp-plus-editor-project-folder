# TurboWarp Plus Editor Project Folder

[日本語](README.ja.md)

This package opens and saves sb3-toolchain project folders (source formats 1 and 2) in TurboWarp Plus Editor. It loads the project JSON and local image and audio assets directly from a directory handle. Saving updates `project.source.json` in the selected folder and checks the source for external changes before writing.

## Integration

- `mountProjectFolder({vm, document, host})` attaches the folder session to a workspace. Call `dispose()` when the workspace is replaced.
- `renderProjectFolderMenu(createElement, props)` supplies the existing open and save commands to the host's file menu.
- A chosen folder with no project of its own opens its `project` folder instead, as in a repository made by Project Starter, when that folder is a valid project folder and has no `.git` of its own. Otherwise the error for the chosen folder stays.
- The mounted session's `openDirectory(handle, confirmReplace, root?)` accepts a directory handle already selected by the host. It uses the same project validation, `project` fallback and unsaved-edit confirmation as the file menu. Save still targets the opened project folder. `root` names the folder the user chose, for a host that located the project itself; it defaults to `handle`.
- The mounted session's `directory` is the folder the loaded project came from. It becomes `null` once another project loads or the folder is detached, so a host can tell projects apart by it.
- The mounted session's `root` is the folder the user chose for that project: `directory` itself, the repository whose `project` folder is `directory`, or, for a folder kept in the browser, its stored folder. It is `null` whenever `directory` is. The browser cannot read a folder's parent, so a host binds a Git repository to `root`.
- `host.screenState` keeps the Editor's screen state in the folder, as the workbench's `installProjectScreenState` provides it. A project folder is not an SB3, so the state goes into `.tw-plus/workspace.json`. Opening the folder reads it and passes it with `prepareLoad(text)` before the project loads. Saving writes `serialize()`, even when the project itself is unchanged, and skips the write when only the save time differs. A failure to read or write it never fails the open or the save. The session also registers the `projectFolder` slice: the expanded folders and the selected entry of the explorer. When a folder is created from an SB3, a `.tw-plus/workspace.json` in the snapshot sb3-toolchain (0.26.0 or later) unpacked is written into the folder as it is, so the new folder opens with the same screen. A snapshot without one removes the old `workspace.json` of the folder it overwrites, and keeps the other files in `.tw-plus`.

The host supplies the VM, menu components, and project state callbacks. The built-in open command needs the File System Access folder picker or [project folders in the browser](#project-folders-in-the-browser). Save writes block, variable, list, sprite property, monitor and built-in extension edits to the project file, including state that changes while the project runs. Sprites can be added, removed and renamed, and costumes and sounds added or removed: new asset files are written first, then `sb3-source.json` and the project file, and asset files nothing refers to are deleted last. See [Editor issue #305](https://github.com/kubohiroya/turbowarp-plus-editor/issues/305) and [issue #308](https://github.com/kubohiroya/turbowarp-plus-editor/issues/308).

The project file keeps system and web font references. Embedded font files are saved in `assets/`.

Folders can contain embedded extension scripts and custom extension URLs. Opening a folder restores embedded scripts as data URLs and uses the Editor's extension review. Saving preserves unchanged extension files and metadata, and reports when replacing a script removes its recorded source. See [拡張機能](README.ja.md#拡張機能).

## Project folders in the browser

Safari and Firefox have no folder picker (`showDirectoryPicker`). In these browsers, project folders live in the browser's own storage, the origin private file system (OPFS). They are read and saved the same way as folders on the device. See [Editor issue #660](https://github.com/kubohiroya/turbowarp-plus-editor/issues/660).

- `browserStorage` of `mountProjectFolder` chooses how they are used.
  - `fallback` (default): only in browsers without the folder picker. **Open Folder…** lists the folders in the browser, and `createFromSnapshot` asks for the name of a new folder (`title` gives the initial name).
  - `always`: also in browsers with the folder picker. The File menu gets **Open Folder Saved in This Browser…**, and `projectFolderActions(vm).openBrowser` opens it too.
  - `off`: never.
- The dialog opens, exports as a ZIP, and deletes the folders. It shows how much storage is used and whether the browser keeps it (`persisted`). Its close button is an X icon named in the display language.
- A folder lives at `turbowarp-plus/projects/<id>/`, and its name and times at `turbowarp-plus/project-info/<id>.json`, outside the folder, so Git never tracks them. With `projectPath`, the project folder can sit below the repository root, such as `project`.
- Saves to the same folder are serialized per folder with `navigator.locks`. WebKit does not refuse a second `createWritable({mode: 'exclusive'})`, so the lock is what keeps tabs apart. A save updates the folder's time in the list.
- `openBrowserProjects(window)` lists, creates and deletes the folders and reports the storage. `chooseBrowserProject` shows the dialog, and `exportBrowserProject` and `zipDirectory` write the ZIP, for hosts that use them directly. The ZIP is stored without compression and names entries in UTF-8.

The browser may delete these folders when site data is cleared or the site is not used for a while (seven days in Safari). Creating the first folder asks for `navigator.storage.persist()`, which is not a guarantee. The dialog tells the user to export a ZIP or push to GitHub with Git to keep a copy.

## Block palette settings

TurboWarp Plus Editor now saves block palette settings in its screen state (`.tw-plus/workspace.json`). Reading and writing format 2, described here, stays for project folders made before that.

A source format 2 folder keeps per-sprite and stage block palette settings in `block-palette.json` (see [sb3-toolchain source format v2](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/source-format-v2.md)). Opening the folder turns each `block-palette:block-palette.json` comment reference in `project.source.json` back into the palette comment text an SB3 has, and the VM loads that.

Saving moves the VM's palette comments into `block-palette.json` and puts the references back in `project.source.json`. A renamed sprite keeps its settings under the new name. A change to palette settings alone writes only `block-palette.json`. A project with settings is saved as format 2, and one without as format 1: moving to format 2 writes `block-palette.json` first, and moving back deletes it after `sb3-source.json` and the project file are written. The conversion uses sb3-toolchain's browser functions, so the files match what the toolchain's `build` and `import` produce, byte for byte.

A change to `block-palette.json` outside the Editor is a structural change that waits for **Reload Whole Project**. Folders of other format versions, or whose `sb3-source.json`, `block-palette.json` and references disagree, are not opened.

## Folder explorer

The `./explorer` entry (`@kubohiroya/turbowarp-plus-editor-project-folder/explorer`) is a tree of a folder for the Editor's side panel, built on [Headless Tree](https://headless-tree.lukasbach.com/), which is bundled. It renders with the host's React 16.14–18 (an optional peer dependency); the main entry does not use React.

- `ProjectFolderExplorer` shows `directory` (a project folder or a repository root). Folders load when expanded and sort before files, and `.git` and `.tw-plus` are hidden. The expanded folders and the selected entry of each folder are kept for the page, so the tree comes back as it was when the side panel shows it again. Arrow keys, Home and End move and expand; Enter, Space or a click on a file calls `onOpen({path, name, kind})`. Props: `directory`, `locale` (`ja…` for Japanese, otherwise English), `descriptions` and `marks` (Git status: `added`, `modified`, `deleted` or `untracked`), both keyed by the path relative to `directory`, `onOpen` and `label` (the tree's accessible name). A folder that cannot be read shows a message in the tree.
- `renderProjectFolderExplorer(createElement, {vm, locale, marks})` renders that explorer on the project folder open for `vm`, for the Editor's side panel, with descriptions from the folder's `project.source.json` and `sb3-source.json` (read again after each save). `marks(directory, update)` follows marks for the directory and returns the function that stops it, such as the Git package's `followChangeMarks`. With no folder open it offers **Open Folder…**; it renders nothing while no project folder is mounted for `vm`. `followProjectFolder(vm, listener)` calls `listener(folder, directory, root)` with the mounted folder, its open directory and the folder the user chose for it (`root`, as above) as they change; `directory` and `root` are `null` while no folder is open.
- Each row has an icon drawn in the text color: an open or closed folder, project data (`project.source.json`, `sb3-source.json`), JSON, image, sound, code (`.js`, `.mjs`, `.ts`), text (`.md`, `.txt`) or another file. Images (`.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.webp`) show a thumbnail once their row is on screen; files over 2 MiB, and images that cannot be read, keep the icon. Thumbnails are decorative `<img>` elements from object URLs, which are revoked when the row goes away.
- `describeProjectFolder(project, locale, {manifest, folder})` builds `descriptions`: what `project.source.json`, `sb3-source.json` and `embedded-extensions.json` (and `block-palette.json` in format 2) are, and which costumes, backdrops and sounds use each asset file. `manifest` supplies `assetsDirectory`; `folder` is the project folder's path under the tree's root.

The explorer only reads. It does not create, delete or rename files, and has no type-ahead search.

## External changes

When the host passes `host.blockReload`, the package checks the open folder every two seconds while the page is visible, when the window regains focus, and on `FileSystemObserver` notifications where the browser supports them. A notice appears when the folder changed outside the Editor.

| Editor state | Behavior |
| --- | --- |
| No unsaved edits, project stopped | Once the file has stayed the same across two checks, changes to the scripts of existing sprites and the stage are applied in place. Value and position changes keep every block. Added, removed or reconnected blocks replace only the scripts they belong to, when the host passes `blockReload.deserializeBlocks`. |
| Project running | The change is held. Value and position changes apply when the project stops. |
| Unsaved edits | The edits are kept. When the host passes `blockReload.compareChanges`, **Compare and Choose…** shows your unsaved edits next to the folder's changes, and the edits are replaced only if you choose **Discard Edits and Load from Folder**. Without it, **Discard Edits and Reload…** asks before replacing them. |
| Other changes: targets, variables, comments, blocks that need a variable or an extension the project lacks, assets, the manifest or extensions | **Reload Whole Project** reads the folder again with the same checks as opening it. This is never automatic. |
| Incomplete write, such as truncated JSON | The notice waits and the folder is checked again shortly. |

Script replacements are checked against the VM before any change, and every target is restored if the VM fails part way; the change then waits for **Reload Whole Project**. Pass `autoReload: false` to `mountProjectFolder` to keep every reload behind the button. Checks compare file size and modification time before reading contents, so an overwrite that keeps both unchanged is not detected. Saving still compares the bytes on disk and refuses to overwrite a folder that changed.

## Development

Use Node.js 26, then run `npm ci` and `npm test`. Vite builds the JavaScript library, and TypeScript emits the declarations. `npm pack` creates a tarball for host integration checks. `npm run test:browser` runs the folder's external changes against a real VM and workspace in Chromium on the minimal editor runtime (`@kubohiroya/turbowarp-plus-editor-test-runtime`), with the Editor's pinned VM and Scratch Blocks and without building the Editor. It also renders the explorer with React 16.14 over a real temporary folder; set `TWPF_EXPLORER_SCREENSHOT` to a file path to save a screenshot of it. Project folders in the browser are created, saved, reopened, exported as a ZIP and deleted in Chromium with the folder picker removed and in WebKit; install WebKit with `npx playwright install webkit`. The ZIP unit test and the export check read the archive with Python's `zipfile` (`python3`).

The Editor's headless integration test uses an actual disk directory and substitutes the picker interaction. To verify the native picker separately, open a disposable sb3-toolchain v1 project with **File → Open Folder…**, accept read/write access, edit a standard block, and select **File → Save to Project Folder**. Check that `project.source.json` changed in the chosen directory and reopen the same folder to confirm the edit.

The initial source was extracted from [TurboWarp Plus Editor at d14d065](https://github.com/kubohiroya/turbowarp-plus-editor/tree/d14d0659f77f37328c855ecfeeae0927d81ae81a/packages/editor-project-folder) under MPL-2.0.

## Release

`.github/workflows/release.yml` publishes to npm. Push a `v<version>` tag that names the
`package.json` version on a `main` commit: the workflow runs the tests, packs the archive, attaches it
to the GitHub Release, publishes it to npm and points `latest` and `next` at it. It authenticates with
npm Trusted Publishing (OIDC), not a token, and publishes with provenance. The npm settings name this
workflow file, so rename both together.
