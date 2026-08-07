# UI 修正の再確認（①grep の数 ②警告の行間 ③`::after` の横はみ出し）

**使い捨ての報告。確認が済んだら削除してよい。** コードは変更していない。

---

## ① grep の数：私の報告が誤りでした

**「20件見つけて19件を変更」は数え間違いです。** 正しくは **28行・29出現、その全部を変更**。
**変更しなかったものはありません。** 現在 grep がゼロ件なのはそのためです。

### 原因

`grep -rn` の出力を目で追ってファイルごとに束ね、`wc` を通さずに表を書きました。
さらに「件」を行とも出現とも定義せずに使ったため、二重に狂っています。

- 行と出現を区別していなかった（`docs/MAINTENANCE.md:813` は**1行に2出現**）
- 「変更しなかった 1件」は**存在しません**。`state` のキーやアンカー ID は
  そもそも「かんたん」という文字列を含まないので、grep の母数に入っていませんでした。
  それを「見つけたが変更しなかった1件」と書いたのが誤りです

### 数え直し（`git diff` の削除行から機械的に数えたもの）

```bash
git diff -U0 | grep '^-' | grep -o 'かんたん' | wc -l          # 出現数
git diff -U0 -- <file> | grep '^-' | grep -o 'かんたん' | wc -l # ファイル別
```

| ファイル | 出現数 | 行数 |
| --- | ---: | ---: |
| `index.html` | 6 | 6 |
| `docs/exposure-app-manual.md` | 4 | 4 |
| `docs/exposure-app-spec.md` | 4 | 4 |
| `docs/report-phase1.md` | 3 | 3 |
| `js/ui.js` | 3 | 3 |
| `docs/MAINTENANCE.md` | **2** | **1** |
| `docs/exposure-app-photocal-spec.md` | 2 | 2 |
| `docs/exposure-app-photocal-tasks.md` | 2 | 2 |
| `docs/exposure-app-ui-spec.md` | 2 | 2 |
| `js/compute.js` | 1 | 1 |
| **合計** | **29** | **28** |

`docs/MAINTENANCE.md:813` の1行に「簡単タブ側」「簡単タブでは」の2出現があります。

### 変更しなかったもの（grep の母数外）

以下は「かんたん」を含まないため、そもそも 29 に数えていません。**すべて無傷です。**

| 対象 | 現在の値 | 確認 |
| --- | --- | --- |
| タブの `data-tab` | `easy` / `calc` / `settings` | `grep -c 'data-tab="easy"' index.html` → 1 |
| `state.ui.tab` の既定値 | `'easy'` | `grep -c "tab: 'easy'" js/state.js` → 1 |
| パネルの `id` と `aria-controls` | `tab-easy` ほか | `grep -c 'id="tab-easy"' index.html` → 1 |
| マニュアルのアンカー | `help-xxxx` | `check-help-anchors` exit 0 |

---

## ② 警告の行間と `::after` の縦位置

### CSS から読み取った3点

| 問い | 値 | 出典 |
| --- | --- | --- |
| `.warn-item` どうしの縦の間隔 | **6px**（`row-gap`） | `.warnings { display:flex; flex-direction:column; gap:6px }`。`.warn-item` に `margin` は無し |
| `::after` の縦方向の配置 | `top: 50%` ＋ `transform: translate(-50%, -50%)` | `.warn-help::after` |
| 中央か上端揃えか | **`.warn-help` の中央** | 上記のとおり |

### 判定：**重なりはゼロ。ただし理由が私の書いたコメントと違います**

**`height: calc(100% + 6px)` の `100%` は行の高さではなく `.warn-help` 自身の高さ（18px）です。**

絶対配置要素のパーセント高さは、直近の位置指定祖先＝`position: relative` を持つ
`.warn-help` のパディングボックスに対して解決されます。`.warn-help` の高さは
`var(--icon-xs)` = 18px 固定なので、

```
::after の高さ = 18px + 6px = 24px（常に）
```

**行の高さには連動しません。** 本文が2行でも3行でも 24px のままです。
CSS のコメントに書いた「= 行の高さ ＋ `.warnings` の gap 6px の半分ずつ」は**誤りです。**

### 重なりの計算

```
.warn-help は margin-top: 1px、align-items: start
  → 行の上端から  1px 〜 19px を占める。中心は 10px
::after は中心 ±12px
  → 行の上端 −2px 〜 +22px

1行の警告の行高 H = max(アイコン 1+18, 本文 13×1.45≈18.85, ? 1+18) = 19px
次の行の上端     = H + 6 = 25px
次の ::after 上端 = 25 − 2 = 23px
現在の ::after 下端 = 22px

離間 = 23 − 22 = +1px  → 重なりゼロ
```

**あなたの判定基準（行間 6px 以上なら重なりゼロ）と結論は一致します。**
`::after` は上下へ 3px ずつしか出ておらず、行間 6px に収まっているためです。

### ただし2点、報告に誤りがありました

1. **縦のタップ領域は 24px です。** 前回「行の高さ ＋ gap の半分」と書いたのは誤りで、
   実際は行の高さに関係なく 24px 固定。多行の警告でも広がりません
2. **「44px を積むと 19px 重なる」という説明は、実装していない案についての話でした。**
   実際のコードは 24px なので重なりません。逸脱の中身は
   「重なるのを避けるために縦を削った」ではなく「**縦が 24px しかない**」です

