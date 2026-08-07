# `calibrationNotes` の全数追跡 ／ 表示判定の切り出し設計 ／ 警告のタップ領域

**使い捨ての報告。確認が済んだら削除してよい。**
①は調査のみ、②は提案のみ（未実装）、③は実装済み。

---

## ① `calibrationNotes()` の呼び出し箇所を全数追跡

`grep -n "calibrationNotes" js/` の結果、**呼び出しは2箇所だけ**（import 行を除く）。

### 呼び出し A — `wireCalibrationPhoto()`（`js/ui.js:1206`）

| 項目 | 内容 |
| --- | --- |
| 契機 | **写真の読み取り時**（`#cal-photo-${i}` の `change` → `readImageBuffer().then()` の中） |
| 引数 | `{ syncSpeed: state.camera.syncSpeed, **inputF: null** }` |
| 戻り値の扱い | `list.map((n) => n.text).join('／')` → `notes.textContent`、`notes.hidden = !text`。**`filter` なし** |
| `warn` は出るか | **出る。** レベルで絞っていないので `alert` も `warn` も同じ1行に連結される |

前段のガードで `!exif || format !== 'jpeg' || !(fNumber > 0) || !(iso > 0)` のときは
`notes.hidden = true` にして **`calibrationNotes` を呼ばずに return** する。

### 呼び出し B — `runCalibration()`（`js/ui.js:1241`）

| 項目 | 内容 |
| --- | --- |
| 契機 | **「この結果で校正する」の実行時** |
| 引数 | `{ syncSpeed: state.camera.syncSpeed, **inputF: fAperture}`（入力欄の実値） |
| 戻り値の扱い | `.filter((n) => n.level === 'alert')` → `blocking`。**`warn` はここで捨てられる** |
| `blocking` の使い方 | `if (blocking.length) throw new Error(blocking[0].text)` → `catch` でトースト |
| 描画先 | **無し。** `notes` 欄を更新しない |

写真を選んでいない（`calPhotoExif.get(i)` が `undefined`）ときは `blocking = []` で素通り。

### 3つの note が画面に出るか — 断定

| note | レベル | A（読み取り時） | B（実行時） | **結論** |
| --- | --- | --- | --- | --- |
| 非発光 | `alert` | **出る**（`notes` 欄） | 出る（トースト＋実行中断） | **出る** |
| 同調速度より速い SS で発光あり | `warn` | **出る**（`notes` 欄） | 出ない（`filter` で脱落） | **出る**（読み取り時に） |
| 手入力の F値 と EXIF の食い違い | `warn` | **判定していない**（`inputF: null`） | 判定するが `filter` で脱落 | **出ない** |

**あなたの見立てのとおりでした。** `filter((n) => n.level === 'alert')` は同調速度の警告も落としますが、
**読み取り時に描画する経路（A）が別にあるので同調速度だけは出ます。**
監査報告 §7.1 は食い違いについては正確でしたが、
「校正の実行時は `warn` が捨てられる」とだけ書いてAの存在に触れなかったのは説明不足でした。

### 食い違いが出ない原因は3つ重なっている

1. **A が `inputF: null` を渡している。** 読み取り直後は入力欄を EXIF で上書きした後なので、
   その瞬間は必ず一致する。だから当時は `null` で正しいと考えた
2. **入力欄を手で変えても再判定しない。** `f` / `iso` の `input` リスナーは
   出所バッジを隠すだけ（`js/ui.js:1178`）。`notes` は更新されない
3. **B が `warn` を捨てている**

**②で表示判定を切り出しても直るのは 3 だけです。** 1 と 2 は配線の問題で、
「いつ・何を渡して呼ぶか」は純粋関数の外にあります。

### 断定できないもの

- `notes` 欄が実機で**見える位置にあるか**（`.calib-form` 内の `<p>`。スクロールが要るかは実機のみ）
- 連結した文言（`／` 区切り）が3件並んだときに読めるか
- iOS のファイル選択から戻ったあとに `change` が発火するか（フェーズ1で通過済みだが校正欄は別要素）

