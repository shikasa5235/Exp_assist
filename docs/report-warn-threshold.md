# 露出過不足の警告：1/3段の閾値と ND の組み合わせ提示（全数調査）

対象：`js/advisor.js` / `js/compute.js` の警告生成箇所 **全22件**。
`grep -n "level: '" js/*.js` で機械的に洗い出したものを1件ずつ判定した。

判定基準：**露出の過不足（段数差）を条件にしている警告か**。
条件が「枚数」「インデックス」「真偽値」のものは端数が生まれないので対象外。

---

## 1. 今回 1/3段の閾値を入れた／揃えた箇所（6件）

| # | 場所 | 警告 | 変更前の閾値 | 変更後 |
| --- | --- | --- | --- | --- |
| 1 | `advisor.overBrightWarning` (advisor.js:92) | 明るすぎます。◯段の減光が必要です | **なし**（`neededT < maxSSReal` のみ） | `stops < THIRD_STOP` で `null` |
| 2 | `advisor.isoFloorWarning` (advisor.js:114) | 明るすぎます。ISO を◯段下げきれません | **なし**（`neededISO < min` のみ） | `stops < THIRD_STOP` で `null` |
| 3 | `advisor.daylightSync` HSS クランプ (advisor.js:250) | HSS経路は SS上限のため背景は◯段までです | `clampStops > 1e-6` | `clampStops >= THIRD_STOP`（`ssClamped` フラグと警告の両方） |
| 4 | `compute.clampAmbient` 光量不足 (compute.js:188) | 光量が◯段足りません | `shortStops > 1e-3` | `>= THIRD_STOP` |
| 5 | `compute.clampAmbient` 被写体ブレ・段数付き (compute.js:194) | 被写体が流れます（◯段不足） | `ssReal > r.missSS`（実質 0） | `log2(ssReal/missSS) >= THIRD_STOP` |
| 6 | `compute.clampAmbient` 被写体ブレ・基準 (compute.js:205) | 被写体が流れます。1/◯ 以上にしてください | `ssReal > req`（実質 0） | `log2(ssReal/req) >= THIRD_STOP` |

閾値はすべて `advisor.THIRD_STOP` を import して共有している。新しい定数は作っていない。

### 併せて直したマジックナンバー（挙動は不変）

| 場所 | 変更前 | 変更後 |
| --- | --- | --- |
| `compute.computeDaylight` 壁の表示判定 (compute.js:638) | `dp.wallStops > 1 / 3` | `dp.wallStops > THIRD_STOP` |

値は同じ。`daylightSync` 側の早期 return（`wallStops <= THIRD_STOP`）と同じ境界を使うことを
コメントで明示した（ここだけ緩いと、経路が無いのに壁の数値だけ出る）。

---

## 2. すでに閾値があった箇所（4件・変更なし）

| 場所 | 警告 | 閾値 |
| --- | --- | --- |
| `advisor.shakeWarning` (advisor.js:45) | 手ブレしやすい速度です | `stops < THIRD_STOP` |
| `compute.clampWarning` → `manualShort` (compute.js:504) | 計算タブのクランプ（◯段足りません／◯段超過） | `stops < THIRD_STOP` |
| `compute.resolveFlashSide` fixed の過不足 (compute.js:309) | 発光量◯ では◯段 強すぎます／足りません | `Math.abs(diff) >= THIRD_STOP` |
| `compute.resolveFlashSide` auto の上限・下限 (compute.js:318 / 337) | 上限◯ では◯段 足りません／最小発光量◯ でも◯段 強すぎます | `shortStops >= THIRD_STOP` / `excessStops >= THIRD_STOP` |

`advisor.daylightSync` の壁判定（`wallStops <= THIRD_STOP` で経路を組まない）も既に閾値あり。

---

## 3. 対象外と判定した箇所（12件）

段数差を条件にしていないので、端数による誤発火が構造的に起きない。

| 場所 | 警告 | 条件の型 |
| --- | --- | --- |
| `advisor.freezeWarning` (advisor.js:141) | 閃光時間◯ ではこの被写体は止まりません | 閃光時間 vs 必要SS（露出の過不足ではない。下記参照） |
| `advisor.ndCountWarnings` ×2 (advisor.js:170 / 179) | 拡張ISOを使えば◯枚で済みます／◯枚重ねます | 枚数 |
| `compute.clampAmbient` 回折 (compute.js:212) | 回折で解像が落ち始めます | 1/3段インデックスの比較 |
| `compute.clampAmbient` 高感度 (compute.js:214) | ノイズが目立ち始める領域です | ISO が上限の半分超（境界に意味がない） |
| `compute.clampAmbient` 三脚 (compute.js:215) | 三脚推奨 | SS ≧ 1/2秒 |
| `compute.resolveFlashSide` 到達不足 (compute.js:326) | フル発光でも◯段 足りません | 外側の `shortStops >= THIRD_STOP` が効いている |
| `compute.attachedFilterWarnings` (compute.js:577) | フィルター◯枚 | 枚数 |
| `compute.computeDaylight` 壁越え不能 (compute.js:681) | 同調速度の壁を越えられません | 経路がどちらも無い（真偽） |
| `compute.computeSlow` 後幕 (compute.js:726) | 後幕シンクロ推奨 | SS > 1/60 |
| `compute.computeSlow` チャージ (compute.js:729) | チャージが追いつきません | `powerStops === 0` |
| `compute.compute` 正常 (compute.js:543) | この設定で撮れます | 警告0件 |

