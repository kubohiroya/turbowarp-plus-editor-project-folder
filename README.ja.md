# TurboWarp Plus Editor Project Folder

[English](README.md)

TurboWarp Plus Editor で sb3-toolchain の作品フォルダ（展開ソース形式 1 と 2）を開き、保存するパッケージです。ディレクトリハンドルから作品 JSON とローカルの画像・音声を読み込みます。保存時は外部変更を確認してから、選んだフォルダの `project.source.json` を更新します。

## 接続

- `mountProjectFolder({vm, document, host})` でワークスペースに接続します。ワークスペースの切り替え時には `dispose()` を呼びます。
- `renderProjectFolderMenu(createElement, props)` は既存の開く・保存コマンドをホストのファイルメニューに渡します。
- 一つのフォルダには一つの作品を、フォルダのルートに置きます。ルートに `project.source.json`・`sb3-source.json`・`embedded-extensions.json` があるフォルダがプロジェクトフォルダです。ユーザーが開こうとしたフォルダ（**フォルダを開く…**、**ブラウザーに保存したフォルダを開く…**、ホストの `openDirectory`）がプロジェクトフォルダでないときは、エラーのダイアログに「このフォルダはプロジェクトフォルダではありません。」（英語では “This folder is not a project folder.”）と、その操作の言語で出し、何も開きません。開いている作品はそのまま残り、未保存の編集の確認も出さず、`followProjectFolder` の listener も呼びません。ダイアログはモーダルの `<dialog>`（`role="alertdialog"`、`data-project-folder-error="not-project"`）で、タイトルと **OK** ボタンがあり、OK で閉じるとフォーカスを元の場所に戻します。ファイルが壊れている、または対応していない形式のプロジェクトフォルダは、これまでどおり状態表示にエラーを出します。`createFromSnapshot` で新しいプロジェクトフォルダに保存する操作は変わりません。
- 接続後の `openDirectory(handle, confirmReplace, root?, options?)` には、ホストが選択済みのディレクトリハンドルを渡せます。ファイルメニューと同じ作品検証・未保存編集の確認を経て開き、`'opened'`・`'cancelled'`・`'not-project'`（`OpenResult`）のどれかで終わります。`'not-project'` のときは何も変わっていません。エラーのダイアログを出しますが、ホストが自分の方法で知らせるときは `options.notProjectDialog` に `false` を渡すと出しません。`options.locale` はダイアログの言語で、省略すると `mountProjectFolder` の `locale` です。保存先にはその作品フォルダを使います。`root` には、ホストが作品を見つけたフォルダとして、ユーザーが選んだフォルダを渡します。省略すると `handle` です（`options` だけを渡すときは `undefined` を渡します）。ダイアログを出さなかったホスト向けに、ダイアログを出す `showNotProjectFolderDialog({document, locale})` と、その文言を返す `notProjectFolderMessage(locale)` もあります。
- 接続後の `directory` は、読み込んだ作品のフォルダーのハンドルです。別の作品を読み込むか、フォルダーとの接続を外すと `null` になります。ホストは作品を見分けるのに使えます。
- 接続後の `root` は、その作品のためにユーザーが選んだフォルダーです。ホストが `openDirectory` に別のフォルダを渡したとき以外は `directory` そのものです。`directory` が `null` のときは `null` です。ブラウザーではフォルダーの親を読めないので、ホストは Git のリポジトリを `root` に結び付けます。
- `host.screenState` を渡すと、Editor の画面状態をフォルダーに保存します。渡すものは workbench の `installProjectScreenState` が返すものです。作品フォルダーは SB3 ではないので、状態は `.tw-plus/workspace.json` に入れます。フォルダーを開くと、作品を読み込む前にこれを読み、`prepareLoad(text)` で渡します。保存時は、作品が変わっていなくても `serialize()` の結果を書きます。保存時刻だけが違うときは書きません。読み書きに失敗しても、開く操作と保存は失敗にしません。セッションは `projectFolder` スライス（ツリーで開いたフォルダーと選択中の項目）も登録します。SB3 から作品フォルダを作るとき、sb3-toolchain（0.26.0 以降）が展開したスナップショットに `.tw-plus/workspace.json` があれば、そのままフォルダーに書くので、作ったフォルダーは同じ画面で開きます。スナップショットにないときは、上書きするフォルダーの古い `workspace.json` を消します。`.tw-plus` のほかのファイルは残します。