---

## ② 表示判定を純粋関数へ切り出す設計（提案・未実装）

### 提案する関数

**置き場所：`js/lightmeter.js`。** `calibrationNotes` のすぐ下に置く。
新規モジュールを作るほどの量ではなく、`flash.js` は EXIF を知らない（知らせたくない）。

```js
/**
 * 校正フォームに「いま何を出すか」を決める。**表示の判断をここに集約する。**
 * @param {object|null} exif parseExif() の戻り（写真未選択なら null）
 * @param {{syncSpeed:number, inputF:number|null}} ctx 入力欄の現在値を含める
 * @returns {{
 *   notes: Array<{level:'alert'|'warn', text:string}>,  // **全部出す。絞らない**
 *   text: string,          // 描画そのままの1本（'／' 連結）。空なら欄を隠す
 *   blocking: Array<…>,    // 実行を止めるもの（alert のみ）
 *   canCalibrate: boolean, // blocking が空か
 * }}
 */
export function calibrationView(exif, ctx) { … }
```

### `ui.js` に残るもの

**DOM への描画と、入力欄からの値の読み出しだけ。** 3箇所とも同じ2行になる。

```js
const view = calibrationView(calPhotoExif.get(i), { syncSpeed: state.camera.syncSpeed, inputF: readF() });
notes.textContent = view.text; notes.hidden = !view.text;
```

| 契機 | 現在 | 切り出し後 |
| --- | --- | --- |
| 写真の読み取り時 | `inputF: null` で呼び、`map/join` して描画 | 上の2行 |
| **F / ISO の入力変更時** | **呼んでいない** | 上の2行（**新規配線**） |
| 実行時 | `filter('alert')` して例外 | 上の2行 ＋ `if (!view.canCalibrate) throw new Error(view.blocking[0].text)` |

`filter` も `map/join` も `ui.js` から消える。判断が1箇所になる。

### 追加できるテスト

| # | 内容 | いまの I6 との差 |
| --- | --- | --- |
| V1 | 入力 F8・EXIF F11 → `text` に「EXIF は F11、入力は F8.0 です」が**含まれる**／`canCalibrate === true` | I6 は `notes` の**生成**までしか見ていない。V1 は**表示リストに入ること**を見る |
| V2 | `flashFired: false` → `canCalibrate === false`、`blocking[0]` が非発光、**かつ `text` にも含まれる** | 「止めるものは表示もされる」を固定。いまは止めるだけで表示しない |
| V3 | 同調速度超過 → `text` に含まれ `canCalibrate === true`（止めない） | `warn` が捨てられていないことを固定 |
| V4 | `exif === null`（写真未選択） → `text === ''`、`canCalibrate === true` | 手入力だけの校正を壊さないことを固定 |
| V5 | 3件同時 → `text` に3件とも含まれ、順序が安定 | 連結の取りこぼしを固定 |

### 切り出しても残る未テスト領域

- **`ui.js` が3つの契機すべてで `calibrationView` を呼ぶか**（①の原因 1・2 はここ）
- `notes.hidden` の切り替えと、`notes` 欄が画面上で見えるか
- `readF()` が入力欄から正しい値を取るか（`parseFloat` の前処理）
- ファイル読み込み・実機の EXIF・iOS のファイル選択

**つまり①で見つけた3つの原因のうち、テストで守れるようになるのは 3 だけです。**

### やるべきか — **やる価値はあるが、この不具合の再発防止としては弱い**

| 観点 | 評価 |
| --- | --- |
| コスト | 関数15行 ＋ テスト5件 ＋ `ui.js` の書き換え3箇所。小さい |
| この不具合を防げたか | **防げない。** 原因1・2は「呼び方」で、関数の外 |
| 今後に効くか | **効く。** 「絞る／連結する」判断が `ui.js` から消えるので、原因3の型は再発しない |
| 副作用 | `calibrationNotes` と `calibrationView` の2段になる。呼ぶべきほうを間違える余地が増える |

