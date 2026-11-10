# TurboWarp Plus Editor Project Folder

[English](README.md)

TurboWarp Plus Editor で既存の sb3-toolchain v1 の作品フォルダを開き、保存するパッケージです。ディレクトリハンドルから作品 JSON とローカルの画像・音声を読み込みます。保存時は外部変更を確認してから、選んだフォルダの `project.source.json` を更新します。

## 接続

- `mountProjectFolder({vm, document, host})` でワークスペースに接続します。ワークスペースの切り替え時には `dispose()` を呼びます。
- `renderProjectFolderMenu(createElement, props)` は既存の開く・保存コマンドをホストのファイルメニューに渡します。
- 接続後の `openDirectory(handle, confirmReplace)` には、ホストが選択済みのディレクトリハンドルを渡せます。ファイルメニューと同じ作品検証・未保存編集の確認を経て開き、保存先にはその作品フォルダを使います。

ホストは VM、メニューコンポーネント、作品状態を扱うコールバックを渡します。メニューからフォルダを開くには、ブラウザーが File System Access のフォルダ選択に対応している必要があります。ブロック、変数・リスト、スプライトの位置や大きさなどの項目、モニター、組み込みの拡張機能の編集を作品データ（`project.source.json`）に保存し、作品の実行で変わった状態も含みます。スプライトの追加・削除・名前の変更と、コスチューム・音の追加・削除も保存します。新しいアセットのファイルを先に書き、`sb3-source.json` と作品データを書いてから、参照されなくなったアセットのファイルを消します。 [Editor #305](https://github.com/kubohiroya/turbowarp-plus-editor/issues/305) · [Editor #308](https://github.com/kubohiroya/turbowarp-plus-editor/issues/308)

システムフォントと Web フォントの参照は作品データに保持し、埋め込みフォントは `assets/` に保存します。 [Editor #495](https://github.com/kubohiroya/turbowarp-plus-editor/issues/495)

## 拡張機能

埋め込み拡張の参照は、フォルダを開く際に `extensions/<id>.js` の内容とマニフェストから data URL に復元します。URL で指定されたカスタム拡張も、Editor の既存の許可画面を経て読み込みます。 `turboWarpPlus` のマニフェストとカスタムフォントを含む作品フォルダは対象外です。 [Editor #496](https://github.com/kubohiroya/turbowarp-plus-editor/issues/496)

保存時は変更のあったスクリプト、拡張のマニフェスト、作品データの順に書き、参照がなくなったファイルを最後に削除します。変更のないスクリプトと拡張のマニフェストはバイト列を保ちます。差し替えで `source` と対応する API マニフェストを外した場合は、保存時に該当する ID を通知します。2 件未満になったバンドル設定は削除します。module バンドルは管理対象の npm モジュールを必要とするため、差し替えで `source` を失った拡張も設定から外れます。

切り戻す場合は、Editor の依存を project-folder 0.6.0 と security-dialog 0.8.8 に戻して再ビルドします。保存済みのフォルダは `sb3-toolchain build` で SB3 にできます。

## フォルダの一覧

`./explorer`（`@kubohiroya/turbowarp-plus-editor-project-folder/explorer`）は、エディターのサイドパネルに置くフォルダのツリーです。[Headless Tree](https://headless-tree.lukasbach.com/) を同梱しています。描画にはホストの React 16.14〜18 を使います（省略可能な peer dependency）。メインの入口は React を使いません。

- `ProjectFolderExplorer` は `directory`（作品フォルダまたはリポジトリのルート）を表示します。フォルダは開いたときに読み込み、ファイルより先に並べます。`.git` は表示しません。矢印キー・Home・End で移動と開閉をします。ファイルで Enter・Space を押すかクリックすると `onOpen({path, name, kind})` を呼びます。props は `directory`、`locale`（`ja…` で日本語、それ以外は英語）、`descriptions` と `marks`（Git の状態: `added`・`modified`・`deleted`・`untracked`、どちらも `directory` からの相対パスがキー）、`onOpen`、`label`（ツリーのアクセシブルな名前）です。読み込めないフォルダは、ツリーの中にメッセージを表示します。
- `renderProjectFolderExplorer(createElement, {vm, locale, marks})` は、`vm` で開いているプロジェクトフォルダのツリーを Editor の横のパネル向けに描きます。説明はフォルダの `project.source.json` と `sb3-source.json` から作り、保存のたびに読み直します。`marks(directory, update)` はそのフォルダの印を追い、止める関数を返します（Git パッケージの `followChangeMarks` など）。フォルダを開いていないときは **プロジェクトフォルダを開く…** を出し、`vm` にプロジェクトフォルダを組み込んでいないときは何も描きません。`followProjectFolder(vm, listener)` は、組み込んだフォルダと開いているディレクトリの変化を知らせます。
- 各行には文字色で描いたアイコンが付きます。開いた・閉じたフォルダ、作品データ（`project.source.json`・`sb3-source.json`）、JSON、画像、音、コード（`.js`・`.mjs`・`.ts`）、テキスト（`.md`・`.txt`）、その他のファイルです。画像（`.svg`・`.png`・`.jpg`・`.jpeg`・`.gif`・`.bmp`・`.webp`）は、行が画面に入るとサムネイルを表示します。2 MiB を超えるファイルと読み込めない画像はアイコンのままです。サムネイルは装飾用の `<img>` で、オブジェクト URL は行がなくなると解放します。
- `describeProjectFolder(project, locale, {manifest, folder})` は `descriptions` を作ります。`project.source.json`・`sb3-source.json`・`embedded-extensions.json` の説明と、各アセットのファイルを使うコスチューム・背景・音を返します。`manifest` から `assetsDirectory` を読みます。`folder` はツリーのルートから見た作品フォルダのパスです。

読み取り専用です。ファイルの作成・削除・名前の変更はできません。文字入力による検索もありません。

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

Node.js 26 で `npm ci` と `npm test` を実行します。Vite で JavaScript、TypeScript で型宣言を生成します。ホストとの接続検証には `npm pack` で作る tarball を使います。`npm run test:browser` は、最小 editor runtime（`@kubohiroya/turbowarp-plus-editor-test-runtime`）の上で、フォルダの外部変更と本物の VM・ワークスペースとの結合を Chromium で試します。Editor が固定する VM と Scratch Blocks を使い、Editor のビルドは要りません。フォルダの一覧も、React 16.14 で実際の一時フォルダを表示して試します。`TWPF_EXPLORER_SCREENSHOT` にファイルのパスを入れると、その画面を保存します。

Editor のヘッドレス統合テストは実ディスク上のフォルダを使い、選択画面の操作を差し替えます。OS のフォルダ選択画面を確認するときは、使い捨ての sb3-toolchain v1 作品を **ファイル → プロジェクトフォルダを開く…** から選び、読み書きを許可します。標準ブロックを変更し、**ファイル → プロジェクトフォルダに保存** を選びます。選んだフォルダの `project.source.json` が更新されたことを確かめ、同じフォルダを開き直して編集が反映されることを確認します。

初期実装は MPL-2.0 の [TurboWarp Plus Editor d14d065](https://github.com/kubohiroya/turbowarp-plus-editor/tree/d14d0659f77f37328c855ecfeeae0927d81ae81a/packages/editor-project-folder) から分離しました。

## 公開

npm への公開は `.github/workflows/release.yml` が行う。`package.json` の版と同じ `v<版>` のタグを
`main` のコミットに push すると、テストを通したうえで npm に入れるアーカイブを作り、GitHub Release に
添付してから npm に公開し、`latest` と `next` をその版に向ける。認証はトークンではなく npm の
Trusted Publisher（OIDC）で、provenance を付けて公開する。npm 側の設定にはこのワークフローの
ファイル名をそのまま登録するため、改名するときは npm の設定も合わせる。