ホストは VM、メニューコンポーネント、作品状態を扱うコールバックを渡します。メニューからフォルダを開くには、ブラウザーが File System Access のフォルダ選択に対応しているか、[ブラウザー内の作品フォルダ](#ブラウザー内の作品フォルダ)を使える必要があります。ブロック、変数・リスト、スプライトの位置や大きさなどの項目、モニター、組み込みの拡張機能の編集を作品データ（`project.source.json`）に保存し、作品の実行で変わった状態も含みます。スプライトの追加・削除・名前の変更と、コスチューム・音の追加・削除も保存します。新しいアセットのファイルを先に書き、`sb3-source.json` と作品データを書いてから、参照されなくなったアセットのファイルを消します。 [Editor #305](https://github.com/kubohiroya/turbowarp-plus-editor/issues/305) · [Editor #308](https://github.com/kubohiroya/turbowarp-plus-editor/issues/308)

システムフォントと Web フォントの参照は作品データに保持し、埋め込みフォントは `assets/` に保存します。 [Editor #495](https://github.com/kubohiroya/turbowarp-plus-editor/issues/495)

## ブラウザー内の作品フォルダ

Safari と Firefox にはフォルダ選択（`showDirectoryPicker`）がありません。これらのブラウザーでは、作品フォルダをブラウザーの中の保存領域（OPFS、Origin Private File System）に置きます。読み書きの処理はデバイス上のフォルダと同じです。 [Editor #660](https://github.com/kubohiroya/turbowarp-plus-editor/issues/660)

- `mountProjectFolder` の `browserStorage` で使い方を選びます。
  - `fallback`（既定）：フォルダ選択がないブラウザー（Safari、Firefox）でだけ使います。ファイルメニューでは **フォルダを開く…** を、このブラウザーでは端末のフォルダを開けない旨を添えて無効にし、ブラウザー内の作品フォルダの一覧を開く **ブラウザーに保存したフォルダを開く…** を出します。`projectFolderActions(vm)` は `deviceFolders: false` を返すので、ホストのメニューでも同じように無効にできます。ホストが `open` を呼んだときは、これまでどおりブラウザー内のフォルダを開きます。`createFromSnapshot` は新しい作品フォルダの名前を尋ねます（`title` で名前の初期値を渡せます）。
  - `always`：フォルダ選択があるブラウザーでも使います。ファイルメニューの **フォルダを開く…** の隣に **ブラウザーに保存したフォルダを開く…** を足し、`projectFolderActions(vm).openBrowser` でも開けます。
  - `off`：使いません。
- 作品フォルダをまだ開いていないパネルには、利用できる保存方式の説明と作成ボタンを出します。`always` でフォルダ選択と OPFS の両方が使える場合は2方式、Safari・Firefox ではブラウザー内保存の説明を出します。説明には、ボタンを押した後の操作、外部アプリからの見え方、ブラウザー内の作品を残すための書き出し方法を含めます。
- `renderProjectFolderExplorer` の `createFolder(location)` には、選んだ保存先（`device` または `browser`）が渡ります。ホストはこれを `createFromSnapshot({location, ...})` に渡します。`location` を省略した場合は従来どおりフォルダ選択を優先し、利用できない保存先を明示した場合は別の保存先に切り替えずエラーにします。
- 一覧のダイアログでは、作品フォルダを開く、ZIP で書き出す、削除することができます。保存領域の使用量と、ブラウザーが消さずに残すか（`persisted`）も表示します。閉じるボタンは X のアイコンで、名前は表示の言語に合わせます。
- 作品フォルダは `turbowarp-plus/projects/<id>/` に置き、表示名と時刻は `turbowarp-plus/project-info/<id>.json` に置きます。作品フォルダの外に置くので、Git の管理対象には入りません。フォルダを開くときは、保存したフォルダのルートの作品を読みます。`create(title, {projectPath})` と `directory(id)` は互換のために `projectPath` を受け付けて解決しますが、Editor はその下のフォルダを開きません。
- 同じ作品フォルダへの保存は、`navigator.locks` で作品ごとに排他します。WebKit は `createWritable({mode: 'exclusive'})` を重ねても拒否しないので、タブ間の排他はロックで行います。保存すると一覧の更新時刻が変わります。
- `openBrowserProjects(window)` は一覧・作成・削除・保存領域の状態を扱う口です。`chooseBrowserProject` は一覧のダイアログを、`exportBrowserProject` と `zipDirectory` は ZIP の書き出しを、ホストが直接使うためのものです。ZIP は圧縮せず、名前を UTF-8 で書きます。

ブラウザーの中の作品フォルダは、サイトのデータを消したときや、しばらくサイトを使わなかったときに、ブラウザーが消すことがあります（Safari では 7 日間）。最初の作品フォルダを作るときに `navigator.storage.persist()` を求めますが、保証にはなりません。ZIP で書き出すか、Git で GitHub に送って残すようにダイアログで案内します。

保存先選択の導入は、このパッケージを先に公開し、Editor の依存をその版へ固定してからホストの結線を反映します。切り戻すときは Editor の結線と依存の固定を一緒に戻します。OPFS に作成済みの作品は削除せず、ブラウザー内の一覧から開く・ZIP で書き出す経路を維持します。

## フォルダの作成・写し・改名

新しい作品を作る、写しを保存する、作品名を変えるホストは、自前の補助関数の代わりに、マウントしたセッションの次のメンバーを使います。[Editor の issue #679](https://github.com/kubohiroya/turbowarp-plus-editor/issues/679) を参照してください。

```ts
type ProjectFolderDestination = 'browser' | FileSystemDirectoryHandle;
createFromSnapshot({prepareFiles, collectEdits?, current?, title?, destination?, directory?, location?}): Promise<OpenResult>;
copyToFolder({destination, prepareFiles, collectEdits?, current?, title?}): Promise<FileSystemDirectoryHandle | null>;
pickEmptyFolder({locale?, id?}?): Promise<FileSystemDirectoryHandle | null>;
renameCurrentBrowserFolder(title: string): Promise<boolean>;
readonly location: 'browser' | 'device' | null;
readonly locations: readonly ('device' | 'browser')[];
```

- `createFromSnapshot({destination})` は、新しいプロジェクトフォルダを作成先に書き、`destination` がないときと同じく開きます。`'browser'` はブラウザーの保存領域に `browserProjects.create(title, {projectPath: ''})` で新しいフォルダを作り（`title` の既定は `Project`）、そこから作品が開かなかったとき、つまりユーザーが断ったとき、`current()` が偽になったとき、準備や書き込みに失敗したときには、そのフォルダを消します。ディレクトリのハンドルは、ホストが端末で選んだフォルダです。フォルダ選択は開きません。空でないフォルダは、これまでどおりユーザーが確かめたときだけ上書きします。ブラウザー内のフォルダが使えないときの `'browser'` は、`prepareFiles` を呼ぶ前に `unsupported` で失敗します。`destination` がなければ、`directory` と `location` はこれまでどおりです。
- `copyToFolder({destination, title, prepareFiles})` は、プロジェクトフォルダを書くだけで開きません（プロジェクトのコピーを保存）。開いている作品、`directory`・`root`・`location` は変わらず、`followProjectFolder` の listener も呼びません。`collectEdits`、`prepareFiles` の順に呼び、`createProjectFolder` で書いて、書いたフォルダを返します。`'browser'` は `title` という名前の新しいフォルダを作り、何も書かなかったときは消します。端末の空でないフォルダは、ユーザーが確かめたときだけ上書きします。ユーザーが断ったときや `current()` が偽になったときは、何も書かずに `null` を返します。開いているプロジェクトフォルダそのものとその `root`（`isSameEntry` で比べます）は、何も尋ねず何も書かずに `conflict` で断ります。そこへ書くのは保存です。
- `pickEmptyFolder({locale, id})` は端末のフォルダ選択（`showDirectoryPicker({id, mode: 'readwrite'})`、`id` の既定は `turbowarp-plus-project-folder`）を開き、空のフォルダならそれを返します。ユーザーが取り消したときと、空でないフォルダを選んだときは `null` を返し、後者ではモーダルのダイアログに「このフォルダは使えません」「空のフォルダを選んでください。」（英語では “Cannot Use This Folder”、“Choose an empty folder.”）を `locale` の言語で出します。ダイアログはプロジェクトフォルダでないときと同じ `<dialog>` で、`data-project-folder-error="not-empty"` を持ち、閉じてから `null` を返します。ブラウザーはクリックの処理中にしかフォルダ選択を開かないので、クリックを処理している間に呼びます。端末のフォルダを選べないブラウザーでは `unsupported` で失敗します。
- `renameCurrentBrowserFolder(title)` は、開いているフォルダの、このブラウザーのフォルダ一覧での名前を `title` にし（`browserProjects.find` と `rename`）、`true` を返します。フォルダが開いていないときや、開いているのが端末のフォルダのとき（ブラウザーからは名前を変えられません）は、何も変えずに `false` を返します。
- `location` は開いているフォルダの場所です。このブラウザー内なら `browser`、それ以外は `device`、開いていなければ `null` です。`locations` は新しいフォルダを作れる場所の一覧で、`followProjectFolder` が伝えるものと同じです。

自前の補助関数を持つホストは、次のように置き換えます。

| ホストの補助関数 | 置き換え先 |
| --- | --- |
| ホストが新しいブラウザー内のフォルダを作って消す `createFolder(…, destination)` | `createFromSnapshot({destination, title, prepareFiles, collectEdits, current})` |
| 選んだフォルダや新しいブラウザー内のフォルダに `createProjectFolder` で書くコピーの保存 | `copyToFolder({destination, title, prepareFiles, collectEdits, current})` |
| 空でないフォルダを断るフォルダ選択 | `pickEmptyFolder({locale})` |
| ホストが自分で調べた `{browser, device}` | `locations.includes('browser')`、`locations.includes('device')` |
| 作品名の変更後の `browserProjects.find(root)` と `rename` | `renameCurrentBrowserFolder(title)`。`false` ならフォルダ名は変わりません |

## 0.17.0 の後の互換性のない変更: 作品はフォルダのルートに置く

0.16.0 では、選んだフォルダの直下に作品がないとき、その中の `project` フォルダの作品を開きました（Project Starter が作るリポジトリの形）。この切り替えはなくしました。一つの Git リポジトリには一つの作品を、そのルートに置きます。

- 作品を `project/` に置いたリポジトリは、プロジェクトフォルダではなくなります。開くとエラーのダイアログを出します。作品のファイルをリポジトリのルートに移すか、`project` フォルダそのものを開いてください。
- 古い形でブラウザーに保存したフォルダ（`projectPath: 'project'` の項目）も、ほかと同じく保存したフォルダのルートを開くので、エラーのダイアログを出します。このパッケージは移し替えをしません。ZIP で書き出して残し、その `project` フォルダを端末のフォルダとして開くか、sb3-toolchain で SB3 にしてから、ブラウザーの新しいフォルダに保存し直してください。
- `root` は、ホストが `openDirectory` に `root` を渡したとき以外は、作品フォルダそのものです。
- `OpenResult` に `'not-project'` が加わりました。結果を `'opened'` と `'cancelled'` だけで見分けていたホストは、これも扱ってください。

## ブロックパレットの設定

TurboWarp Plus Editor は、ブロックパレットの設定を画面状態（`.tw-plus/workspace.json`）に保存するようになりました。この節の形式 2 の読み書きは、それ以前に作られた作品フォルダのために残しています。

展開ソース形式 2 の作品フォルダは、スプライト・背景ごとのブロックパレットの設定を `block-palette.json` に持ちます（[sb3-toolchain の形式 v2](https://github.com/kubohiroya/sb3-toolchain/blob/main/docs/ja/source-format-v2.md)）。開くときは、`project.source.json` のコメントにある参照 `block-palette:block-palette.json` を、SB3 と同じパレット設定のコメントの本文に戻して VM に読み込みます。

保存時は、VM にあるパレット設定のコメントを `block-palette.json` に移し、`project.source.json` のコメントを参照に戻します。スプライトの名前を変えると、設定のキーも新しい名前になります。パレットの設定だけを変えたときは、`block-palette.json` だけを書きます。設定のある作品は形式 2、ない作品は形式 1 で保存します。形式 1 から 2 に移るときは `block-palette.json` を先に書き、2 から 1 に戻るときは `sb3-source.json` と作品データを書いてから `block-palette.json` を消します。変換には sb3-toolchain のブラウザー向けの関数を使い、toolchain の `build` と `import` が作る内容とバイト単位で同じにします。

フォルダの外で `block-palette.json` が変わったときは、構造の変更として **作品全体を再読み込み** を待ちます。形式 1・2 以外の版や、`sb3-source.json` と `block-palette.json` と参照が食い違う作品フォルダは開きません。

## 拡張機能

埋め込み拡張の参照は、フォルダを開く際に `extensions/<id>.js` の内容とマニフェストから data URL に復元します。URL で指定されたカスタム拡張も、Editor の既存の許可画面を経て読み込みます。 `turboWarpPlus` のマニフェストとカスタムフォントを含む作品フォルダは対象外です。 [Editor #496](https://github.com/kubohiroya/turbowarp-plus-editor/issues/496)

保存時は変更のあったスクリプト、拡張のマニフェスト、作品データの順に書き、参照がなくなったファイルを最後に削除します。変更のないスクリプトと拡張のマニフェストはバイト列を保ちます。差し替えで `source` と対応する API マニフェストを外した場合は、保存時に該当する ID を通知します。2 件未満になったバンドル設定は削除します。module バンドルは管理対象の npm モジュールを必要とするため、差し替えで `source` を失った拡張も設定から外れます。

切り戻す場合は、Editor の依存を project-folder 0.6.0 と security-dialog 0.8.8 に戻して再ビルドします。保存済みのフォルダは `sb3-toolchain build` で SB3 にできます。

## フォルダの一覧

`./explorer`（`@kubohiroya/turbowarp-plus-editor-project-folder/explorer`）は、エディターのサイドパネルに置くフォルダのツリーです。[Headless Tree](https://headless-tree.lukasbach.com/) を同梱しています。描画にはホストの React 16.14〜18 を使います（省略可能な peer dependency）。メインの入口は React を使いません。

- `ProjectFolderExplorer` は `directory`（作品フォルダまたはリポジトリのルート）を表示します。フォルダは開いたときに読み込み、ファイルより先に並べます。`.git` と `.tw-plus` は表示しません。フォルダーごとの開いたフォルダーと選択中の項目はページの中で保持するので、横のパネルを開き直すと、前と同じツリーに戻ります。矢印キー・Home・End で移動と開閉をします。ファイルで Enter・Space を押すかクリックすると `onOpen({path, name, kind})` を呼びます。props は `directory`、`locale`（`ja…` で日本語、それ以外は英語）、`descriptions` と `marks`（Git の状態: `added`・`modified`・`deleted`・`untracked`、どちらも `directory` からの相対パスがキー）、`onOpen`、`label`（ツリーのアクセシブルな名前）です。読み込めないフォルダは、ツリーの中にメッセージを表示します。
- `renderProjectFolderExplorer(createElement, {vm, locale, marks})` は、`vm` で開いているプロジェクトフォルダのツリーを Editor の横のパネル向けに描きます。説明はフォルダの `project.source.json` と `sb3-source.json` から作り、保存のたびに読み直します。`marks(directory, update)` はそのフォルダの印を追い、止める関数を返します（Git パッケージの `followChangeMarks` など）。フォルダを開いていないときは **フォルダを開く…** を出し、`vm` にプロジェクトフォルダを組み込んでいないときは何も描きません。`followProjectFolder(vm, listener)` は、組み込んだフォルダ・開いているディレクトリ・ユーザーが選んだフォルダ（上の `root`）が変わるたびに `listener(folder, directory, root)` を呼びます。フォルダを開いていないときの `directory` と `root` は `null` です。
- 各行には文字色で描いたアイコンが付きます。開いた・閉じたフォルダ、作品データ（`project.source.json`・`sb3-source.json`）、JSON、画像、音、コード（`.js`・`.mjs`・`.ts`）、テキスト（`.md`・`.txt`）、その他のファイルです。画像（`.svg`・`.png`・`.jpg`・`.jpeg`・`.gif`・`.bmp`・`.webp`）は、行が画面に入るとサムネイルを表示します。2 MiB を超えるファイルと読み込めない画像はアイコンのままです。サムネイルは装飾用の `<img>` で、オブジェクト URL は行がなくなると解放します。
- `describeProjectFolder(project, locale, {manifest, folder})` は `descriptions` を作ります。`project.source.json`・`sb3-source.json`・`embedded-extensions.json`（形式 2 では `block-palette.json` も）の説明と、各アセットのファイルを使うコスチューム・背景・音を返します。`manifest` から `assetsDirectory` を読みます。`folder` はツリーのルートから見た作品フォルダのパスです。

読み取り専用です。ファイルの作成・削除・名前の変更はできません。文字入力による検索もありません。

## ファイルの編集

作品フォルダのテキストファイルは既存の作業タブで開き、その場で直接編集できます（[Editor #532](https://github.com/kubohiroya/turbowarp-plus-editor/issues/532)、[表示と外部編集の改善 #673](https://github.com/kubohiroya/turbowarp-plus-editor/issues/673)）。ファイル名はタブに表示し、本文上の重複するファイル名の行は表示しません。「通常表示／差分表示」は、選択中の状態が分かるカプセル型の切り替えです。矢印キーでも切り替えられます。「ファイルを保存」「VSCodeで編集」にはアイコンを付け、切り替えとともに右上に重ねて表示します。保存は、このタブのファイルに未保存の変更がある場合だけ有効です。未保存の通知・エラーは左下に表示し、編集領域の高さを減らしません。保存が成功すると「保存しました」のスナックバーを4秒間表示します。

ローカル連携から Editor を開くと、既存の文書エディターの補助プロセスを利用して「VSCodeで編集」を使えます。編集中の内容を作業コピーとして渡すため、実フォルダと OPFS のどちらでも同じ操作になります。外部編集中はこのタブの通常表示・差分表示・ミニマップ・すべての操作ボタンを無効にします。VSCode で保存した後、覆い表示の「終了して取り込む」で編集結果をタブに取り込み、「ファイルを保存」で元の保存先へ書き込みます。「取り込まずに終了」では外部編集の開始前のタブの内容を保持します。作業コピーは補助プロセスに保持されます。ローカル連携がない環境では外部編集ボタンは無効です。JSON・YAML は既存の補助プロセスで利用でき、それ以外のテキストには `config.formats` に `text` を返す版が必要です。

この OPFS 対応は、ローカル連携の URL から開いた Editor の保存領域が対象です。通常の配信サイトとローカル連携では OPFS の保存領域が異なるため、配信サイトで既に作業している OPFS を直接共有しません。通常の配信サイトを開いたまま外部編集するための別オリジン接続は、この実装には含みません。

編集画面の右下には、ファイル全体と現在の表示範囲を示すミニマップを表示します。クリック・ドラッグで移動でき、ミニマップにフォーカスすると矢印・Page Up／Page Down・Home／End キーでもスクロールできます。編集、スクロール、パネルのサイズ変更、タブの再表示に追従します。差分表示では編集用のミニマップを隠します。

切り戻す場合はこの UI 変更を revert し、パッケージと Editor を再ビルドします。ファイル形式の変更やデータ移行はありません。対象のヘッドレス検証は `node --test test/text-file.browser.js` で実行します。

実際の補助プロセスと OPFS を使う結合検証は、`TWPF_COMPANION_HOST` に文書エディターの `node/host.ts` の絶対パスを指定して同じコマンドを実行します。VSCode の起動はテスト用の関数に差し替え、OS の画面を表示せず、JSON と Markdown の作業コピーの読み書き・タブの無効化・取り込み・OPFS への保存を確認します。

## 外部変更

ホストが `host.blockReload` を渡すと、表示中は 2 秒ごと、ウィンドウにフォーカスが戻ったとき、ブラウザーが対応していれば `FileSystemObserver` の通知で、開いているフォルダを確認します。Editor の外でフォルダが変わると通知を表示します。

| Editor の状態 | 動作 |
| --- | --- |
| 未保存編集なし・実行停止中 | 2 回の確認でファイルが変わらなければ、既存のスプライトとステージのスクリプトの変更をその場で反映します。値と座標の変更はすべてのブロックを保ちます。ブロックの追加・削除・接続の変更は、ホストが `blockReload.deserializeBlocks` を渡す場合に、該当するスクリプトだけを置き換えます。 |
| 作品の実行中 | 反映を保留します。値と座標の変更は停止後に反映します。 |
| 未保存編集あり | 編集を保持します。ホストが `blockReload.compareChanges` を渡す場合は、**比較して選ぶ…** で未保存の編集とフォルダでの変更を並べて示し、**編集を破棄してフォルダから読み込む** を選んだときだけ置き換えます。渡さない場合は、**編集を破棄して再読み込み…** で確認してから置き換えます。 |
| その他の変更（ターゲット・変数・コメントの変更、作品に無い変数や拡張機能を使うブロック、アセット・マニフェスト・拡張機能の変更） | **作品全体を再読み込み** で、開くときと同じ検証を経てフォルダを読み直します。自動では行いません。 |
| JSON の途中など書き込み途中 | 更新待ちを表示し、間を置かずに再確認します。 |

スクリプトの置き換えは VM を変更する前に検証し、途中で VM が失敗した場合はすべてのターゲットを元に戻して **作品全体を再読み込み** を待ちます。`mountProjectFolder` に `autoReload: false` を渡すと、すべての反映をボタン操作にします。確認はファイルの内容を読む前にサイズと更新時刻を比べるため、両方が変わらない上書きは検出できません。保存時はディスクのバイト列を照合し、変更されたフォルダへの上書きを拒否します。

## 開発

Node.js 26 で `npm ci` と `npm test` を実行します。Vite で JavaScript、TypeScript で型宣言を生成します。ホストとの接続検証には `npm pack` で作る tarball を使います。`npm run test:browser` は、最小 editor runtime（`@kubohiroya/turbowarp-plus-editor-test-runtime`）の上で、フォルダの外部変更と本物の VM・ワークスペースとの結合を Chromium で試します。Editor が固定する VM と Scratch Blocks を使い、Editor のビルドは要りません。フォルダの一覧も、React 16.14 で実際の一時フォルダを表示して試します。`TWPF_EXPLORER_SCREENSHOT` にファイルのパスを入れると、その画面を保存します。ブラウザー内の作品フォルダは、フォルダ選択を外した Chromium と WebKit で、作成・保存・開き直し・ZIP の書き出し・削除を試します。WebKit は `npx playwright install webkit` で入れます。ZIP の単体テストと書き出しの確認には `python3` の `zipfile` を使います。

Editor のヘッドレス統合テストは実ディスク上のフォルダを使い、選択画面の操作を差し替えます。OS のフォルダ選択画面を確認するときは、使い捨ての sb3-toolchain v1 作品を **ファイル → フォルダを開く…** から選び、読み書きを許可します。標準ブロックを変更し、**ファイル → プロジェクトフォルダに保存** を選びます。選んだフォルダの `project.source.json` が更新されたことを確かめ、同じフォルダを開き直して編集が反映されることを確認します。

初期実装は MPL-2.0 の [TurboWarp Plus Editor d14d065](https://github.com/kubohiroya/turbowarp-plus-editor/tree/d14d0659f77f37328c855ecfeeae0927d81ae81a/packages/editor-project-folder) から分離しました。

## 公開

npm への公開は `.github/workflows/release.yml` が行う。`package.json` の版と同じ `v<版>` のタグを
`main` のコミットに push すると、テストを通したうえで npm に入れるアーカイブを作り、GitHub Release に
添付してから npm に公開し、`latest` と `next` をその版に向ける。認証はトークンではなく npm の
Trusted Publisher（OIDC）で、provenance を付けて公開する。npm 側の設定にはこのワークフローの
ファイル名をそのまま登録するため、改名するときは npm の設定も合わせる。