**推奨：切り出しよりも先に、原因1・2を直すほうが効きます。**
`inputF` を実値で渡し、`f` / `iso` の `input` で再描画する。これで3つとも塞がります。
そのうえで切り出せば「判断が1箇所」という形が保てるので、**両方やるなら順序はこの向き。**

副作用の懸念（2段になる）は、`calibrationNotes` を非公開にして
`calibrationView` だけ export すれば消えます。ただし I4〜I6 が
`calibrationNotes` を直接呼んでいるので、テスト側も `calibrationView` 経由に書き換えが要ります。

---

## ③ 警告のタップ領域（実装済み）

### 変更

| 箇所 | 変更前 | 変更後 |
| --- | --- | --- |
| `css/style.css` `.warn-help::after` | `height: calc(100% + 6px)` | **`height: 24px`** |
| `css/style.css` `.warnings` | `gap: 6px` | **`gap: var(--gap-tap)`（8px）** |
| `.warn-help` のコメント | 「行の高さ ＋ gap の半分ずつ」 | 誤りを明記し、`%` が `.warn-help` 自身に解決されることを説明 |
| UI仕様 §7 例外表（タップ判定の行） | 「44×44 に対する逸脱」 | **横 44px × 縦 24px、離間 3px、WCAG 2.2 は満たすが Apple 44pt は縦だけ満たさない** |
| UI仕様 §7 例外表（`gap: 6px` の行） | `.warnings` / `.setup-dots` | `.setup-dots` のみ（`.warnings` は 8px になったため） |

### 離間

```
離間 = 行高 19px + gap − ::after の高さ 24px
  gap 6px → 1px
  gap 8px → 3px   ← 現在
```

24px を 22px に縮めれば離間は 5px になりますが、**WCAG 2.2 の最小 24×24 を割る**ので採りません。

### パネル高さへの影響

警告4件（1行×2 ＋ 2行×2、`margin-top: 8px` 込み）で計算：

| 状態 | 高さ |
| --- | --- |
| 変更前（flex + flex-wrap。`?` が別行 24px） | **236px** |
| グリッド化・gap 6px | 140px |
| **グリッド化・gap 8px（現在）** | **146px** |

**グリッド化で −90px、gap 6→8 で +6px。** 差し引き **−90px**。

### 「240px に4件が収まるか」— **収まりません。ただし警告のせいではありません**

`.result-panel` は `max-height: 46dvh` ＋ `overflow-y: auto` で、**もともとスクロールします。**
ストロボ ON のときの中身を積み上げると：

| 要素 | 高さ |
| --- | --- |
| `.panel-handle`（44px ＋ `margin-bottom: -6px`） | 38px |
| `.wall-readout`（24px の数字） | 約 29px |
| `.ev-ruler`（`margin 8+8` ＋ `.ev-scale` 26+1+6） | 49px |
| **トラック4本（`.wheel` が 64px ＋ `margin-bottom: 8px`）** | **288px** |
| `.result-systems`（2枚のカード） | 約 90px |
| `.path-compare` | 約 80px |
| 警告4件 | 146px |
| **合計** | **約 720px** |

**トラック4本（288px）だけで 240px を超えています。** 46dvh は 16 Pro Max（932pt）で約 429px、
375×812 で約 373px なので、いずれにせよスクロールします。これは今回の変更以前からの状態です。

したがって今回意味があるのは**絶対値ではなく差分**で、
警告ブロックが 236px → 146px に減った分だけスクロール量が減ります。
`gap` の +6px はその中に埋もれます。

> **UI仕様 §2 の「結果パネル 240px」は設計上の目安値で、実測とは違います。**
> ストロボ ON でトラック4本が出る構成では最初から超えています。
> ここを実測に合わせるかどうかは別途の判断が要ります（今回は触っていません）。

### 横方向は変わらない

`::after` の `width` は `var(--tap-min)`（44px）のままなので、
監査報告 ③ の結論（片側 13px の食み出し ≤ `.result-panel` の右パディング 16px、余裕 3px）は
そのまま成立します。
