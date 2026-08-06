// scenes.js — 定数データのみ。副作用ゼロ（DOM・localStorage・window に触らない）。
// 計算モジュールが参照する表引きデータ。マジックナンバーはここか各モジュール冒頭に集約する。

/**
 * シーン EV（ISO100 基準の EV100）。仕様 §7.1。
 * ±1段程度の目安。UI 側で ±2段(1/3刻み)の微調整を用意する前提。
 * @type {ReadonlyArray<{key:string,label:string,ev:number,group:string}>}
 */
/**
 * `contrast` = **空（または最も明るい背景）が被写体より何段明るいか**の目安（段）。
 * 白飛び判定に使う（仕様 §11 / photocal-spec §5.4）。**±1段の推定値。**
 *
 * `null` は「このシーンでは判定しない」。屋内・夜間と薄暮では、最も明るい背景が
 * 光源そのもの（窓・街灯・空の残光）で、被写体との差は**シーンEV ではなく画角の切り方で決まる。**
 * 表で当てられないので、当てずっぽうの警告を出さずに黙る。
 *
 * 逆光は EV では区別できないので、`flash.backlit` トグルで `BACKLIT_EXTRA_STOPS` を足す。
 * 快晴 2.5 + 2.0 = 4.5（＝仕様の「快晴・逆光」）、薄曇り 2.0 + 2.0 = 4.0（＝同「晴れ・日陰の被写体」）。
 */
/**
 * 写真からの実測 EV を使っているときの `scene.key`。**`SCENES` にわざと入れていない。**
 * 表引きが外れることで白飛び判定（`contrast`）が自動的に黙る — 測定値からは空と被写体の
 * コントラストが分からないので、当てずっぽうの警告を出さないほうがよい。
 */
export const MEASURED_SCENE_KEY = 'measured';

export const SCENES = Object.freeze([
  // 屋外
  { key: 'snow',       label: '雪山・砂浜の直射', ev: 16, group: '屋外', contrast: 2.5 },
  { key: 'sunny',      label: '快晴・順光',       ev: 15, group: '屋外', contrast: 2.5 },
  { key: 'hazySun',    label: '晴れ・薄曇り',     ev: 14, group: '屋外', contrast: 2.0 },
  { key: 'cloudy',     label: '曇り',             ev: 13, group: '屋外', contrast: 1.5 },
  { key: 'heavyCloud', label: '厚い曇り／日陰',   ev: 12, group: '屋外', contrast: 1.0 },
  { key: 'sunset',     label: '日没直後',         ev: 11, group: '屋外', contrast: 2.0 },
  { key: 'twilight',   label: '薄暮',             ev: 9,  group: '屋外', contrast: null },
  // 屋内・夜間
  { key: 'shop',       label: '明るい店舗',       ev: 8,  group: '屋内・夜間', contrast: null },
  { key: 'neon',       label: '夜の繁華街',       ev: 8,  group: '屋内・夜間', contrast: null },
  { key: 'stage',      label: 'ステージ・体育館', ev: 7,  group: '屋内・夜間', contrast: null },
  { key: 'room',       label: '一般的な室内',     ev: 5,  group: '屋内・夜間', contrast: null },
  { key: 'street',     label: '街灯のある夜道',   ev: 4,  group: '屋内・夜間', contrast: null },
  { key: 'candle',     label: 'ろうそく／間接',   ev: 3,  group: '屋内・夜間', contrast: null },
  { key: 'moon',       label: '満月の風景',       ev: -2, group: '屋内・夜間', contrast: null },
  { key: 'milkyway',   label: '天の川・星景',     ev: -6, group: '屋内・夜間', contrast: null },
]);

/**
 * 逆光のときコントラスト目安に足す段数。仕様 §11。
 * 逆光かどうかはシーンEV では区別できない（同じ EV で順光にも逆光にもなる）ため、
 * シーンの表に列を増やすのではなくトグル1つで足す。
 */
export const BACKLIT_EXTRA_STOPS = 2.0;

/**
 * アンビエント目標段数の選択肢（符号付き。−1 = 背景を1段暗く）。
 * **白飛び警告が「選ぶべき背景段数」を出すために計算側でも必要**なのでここに置く
 * （UI と計算で別々の配列を持つと、推奨した値がチップに無い、という食い違いが起きる）。
 */
export const AMBIENT_OFFSETS = Object.freeze([-3, -2, -1, 0, 1]);

/**
 * ハイライトのヘッドルーム（段）。中間調から飽和までの余裕。仕様 §11。
 * JPEG は約3段、RAW なら 3.5〜4段。**機種差があるので設定で調整できる。**
 */
export const HIGHLIGHT_HEADROOM_DEFAULT = 3.0;
export const HIGHLIGHT_HEADROOM_MIN = 2.0;
export const HIGHLIGHT_HEADROOM_MAX = 4.5;

/**
 * 被写体ブレの必要 SS（秒）。仕様 §7.2。ss=null は制約なし。
 * @type {ReadonlyArray<{key:string,label:string,ss:number|null}>}
 */
export const SUBJECTS = Object.freeze([
  { key: 'static',   label: '静物・風景',       ss: null },
  { key: 'portrait', label: '人物（軽い動き）', ss: 1 / 125 },
  { key: 'walking',  label: '歩く人・子ども',   ss: 1 / 250 },
  { key: 'running',  label: '走る人・ペット',   ss: 1 / 500 },
  { key: 'sports',   label: 'スポーツ・自転車', ss: 1 / 1000 },
  { key: 'vehicle',  label: '車・電車・飛ぶ鳥', ss: 1 / 2000 },
]);

