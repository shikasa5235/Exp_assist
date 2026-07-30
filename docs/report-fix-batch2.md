# 修正①〜⑤ 完了報告

作成日: 2026-07-30 ／ ブラウザでの実行検証は未実施

---

## 検証結果まとめ

| 項目 | 結果 |
| --- | --- |
| tools/check-help-anchors | OK（19件すべて実在）exit 0 |
| tools/check-modules | OK（98件の import が解決、export 63件） |
| テスト総数 | **62 件**（58 ＋ 新規4件：#43〜#46） |
| 見出し数（MAINTENANCE §7） | markdown 76 / index.html 76 → 一致 |

見込みの63件との差1件について：追加指示は #43・#44・#45・#46 の4件だったため 58＋4＝62 です。

---

## ② の回答：コードを読んだ結果

**実装は「推定 k に戻る」挙動です。**

    js/compute.js
    function kFor(prof, modifierKey) {
      const v = prof.cal ? prof.cal[modifierKey] : undefined;
      return v == null ? prof.k : v;   // ← 未校正なら base k（4.0）
    }

したがって標準リフレクターで k=2.33 を校正し、オクタ60cm（未校正）へ切り替えると
**推定 k=4.0 に戻り、オクタの推定2段を適用 → 到達 14.14m** になります。

**矛盾していたのは報告文であって実装ではありませんでした。**
テスト #40 のコードは元から 14.14m を期待しており（`gnIsoEst = 4.0 × √200 × √2`）、
報告書に書いた「#38 と #40 はどちらも 8.2m」という一文が誤りでした。
以前の指示で #40 の期待値が 8.24m とされていた点との食い違いを、私が報告時に埋め合わせてしまいました。

対応：#40 の期待値を 14.14m と明示し、コメントに「推定 k に戻る」ことを書きました。

---

## ③ の回答：二重計上は**実在するバグでした**

    js/compute.js（修正前）
    const modLoss = modLossOf(st.flash.modifier);   // 常に推定値を適用
    ...
    applyModifier(gnBase(prof.ws, kFor(prof, modifier)), modLoss)

`kFor()` が `cal[modifier]`（実測 k）を返す場合も `modLoss` を適用していたため、
校正済みの組み合わせでは減光を二重に引いていました。

**#40 は未校正のケースなので、このバグがあっても緑になります。**
指摘どおり、校正済みケースを検証するテストが存在しませんでした。

### 修正（推奨設計を採用）

    function modLossFor(prof, modifierKey) {
      return isUncalibrated(prof, modifierKey) ? modLossOf(modifierKey) : 0;
    }

| 状態 | 使う k | モディファイア減光 |
| --- | --- | --- |
| `cal[modifier]` あり | 実測 k | **適用しない（0段）** |
| `cal[modifier]` なし | `profile.k`（推定の基準） | 推定値を適用 |

追加テスト：

- **#43** オクタ60cm で校正（`cal.octa60`）→ 到達が実測どおりで、二重計上時の値（半分）にならないこと
- **#44** 標準リフレクター校正済み → オクタ60cm 切替 → 14.14m かつ uncalibrated = true

---

## ① fixed モードの上限クランプを撤去

`#38` の赤（実測 5.83m / 1/8）の原因です。

    修正前: powerStops = Math.max(ceiling, Math.min(minPower, flash.powerStops));
    修正後: powerStops = Math.max(0,       Math.min(minPower, flash.powerStops));

段数の向きは元から正しく（`1/1=0 … 1/128=7`、`shortStops = max(0, ceiling − over)`）、
問題は **fixed モードにも `ceiling` を適用していたこと**でした。
`powerCeilingStops` は auto の主案選択にだけ効く上限であり、ユーザーが明示的に選んだ 1/4 を
1/8 に変えるのは「入力を拒否しない」原則に反します。

追加テスト：

- **#46** 上限 1/8 の状態で 1/4 を固定 → 1/4 のまま計算され推奨距離 8.24m、上限警告が出ないこと

これで **#38（推奨距離 8.24m）も緑になる見込み**です。

---

## ④ 保存データの移行（v1 → v2）

`js/state.js` に `SCHEMA_VERSION = 2` と `migrate(loaded)` を追加しました。
**純粋関数**（DOM・localStorage に触らない）なのでテストできます。
`ui.init()` が読み込み直後に一度だけ呼び、既定値マージの前に移送します。

