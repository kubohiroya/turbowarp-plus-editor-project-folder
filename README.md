# TurboWarp Plus Editor Project Folder

[日本語](README.ja.md)

This package opens and saves existing sb3-toolchain v1 project folders in TurboWarp Plus Editor. It loads the project JSON and local image and audio assets directly from a directory handle. Saving updates `project.source.json` in the selected folder and checks the source for external changes before writing.

## Integration

- `mountProjectFolder({vm, document, host})` attaches the folder session to a workspace. Call `dispose()` when the workspace is replaced.
- `renderProjectFolderMenu(createElement, props)` supplies the existing open and save commands to the host's file menu.
- The mounted session's `openDirectory(handle, confirmReplace)` accepts a directory handle already selected by the host. It uses the same project validation and unsaved-edit confirmation as the file menu. Save still targets the opened folder.

The host supplies the VM, menu components, and project state callbacks. The browser must support the File System Access picker for the built-in open command. Save writes block, variable, list, sprite property, monitor and built-in extension edits to the project file, including state that changes while the project runs. Sprites can be added, removed and renamed, and costumes and sounds added or removed: new asset files are written first, then `sb3-source.json` and the project file, and asset files nothing refers to are deleted last. Projects with custom extensions, embedded extensions or fonts cannot be opened. See [Editor issue #305](https://github.com/kubohiroya/turbowarp-plus-editor/issues/305) and [issue #308](https://github.com/kubohiroya/turbowarp-plus-editor/issues/308).

## Folder explorer

The `./explorer` entry (`@kubohiroya/turbowarp-plus-editor-project-folder/explorer`) is a tree of a folder for the Editor's side panel, built on [Headless Tree](https://headless-tree.lukasbach.com/), which is bundled. It renders with the host's React 16.14–18 (an optional peer dependency); the main entry does not use React.

- `ProjectFolderExplorer` shows `directory` (a project folder or a repository root). Folders load when expanded and sort before files, and `.git` is hidden. Arrow keys, Home and End move and expand; Enter, Space or a click on a file calls `onOpen({path, name, kind})`. Props: `directory`, `locale` (`ja…` for Japanese, otherwise English), `descriptions` and `marks` (Git status: `added`, `modified`, `deleted` or `untracked`), both keyed by the path relative to `directory`, `onOpen` and `label` (the tree's accessible name). A folder that cannot be read shows a message in the tree.
- Each row has an icon drawn in the text color: an open or closed folder, project data (`project.source.json`, `sb3-source.json`), JSON, image, sound, code (`.js`, `.mjs`, `.ts`), text (`.md`, `.txt`) or another file. Images (`.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.webp`) show a thumbnail once their row is on screen; files over 2 MiB, and images that cannot be read, keep the icon. Thumbnails are decorative `<img>` elements from object URLs, which are revoked when the row goes away.
- `describeProjectFolder(project, locale, {manifest, folder})` builds `descriptions`: what `project.source.json`, `sb3-source.json` and `embedded-extensions.json` are, and which costumes, backdrops and sounds use each asset file. `manifest` supplies `assetsDirectory`; `folder` is the project folder's path under the tree's root.

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

Use Node.js 26, then run `npm ci` and `npm test`. Vite builds the JavaScript library, and TypeScript emits the declarations. `npm pack` creates a tarball for host integration checks. `npm run test:browser` runs the folder's external changes against a real VM and workspace in Chromium on the minimal editor runtime (`@kubohiroya/turbowarp-plus-editor-test-runtime`), with the Editor's pinned VM and Scratch Blocks and without building the Editor. It also renders the explorer with React 16.14 over a real temporary folder; set `TWPF_EXPLORER_SCREENSHOT` to a file path to save a screenshot of it.

The Editor's headless integration test uses an actual disk directory and substitutes the picker interaction. To verify the native picker separately, open a disposable sb3-toolchain v1 project with **File → Open Project Folder…**, accept read/write access, edit a standard block, and select **File → Save to Project Folder**. Check that `project.source.json` changed in the chosen directory and reopen the same folder to confirm the edit.

The initial source was extracted from [TurboWarp Plus Editor at d14d065](https://github.com/kubohiroya/turbowarp-plus-editor/tree/d14d0659f77f37328c855ecfeeae0927d81ae81a/packages/editor-project-folder) under MPL-2.0.

## Release

`.github/workflows/release.yml` publishes to npm. Push a `v<version>` tag that names the
`package.json` version on a `main` commit: the workflow runs the tests, packs the archive, attaches it
to the GitHub Release, publishes it to npm and points `latest` and `next` at it. It authenticates with
npm Trusted Publishing (OIDC), not a token, and publishes with provenance. The npm settings name this
workflow file, so rename both together.