/**
 * モディファイア減光段数（目安・校正対象）。仕様 §7.5。
 * グリッド/ディフューザーは加算で表現する前提の基本値。
 * @type {ReadonlyArray<{key:string,label:string,loss:number}>}
 */
export const MODIFIERS = Object.freeze([
  { key: 'reflector', label: '標準リフレクター',            loss: 0 },
  { key: 'akr1Dome',  label: 'AK-R1 ドームディフューザー',  loss: 1.5 },
  { key: 'octa30',    label: 'オクタ 30cm',                 loss: 1.5 },
  { key: 'octa60',    label: 'オクタ 60cm',                 loss: 2.0 },
  { key: 'octa90',    label: 'オクタ 90cm',                 loss: 2.5 },
]);

/** グリッド/ディフューザーの追加減光（モディファイアに加算）。仕様 §7.5。 */
export const MODIFIER_ADDONS = Object.freeze({ grid: 1.5, diffuser: 0.5 });

/**
 * ブラックミストの減光段数（既定）。公称は露出倍数ほぼ1倍なので 0段。
 * ND とは性質が異なるため solveND の探索対象には入れない（組み合わせが無意味に増えるだけ）。
 * ただしレンズ前のガラス1枚なので**枚数には数える**（ケラレ・周辺光量落ちのリスクは同じ）。
 * 実測で微小な減光がある場合に備え、設定で 0〜0.33段 の範囲で調整できる。
 */
export const BLACK_MIST_STOPS = 0;
export const BLACK_MIST_STOPS_MAX = 1 / 3;

/**
 * 発光量ステップと閃光時間の目安。仕様 §7.4 / §7.6。
 * stops = フル発光からの段数(0..7)。duration = t0.1 の目安(秒)。
 * @type {ReadonlyArray<{stops:number,label:string,duration:number}>}
 */
export const POWER_STEPS = Object.freeze([
  { stops: 0, label: '1/1',   duration: 1 / 250 },
  { stops: 1, label: '1/2',   duration: 1 / 400 },
  { stops: 2, label: '1/4',   duration: 1 / 700 },
  { stops: 3, label: '1/8',   duration: 1 / 1200 },
  { stops: 4, label: '1/16',  duration: 1 / 2000 },
  { stops: 5, label: '1/32',  duration: 1 / 3500 },
  { stops: 6, label: '1/64',  duration: 1 / 5000 },
  { stops: 7, label: '1/128', duration: 1 / 9000 },
]);

/**
 * 警告 → マニュアルのセクション（helpId）。manual.md §0.5 の対応表と1対1で対応する。
 * 警告オブジェクトは必ずこの中の値を1つ持つ（`ui.js` が `?` ボタンの遷移先に使う）。
 * ここを増やしたら manual.md §0.5 の表と本文アンカーも増やすこと（tools/check-help-anchors が検査）。
 * @type {Readonly<Record<string,string>>}
 */
export const HELP = Object.freeze({
  shake: 'help-warn-shake',
  motion: 'help-warn-motion',
  lightShort: 'help-warn-light-short',
  nd: 'help-nd',
  diffraction: 'help-warn-diffraction',
  highIso: 'help-warn-high-iso',
  tripod: 'help-warn-tripod',
  syncWall: 'help-sync-wall',
  flashDuration: 'help-flash-duration',
  slowSync: 'help-slow-sync',
  recycle: 'help-warn-recycle',
  flashStrong: 'help-warn-flash-strong',
  flashShort: 'help-warn-flash-short',
  powerMode: 'help-power-mode',
  powerCeiling: 'help-power-ceiling',
  calcClamp: 'help-calc-clamp',
  blowout: 'help-blowout',
  ok: 'help-warnings',
});

/**
 * 警告以外の UI 要素から開くマニュアルのセクション。
 *
 * **`HELP` と分けている理由：** テスト #33 は「`HELP` の全値がいずれかの警告から発生する」ことを
 * 検証する。警告ではない導線（バッジなど）を `HELP` に足すと #33 が永久に赤くなる。
 * ただし ID 文字列を実装に直書きしないという規則は同じなので、置き場所だけ分ける。
 * @type {Readonly<Record<string,string>>}
 */
export const HELP_LINKS = Object.freeze({
  calibration: 'help-calibration',
  // 「写真から測る」の注記（EXIF なし・ナイトモード・露出補正・別レンズ・HEIC）の行き先。
  // これらは compute の警告ではなく測定 UI 側の注記なので `HELP` には置かない
  lightmeter: 'help-lightmeter',
});

/** APEX の基準 ISO。EV 換算の分母。 */
export const ISO_REF = 100;

/** ISO の 2 段構え下限（仕様確定事項）。 */
export const BASE_ISO_DEFAULT = 200;        // 常用下限（意図別ロジックの ISO 固定起点）
export const EXPANDED_ISO_MIN_DEFAULT = 50; // 拡張下限（代替案でのみ使用、画質低下の可能性）

/** 機材係数 k の既定・範囲（仕様 §5.2 / §10）。 */
export const K_DEFAULT = 4.0;
export const K_MIN = 2.0;
export const K_MAX = 6.0;

/** HSS 基準損失の既定・範囲（仕様 §5.4 / §10）。 */
export const HSS_BASE_LOSS_DEFAULT = 2.0;
export const HSS_BASE_LOSS_MIN = 1.0;
export const HSS_BASE_LOSS_MAX = 2.5;