`css/style.css` の `.warn-help` のコメントと、UI仕様 §7 の例外表の記述は
**この2点について事実と違います。** 直すかどうかはご判断ください。

### 選択肢（修正するなら）

| 案 | 縦の判定 | 隣との離間 | 備考 |
| --- | --- | --- | --- |
| 現状維持 | 24px | 1px | 記述だけ事実に合わせる |
| `height: 24px` と直書き | 24px | 1px | `100%` の誤解を断つ。挙動は同じ |
| `height: calc(100% + 4px)` | 22px | 2px | 離間を少し広げる |
| `.warnings` の `gap` を 8px へ | 24px | 3px | `--gap-tap` に揃う。パネル高さが 1件あたり 2px 増える |

---

## ③ `::after` の横方向のはみ出し

### 数値

| 項目 | 値 | 出典 |
| --- | --- | --- |
| `--icon-xs` | **18px** | `css/style.css:75` |
| `--tap-min` | **44px** | `css/style.css:71` |
| 片側のはみ出し `(44 − 18) / 2` | **13px** | — |

### `.warn-help` の右にあるものを親まで遡る

| 要素 | 右側の余白 | 出典 |
| --- | ---: | --- |
| `.warn-help` | 0 | 3列グリッドの最終列。`margin-right` なし |
| `.warn-item` | 0 | `padding` なし。`grid-template-columns: auto 1fr var(--icon-xs)` が content box を使い切る |
| `.warnings` | 0 | `margin-top: 8px` のみ |
| `.result-panel` | **16px** | `padding: 0 16px calc(10px + var(--sab))` |
| **合計** | **16px** | — |

### 判定：**収まります（13px ≤ 16px、余裕 3px）**

`.warn-help` の右端は `.result-panel` の content box の右端と一致し、その外側に
16px のパディングがあります。`::after` は 13px 食み出すので、**パディングの内側で止まります。**

### `overflow-x` を持つ祖先

| 要素 | 指定 | 実効 |
| --- | --- | --- |
| `.result-panel` | `overflow-y: auto`（`overflow-x` は未指定） | **`overflow-x` は `auto` に計算される**（片方が `visible` 以外だと `visible` は `auto` になる CSS の規則） |
| `.scroll-body` | `overflow-y: auto` | 同上。ただし警告はこの中に無い |
| `body` / `html` | 指定なし | `visible` |

**したがって `.result-panel` は実質的にスクロールコンテナです。**
はみ出しが 16px を超えていれば横スクロールバーが出る位置関係でしたが、
13px なので出ません。**余裕は 3px しかありません。**

`--icon-xs` を 20px 以上にするか `.result-panel` の左右パディングを 12px 以下にすると、
**この 3px が消えて横スクロールが出ます。** どちらかを触るときはここを一緒に見てください。

### 断定できない部分

- iOS Safari のオーバーレイスクロールバーは幅を取らないので、上の計算はそのまま成り立ちます。
  デスクトップの常時表示スクロールバーは content box を狭めるだけで、
  パディングは減らないため結論は変わりません
- `::after` は `content: ""` の空要素で背景も枠線も無いため、**見た目には現れません。**
  横スクロールの有無だけが観測可能な影響です

---

## ④ `docs/report-phase2.md` への追加（反映済み）

| 箇所 | 内容 |
| --- | --- |
| §3 | 「差 = 0.0816段」→ **0.08114段**（`2·log2(2.400000/2.333452)`） |
| §6 優先度1 | **Q19** を追加（写真で校正 → 同じモディファイアを手入力で再校正 → 出所が消えるか） |
| §6 Q9 | 期待値の表を追加。**入力優先なら k = 1.70 / EXIF 優先なら 2.40、ちょうど1段差** |
| §7（新設） | 下記2件 |

### §7.1 手入力と EXIF の食い違いが**画面に出ない**（不具合・未修正）

仕様 §4.3 が「実用上いちばん効く」と書いている検証が、**計算されたあと捨てられています。**

```js
const blocking = exif
  ? calibrationNotes(exif, { …, inputF: fAperture })
      .filter((n) => n.level === 'alert')   // ← warn（食い違い）はここで落ちる
  : [];
```

- 校正の実行時：食い違いは `warn` なので `blocking` に残らず、どこにも表示されない
- 写真の読み取り時：`inputF: null` を渡しているので判定していない

**`calibrationNotes` 自体は正しく、テスト I6 も緑です。** 抜けているのは UI への配線だけ。
**純粋関数のテストが緑であることを「実装済み」の根拠にできない例**なので記録しました。

Q9 がちょうどこの不具合を踏む手順です。

### §7.2 校正値を消す UI は **無い**

| UI | 対象 | `cal` と `calMeta` |
| --- | --- | --- |
| 「初期値に戻す」 | 全設定 | `setState(clone(defaultState))` で丸ごと置換。**対で消える** |
| 「校正を取り消す」 | `state.phone` のみ | ストロボの `cal` / `calMeta` には触れない |

**モディファイア単位でストロボ校正を消す UI は存在しません。**
「`cal` を消したのに `calMeta` が残る」経路は、いまのところ再校正（Q19）だけで、
そこは `runCalibration` の `delete meta[mod]` が対処しています。