### `freezeWarning` について（判断の記録）

`durationReal <= subjectSSReal` で発火するので、**閃光時間が必要SSをわずかに超えただけでも出る。**
誤発火の型としては同じだが、比べているのは露出の段数ではなく時間そのもので、
閃光時間（`POWER_STEPS.duration`）は1段刻みの離散値なので端数が積み上がる構造にない。
今回は**触っていない。** 閾値を入れるかは別途判断が要る（対象を広げると仕様が変わるため）。

---

## 4. 必要減光量の表示精度（②）

### 調べた結果：整数への丸めは行っていなかった

`formatStops()` は元から小数第1位まで出す（`4.47 → "4.5"`）。整数丸めをしている箇所は
警告文には存在しない。丸めているのは **ND の必要段数を `Math.ceil` する箇所だけ**で、
これは ND が整数段でしか存在しないため正しい。

ただし `overBrightWarning` の文言が **「約◯段」** で、丸めた概数だと読める書き方だった。

### 変えたこと

| | 変更前 | 変更後 |
| --- | --- | --- |
| 文言 | 明るすぎます。**約**4.7段の減光が必要です（ND） | 明るすぎます。4.7段の減光が必要です。**ND2+ND16（5段）を装着してください** |
| 計算タブ | 明るすぎます（4.7段超過）。**ND を足す**／… | 明るすぎます（4.7段超過）。**ND2+ND16（5段）を装着**／… |

「約」を外した。`formatStops` の精度（小数第1位）はそのまま。

### ND の組み合わせ提示（新設 `advisor.ndAdvice`）

```
ndAdvice(ownedND, requiredStops, attachedStops)
  → { text: 'ND2+ND16（5段）を装着', ok: true, solution, need }
```

- 必要段数は **切り上げる**（`Math.ceil`）。切り捨てると足りず、装着しても警告が残る
- 切り上げた余りは自由軸が吸収する。自由軸は「明るすぎ」側の限界に張り付いているので、
  暗くする方向には動かせる。**これが「警告が消えない」問題の実質的な解**
- `attachedStops` には **ND だけ**を渡す（`ndOnly`）。ブラックミストの減光は残差に既に
  反映済みなので、足すと二重に数えて濃い ND を勧めてしまう
- 所有 ND で作れないときは「所有 ND（合計◯段）では ◯段 に届きません」

呼び出し元は `advisor.overBrightWarning`（かんたんタブ）と `compute.manualShort`（計算タブ）の2箇所。

---

## 5. 行き過ぎ（暗すぎ）側 — 対称性の確認

### 5.1 閾値の対称性

| 経路 | 明るすぎ側（under-correction） | 暗すぎ側（over-correction） |
| --- | --- | --- |
| 計算タブ（自由軸クランプ） | `clampWarning` に `THIRD_STOP` | **同じ関数**が両側を通る。対称（テスト #31d が実証） |
| かんたんタブ（SS 上限） | `overBrightWarning` に `THIRD_STOP` を追加 | — |
| かんたんタブ（SS 系列最遅 30″） | — | **警告そのものが無かった。**下記 5.2 |

### 5.2 見つけた欠陥：30″ クランプが黙っていた

`compute.clampAmbient` の

```js
if (ssReal > SLOWEST) ssReal = SLOWEST;   // 変更前：警告なし
```

**ND を足しすぎて 30秒 を超えたとき、黙って 30″ に切って表示していた。**
達成できない露出を正しい答えとして出すことになる（明るすぎ側では警告していたので非対称）。

段数付きの警告を追加した。閾値は明るすぎ側と同じ `THIRD_STOP`。

```
暗すぎます。SS は 30″ が限界で 0.5段 足りません。ND2 を外す／ISO を 0.5段上げる／三脚で長秒に耐える
```

`helpId` は既存の `help-warn-light-short` を流用（同じ「光量不足」の系統）。
テスト **W4** が 1/6段で出ないこと・0.5段で出ることを1件で示す。

### 5.3 切り上げが大きく行き過ぎる場合