| 変更 | 種類 | 移行 |
| --- | --- | --- |
| `profile.calibrated`(bool) → `profile.cal`(obj) | 意味の変更 | `calibrated: true` の `k` を `cal.reflector` へ移送。`calibrated` は削除 |
| MODIFIERS のキー削除 | 項目の削除 | 未知の `modifier` は標準リフレクターへフォールバック（`NaN` 化を防ぐ） |
| `powerCeilingStops` 追加 | 項目の追加 | 無ければ既定 2 を入れる |

- 移送先のキーは実装の実キー **`reflector`** です（指示の `'standard'` に相当）
- `profiles[].modifier` と `flash.modifier` の両方をフォールバック対象にしています
- 移行時は一度だけトースト：
  「モディファイアごとの校正に対応しました。標準リフレクター以外は再校正が必要です」
- **校正値 k は破棄せず移送**（MAINTENANCE §9「再取得にコストがかかる」）

追加テスト：

- **#45** 旧データ（`schemaVersion` なし・`calibrated: true` / `k: 2.9` / `modifier: 'umbTrans'` /
  `flash.modifier: 'sbLarge'`）を `migrate()` に通し、`cal.reflector = 2.9`、
  `calibrated` が消え、両方の `modifier` が `reflector` になり、通知文に「再校正」が含まれること

---

## ⑤ ブラックミストを設定タブにも配置

「ブラックミストを常時装着」トグルを設定タブ（その他）に追加しました。
計算タブのトグルは残しています。**同じ `state.filters.blackMist` を見るので双方向に連動**します。

ご指摘のとおり、かんたんタブでは切り替えられないのにケラレ警告の枚数には含まれる状態でした。
機材の事実（レンズに付いているか）はタブに依存しないので、設定タブが本来の置き場所です。

---

## 文書の更新

| 文書 | 内容 |
| --- | --- |
| spec.md §7.4.1 | `powerCeilingStops` は auto の主案選択にだけ効く上限。fixed では無視することを明記 |
| spec.md §7.5 | 校正済みの組み合わせでは減光段数を適用しない（二重計上の禁止）を表で明記。切替時に推定 k に戻る例（14.1m）も記載 |
| MAINTENANCE.md §9 | v1→v2 の移行内容を表で追加。`migrate()` の場所、通知文、k を破棄しない方針 |

index.html のマニュアル本文に対する変更はありません（今回の修正はユーザー向け文言に影響しないため）。
見出し数は 76 対 76 で一致を維持しています。

---

## 確認していただきたい画面操作

1. **かんたん → スローシンクロ → 発光量 1/4 を選ぶ**（設定の上限が 1/4 のまま）
   → 推奨距離 8.2m 相当。上限警告が出ないこと
2. **設定タブで「発光量の上限」を 8（=1/8）に変える** → かんたんタブに戻り 1/4 を選ぶ
   → **1/4 のまま**で推奨距離 8.2m（1/8 に丸められないこと）＝ ①の修正点
3. **おまかせに切り替える** → 上限 1/8 が効き、必要量がそれより強いときは上限警告が出ること
4. **設定タブ → 標準リフレクターで校正** → バッジ消える
   → **オクタ60cm に切替** → バッジが戻り、到達距離が伸びる（推定 k=4.0 に戻るため）
5. **オクタ60cm でも校正する** → バッジ消える。到達距離が実測どおりになり、
   **さらに2段暗くならない**こと（③の二重計上が無いこと）
6. **設定タブ →「ブラックミストを常時装着」** をON → 計算タブのブラックミストチップもONになる
7. **計算タブでOFF** → 設定タブもOFFになる（双方向の連動）
8. **移行の確認（任意）**：DevTools で旧形式を書き込んでリロード

        localStorage.setItem('expo-state-v1', JSON.stringify({
          profiles: [{ id:'p1', name:'100Ws', ws:100, k:2.9, hss:true,
                       minPowerStops:7, modifier:'umbTrans', calibrated:true }],
          flash: { profileId:'p1', modifier:'sbLarge', distance:3, ambientOffset:-1 }
        }));

   → リロードでトースト「モディファイアごとの校正に対応しました…」が出て、
   設定タブのモディファイアが標準リフレクターになり、校正済みバッジが消えていないこと

tests.html は 62 件。実行結果の確認をお願いします。