`ndAdvice` に行き過ぎ量（`overshoot`）を追加した。所有 ND の刻みによっては
必要 4.7段 に対して 7段 しか作れず、2.3段 暗くなる。

```
明るすぎます。4.7段の減光が必要です。ND8+ND16（7段）を装着してください（2.3段 暗くなります）
```

**1/3段未満は書かない**（W3 の 0.3段 は無表示）。書くと端数の説明が常時出て読み飛ばされる。

---

## 6. 袋小路の解消（実機で確定した本当の原因）

### 6.1 症状

```
ND8（3段）  → 「明るすぎます（1段超過）」＋「上限 1/4 では 0.4段 足りません」
ND16（4段） → 明るすぎは解消。「上限 1/4 では 1.4段 足りません」
```

ND が1段増えると不足がちょうど1段増える。**ND は両系統に等しく効く**ので物理は正しい。
問題はアプリの提案が「ND を1枚外す」で、それが元の「明るすぎ」に戻していたこと。

### 6.2 ① 上限超過の提案を組み替えた

`powerCeilingStops` は**機材の限界ではなくユーザーの好み**。だから設定を戻すのが最も簡単。

| | 変更前 | 変更後 |
| --- | --- | --- |
| 文面 | 上限 1/4 では 1.4段 足りません。距離を 1.3m まで詰める／ISO を 1.4段上げる／**ND を1枚外す** | 上限 1/4 では 1.4段 足りません。**上限を 1/2 に上げる（この設定で撮れます）**／距離を 1.3m まで詰める／ISO を 1.4段上げる |
| 提示する上限値 | — | `Math.floor(over)` ＝ **必要量を満たす最も弱い段** |
| 操作 | 設定タブへ移動 | 警告内のボタンで即変更（`action`） |
| ND を外す案 | あり | **削除** |

`over ≧ 0` の分岐なので `floor(over)` は必ず存在する。`over < 0`（フル発光でも届かない）は
別分岐で「**この機材では届きません。**フル発光でも◯段 足りません」に切り替わる。

### 6.3 ② 提案の検証：解析的判定（循環依存を避けた方法）

**採らなかった方法：** 提案を当てた状態で `compute()` を再実行して警告を数える。
`advisor` → `compute` の呼び出しが循環依存になり、提案の数だけ全体計算が走る。

**採った方法：** 各計算経路が「その軸に何段の余地があるか」を1つの数値
（`d.ndRemovable.slack`）として出し、`compute.ndRemovalOption()` が解析的に比べる。

```js
overshoot = thinnest − gainStops        // 外して明るくなる分 − 埋めたい不足
if (overshoot > slackStops + THIRD_STOP) return null;   // 明るすぎに化けるので出さない
```

| 経路 | slack の定義 |
| --- | --- |
| `computeManual` | 自由軸が明るい側の限界まで動ける段数（`LIMITS` の `loKind`/`hiKind` から引く） |
| `computeSlow` | `log2(SS / maxSS)` |
| `computeDaylight` | `ndPath.totalStops − wallStops`（壁に要る量を超えた余剰） |

`gainStops` は「その提案で埋めたい不足」。アンビエント自身の不足を埋める提案（30″ クランプ・
計算タブの `short` 側）ではその分を行き過ぎに数えない。ストロボ側の不足では 0 を渡す
——アンビエントは合っているので、外した段数がまるごと行き過ぎになるため。

**適用箇所**

| 場所 | 扱い |
| --- | --- |
| `resolveFlashSide` 上限超過 | **ND を外す案を削除**（①の指示。slack を見るまでもなく袋小路） |
| `resolveFlashSide` 到達不足 | `ndRemovalOption` で判定 |
| `manualShort` 不足側 | `ndRemovalOption` で判定（`gainStops` = 不足段数） |
| `clampAmbient` 30″ クランプ | `ndRemovalOption` で判定（同上） |

ユーザー報告の状態（計算タブ・ND16・自由軸 ISO が下限200に張り付き）では
slack = **−0.7段**（余地なし）。thinnest = 4段 なので提案されない。テスト **W5** が実証。

---

## 7. 副次的に見つけたもの

- `compute.js` が `isoFloorWarning` を **import していたが呼んでいなかった**（未使用 import）。
  意図別ロジックは ISO を下限から上げる方向にしか動かさないため、ISO が下限を割る経路が
  compute には無い（過剰分は SS 側に出て `overBrightWarning` が拾う）。import を外した。
  **関数自体は残している**（テスト #5b・#33 が直接呼ぶ／将来 ISO 優先の意図を足すときに使う）。
- `ndName` / `ndLabelOf` が `compute.js` にあり、ND の表示名生成が計算モジュールに散っていた。
  `filters.js` に `ndName` / `ndLabel` として移し、`advisor.js` と `compute.js` の両方から使う。
