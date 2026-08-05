// ui.js — DOM 描画とイベントのみ。計算は書かない（compute() の結果を描画するだけ）。
// 単一 state ＋ 一方向レンダリング（UI仕様 §9 / CLAUDE.md）：
//   state ─▶ compute(state) ─▶ derived ─▶ render() ─▶ DOM
//     ▲                                              │
//     └──────────── setState(patch) ◀── イベント ◀───┘
// 規則：DOM を状態の保管場所にしない（element.value を判断に使わない。必ず state を見る）。
//       再描画経路は setState の一本だけ。他に作らない。
//
// 8c-1 の範囲：配線骨格＋タブ1（かんたん）。タブ2/3・校正は 8c-2。

import { compute } from './compute.js';
import { formatStops } from './advisor.js';
import {
  SCENES, SUBJECTS, MODIFIERS, POWER_STEPS,
  K_MIN, K_MAX, HSS_BASE_LOSS_MIN, HSS_BASE_LOSS_MAX, BLACK_MIST_STOPS_MAX,
} from './scenes.js';
import { F, SS, ISO } from './stops.js';
import { calibrate } from './flash.js';
import { makeWheel } from './wheel.js';
import { defaultState, clone, mergeDeep, migrate, clampPanelSize, PANEL_SIZES } from './state.js';
import * as storage from './storage.js';

/* ---- 選択肢（UI仕様 §3）---------------------------------------------- */
const INTENTS = [
  { key: 'blur', label: '背景をぼかす' },
  { key: 'freeze', label: '動きを止める' },
  { key: 'landscape', label: '風景をくっきり' },
  { key: 'nightHandheld', label: '夜・手持ち' },
  { key: 'daylightSync', label: '日中シンクロ' },
  { key: 'slowSync', label: 'スローシンクロ' },
];
const FOCALS = [24, 35, 50, 85, 135, 200];
const DISTANCES = [1, 1.5, 2, 3, 5, 8];
const AMBIENTS = [-3, -2, -1, 0, 1];


/* ---- モジュールスコープの単一状態 ------------------------------------ */
let state = null;
let derived = null;
const el = {}; // 要素参照キャッシュ（index.html の固定要素）
const wheels = { ruler: {}, calc: {} }; // 共有ホイールのコントローラ
let rulerScaleTrack = null, rulerClipL = null, rulerClipR = null;
let manualShownId = null; // いま表示しているマニュアルのセクション（再スクロールの判定用）
let calcNdSuffix = null, calcNdSig = null;

/* ====================================================================== */
/*  初期化                                                                 */
/* ====================================================================== */

/**
 * アプリ起動。保存状態を復元し、DOM を組み立てて初回描画する。
 * @param {object|null} loaded storage.load() の結果
 */
export function init(loaded) {
  // 旧スキーマの保存データを移送してから既定値とマージする（MAINTENANCE.md §9）
  const { state: migrated, notice } = migrate(loaded);
  state = mergeDeep(clone(defaultState), migrated || {});
  cacheElements();
  buildStaticDom();
  wireEvents();
  if (notice) setTimeout(() => toast(notice), 0); // 移行は一度だけ通知する
  // 初回描画も setState 経由に一本化。ただし保存はしない：
  // load 失敗で既定値へフォールバックした直後に保存すると校正値を復旧不能に上書きするため。
  setState({}, { persist: false });
}

/** よく使う要素をキャッシュ。 */
function cacheElements() {
  const ids = [
    'scroll-body', 'ev-value', 'theme-toggle',
    'scene-tiles', 'scene-adjust', 'scene-adjust-val', 'focal-chips', 'intent-chips',
    'subject-field', 'subject-chips', 'flash-panel', 'flash-profile', 'uncalibrated-badge',
    'flash-modifier', 'distance-chips', 'ambient-chips', 'tripod-field', 'tripod-toggle',
    'curtain-field', 'curtain-toggle', 'result-panel', 'wall-readout', 'wall-num',
    'result-badges', 'ev-ruler', 'result-systems', 'path-compare', 'warnings', 'toast',
    'result-announce',
    'calc-ev', 'calc-ev-err', 'calc-nd-chips', 'calc-tracks', 'equiv-list', 'settings-root',
    'power-chips', 'power-hint', 'panel-handle', 'result-summary',
    'manual', 'manual-open', 'manual-close', 'manual-index', 'manual-body', 'manual-tray-toggle',
  ];
  ids.forEach((id) => { el[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id); });
  el.tabButtons = Array.from(document.querySelectorAll('.tab'));
  el.panels = { easy: document.getElementById('tab-easy'), calc: document.getElementById('tab-calc'), settings: document.getElementById('tab-settings') };
  el.focalOther = null; // 動的生成
  el.distanceOther = null;
}

/* ====================================================================== */
/*  一方向フローの中心：setState → compute → render → 永続化              */
/* ====================================================================== */

/**
 * 状態を浅くマージして再計算・再描画・保存する。唯一の再描画経路。
 * @param {object} patch 差分（ネストは2階層までマージ）
 */
export function setState(patch, { persist = true } = {}) {
  state = mergeDeep(state, patch);
  derived = compute(state);
  render();
  // 保存できない環境（プライベートブラウズ等）では黙って落とさず1度だけ知らせる。
  // 計算機能は保存に依存しないので続行する（UI仕様 §12 の文言）。
  if (persist && !storage.save(state)) warnStorageOnce();
}

/**
 * `[data-help]` を押されたらそのセクションを開く。警告の ? とバッジで共有する唯一の実装。
 * @param {Event} e クリックイベント
 * @returns {boolean} 開いたか（呼び出し側が「他の処理へ進むか」を判断できるように返す）
 */
function openHelpFrom(e) {
  const b = e.target.closest('[data-help]');
  if (!b) return false;
  setState({ ui: { manual: b.dataset.help } });
  return true;
}

/** localStorage に書けないことを1セッション1回だけ通知する。連打で鳴り続けさせない。 */
let storageWarned = false;
function warnStorageOnce() {
  if (storageWarned) return;
  storageWarned = true;
  toast('設定を保存できません。プライベートブラウズを解除すると保存されます。計算はこのまま使えます');
}

/** 段数を「+0.3段／0.0段／−1.7段」の人間可読形へ（aria-valuetext・微調整ラベル用）。 */
function fmtAdjust(v) {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  const mag = formatStops(v);
  return `${sign}${mag.includes('.') ? mag : `${mag}.0`}段`;
}

/* ====================================================================== */
/*  静的 DOM の組み立て（一度だけ）                                        */
/* ====================================================================== */

function buildStaticDom() {
  // シーンタイル
  el.sceneTiles.append(...SCENES.map((s) => tileEl(s.key, s.label, s.ev)));
  // 焦点距離チップ（プリセット＋その他）
  el.focalChips.append(...FOCALS.map((f) => chipEl(String(f), `${f}`)), otherChip('focal'));
  el.focalOther = otherInput('focal', '8〜1200mm');
  el.focalChips.parentElement.append(el.focalOther);
  // 意図チップ
  el.intentChips.append(...INTENTS.map((i) => chipEl(i.key, i.label)));
  // 被写体チップ
  el.subjectChips.append(...SUBJECTS.map((s) => chipEl(s.key, s.label)));
  // ストロボ：プロファイル／モディファイア セレクト
  el.flashProfile.append(...state.profiles.map((p) => optionEl(p.id, p.name)));
  el.flashModifier.append(...MODIFIERS.map((m) => optionEl(m.key, m.label)));
  // 距離チップ（プリセット＋その他）
  el.distanceChips.append(...DISTANCES.map((d) => chipEl(String(d), `${d}`)), otherChip('distance'));
  el.distanceOther = otherInput('distance', '0.3〜50m');
  el.distanceChips.parentElement.append(el.distanceOther);
  // アンビエント目標段数チップ
  el.ambientChips.append(...AMBIENTS.map((a) => chipEl(String(a), a > 0 ? `+${a}` : `${a}`)));
  // 発光量チップ（おまかせ＝auto。選択肢はプロファイルの最小発光量で絞る）
  buildPowerChips();
  // EV ルーラー（永続DOM）・計算タブ・設定タブ
  buildRuler();
  buildCalcNd();
  buildCalcTracks();
  buildSettings();
}

/**
 * 発光量チップの選択肢：おまかせ＋ 1/4〜1/128（プロファイルの最小発光量まで）。
 * 1/2（1/400）と 1/1（1/250）はチップに出さない。閃光時間が被写体ブレの領域に入るため、
 * それらは「おまかせ」経由でのみ到達させる（マニュアル §10・閃光時間の表は §9）。
 */
const POWER_CHOICES = [2, 3, 4, 5, 6, 7]; // 1/4, 1/8, 1/16, 1/32, 1/64, 1/128
let powerChipSig = null;

function buildPowerChips() {
  el.powerChips.addEventListener('click', (e) => {
    const c = e.target.closest('[data-key]'); if (!c) return;
    const key = c.dataset.key;
    if (key === 'auto') setState({ flash: { powerMode: 'auto' } });
    else setState({ flash: { powerMode: 'fixed', powerStops: Number(key) } });
  });
}

/** プロファイル変更で選択肢が変わるので、必要になったら組み直す。 */
function rebuildPowerChipsIfNeeded() {
  const prof = state.profiles.find((p) => p.id === state.flash.profileId) || state.profiles[0];
  const sig = `${prof.minPowerStops}`;
  if (sig === powerChipSig) return;
  powerChipSig = sig;
  el.powerChips.innerHTML = '';
  el.powerChips.append(chipEl('auto', 'おまかせ'));
  POWER_CHOICES.filter((s) => s <= prof.minPowerStops)
    .forEach((s) => el.powerChips.append(chipEl(String(s), POWER_STEPS[s].label)));
}

/* ---- 要素ファクトリ --------------------------------------------------- */

function tileEl(key, name, ev) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'tile'; b.setAttribute('role', 'radio');
  b.dataset.key = key; b.setAttribute('aria-checked', 'false');
  b.innerHTML = `<span class="tile-ev tabular">${ev}</span><span class="tile-name">${name}</span>`;
  return b;
}
function chipEl(key, label) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chip'; b.setAttribute('role', 'radio');
  b.dataset.key = key; b.setAttribute('aria-checked', 'false'); b.textContent = label;
  return b;
}
function otherChip(kind) {
  const b = chipEl('__other__', 'その他'); b.dataset.other = kind; return b;
}
function otherInput(kind, ph) {
  const wrap = document.createElement('div');
  wrap.className = 'field'; wrap.hidden = true; wrap.dataset.otherInput = kind;
  wrap.style.marginTop = '8px';
  const input = document.createElement('input');
  input.className = 'input'; input.type = 'text'; input.inputMode = 'decimal';
  input.setAttribute('autocomplete', 'off'); input.placeholder = ph;
  input.setAttribute('aria-label', kind === 'focal' ? '焦点距離(mm)' : 'ストロボ→被写体の距離(m)');
  wrap.append(input);
  return wrap;
}
function optionEl(value, label) {
  const o = document.createElement('option'); o.value = value; o.textContent = label; return o;
}

/* ====================================================================== */
/*  イベント配線（すべて setState を呼ぶ。DOM を判断に使わない）           */
/* ====================================================================== */

function wireEvents() {
  // タブ切替（クリック＋矢印キー）
  el.tabButtons.forEach((btn) => btn.addEventListener('click', () => setState({ ui: { tab: btn.dataset.tab } })));
  document.querySelector('.tabs').addEventListener('keydown', onTablistKey);

  // テーマ切替（自動→ライト→ダーク→自動）
  el.themeToggle.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(state.ui.theme) + 1) % 3];
    setState({ ui: { theme: next } });
  });

  // ラジオグループ（タイル／チップ）
  radioGroup(el.sceneTiles, (key) => setState({ scene: sceneFrom(key) }));
  radioGroup(el.focalChips, onFocalPick);
  radioGroup(el.intentChips, (key) => setState({ intent: key }));
  radioGroup(el.subjectChips, (key) => setState({ subject: key }));
  radioGroup(el.distanceChips, onDistancePick);
  radioGroup(el.ambientChips, (key) => setState({ flash: { ambientOffset: Number(key) } }));

  // 微調整スライダー（入力値を捕捉→即 setState。値の単位は 1/3段なので段へ変換する。
  // これは単位変換であって判断ではない。1/3段スナップは step="1" が構造的に担保する）
  el.sceneAdjust.addEventListener('input', (e) => setState({ scene: { adjust: e.target.valueAsNumber / 3 } }));

  // ストロボ セレクト
  el.flashProfile.addEventListener('change', (e) => setState({ flash: { profileId: e.target.value } }));
  el.flashModifier.addEventListener('change', (e) => setState({ flash: { modifier: e.target.value } }));

  // トグル
  el.tripodToggle.addEventListener('click', () => setState({ flash: { tripod: !state.flash.tripod } }));
  el.curtainToggle.addEventListener('click', () => setState({ flash: { curtain: !state.flash.curtain } }));

  // その他 数値入力（blur で検証・クランプ。空・非数値は直前値へ）
  el.focalOther.querySelector('input').addEventListener('blur', (e) => commitOther('focal', e.target));
  el.distanceOther.querySelector('input').addEventListener('blur', (e) => commitOther('distance', e.target));

  wirePanelHandle();

  // 拡張ISO トグル（かんたん・計算の両方。同じ state を見るので双方向に連動する）
  document.querySelectorAll('.exp-iso-toggle').forEach((btn) => {
    btn.addEventListener('click', () => setState({ camera: { allowExpandedIso: !state.camera.allowExpandedIso } }));
  });

  wireManual();
}

/* ---- 結果パネルの高さ（3段階）--------------------------------------- */

/** 段階を1つ動かすのに必要なスワイプ量。連続追従はせず、超えた時点で隣へ吸着する。 */
const PANEL_SWIPE_PX = 40;

/** 画面の高さを与えてクランプ（規則そのものは state.js の純粋関数）。 */
function panelSizeNow(size = state.ui.panelSize) {
  return clampPanelSize(size, window.innerHeight);
}

/** ハンドルの操作を配線する。パネル内部では反応させない（一覧のスクロールと衝突するため）。 */
function wirePanelHandle() {
  const step = (dir) => {
    const cur = PANEL_SIZES.indexOf(panelSizeNow());
    const next = PANEL_SIZES[clamp(cur + dir, 0, PANEL_SIZES.length - 1)];
    setState({ ui: { panelSize: panelSizeNow(next) } });
  };
  let startY = null, moved = false;
  el.panelHandle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY; moved = false;
  }, { passive: true });
  el.panelHandle.addEventListener('touchmove', (e) => {
    if (startY == null || moved) return;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dy) < PANEL_SWIPE_PX) return;
    moved = true;              // 1回のスワイプで1段階だけ動かす
    step(dy < 0 ? 1 : -1);     // 上（dy<0）で大きく、下で小さく
  }, { passive: true });
  // touchend と touchcancel の両方で状態を捨てる（MAINTENANCE.md §4「タッチのジェスチャ境界」）。
  // cancel を落とすと moved が true のまま残り、次のタップが「スワイプ直後」と誤判定されて
  // 無視される。値は確定しない——キャンセルは中断なので、段階は動かさない。
  const dropPanelSwipe = () => { startY = null; moved = false; };
  el.panelHandle.addEventListener('touchend', () => { startY = null; }, { passive: true });
  el.panelHandle.addEventListener('touchcancel', dropPanelSwipe, { passive: true });
  // タップは標準へ戻す。スワイプで動かした直後は反応させない
  el.panelHandle.addEventListener('click', () => {
    if (moved) { moved = false; return; }
    setState({ ui: { panelSize: 'normal' } });
  });
  // キーボード操作（上下キーで段階を動かす）
  el.panelHandle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
  });
  // 画面の回転などで expanded が選べなくなったら normal へ落とす
  window.addEventListener('resize', () => {
    const fixed = panelSizeNow();
    if (fixed !== state.ui.panelSize) setState({ ui: { panelSize: fixed } });
  });
}

/* ---- マニュアル（全画面シート。manual.md §0.3）----------------------- */

/** シートを開く前のフォーカス元。閉じたときここへ戻す。 */
let manualReturnFocus = null;

/* スワイプの判定閾値（実機で調整する）。横と縦を取り違えないよう軸比で判別する。 */
const SWIPE_AXIS_RATIO = 1.5; // |dx| がこの倍率を超えて |dy| より大きければ横
const SWIPE_MIN_PX = 40;      // 横スワイプと認める最小移動量
const SWIPE_CLOSE_PX = 80;    // 下スワイプでシートを閉じる最小移動量

function wireManual() {
  // アンカー指定で開くときはトレイを閉じた状態にする（§0.4）
  el.manualOpen.addEventListener('click', () => setState({ ui: { manual: 'help-intro', manualTray: false } }));
  el.manualClose.addEventListener('click', () => setState({ ui: { manual: null, manualTray: false } }));
  // 目次トレイの開閉（同じアイコンで展開・格納）
  el.manualTrayToggle.addEventListener('click', () => setState({ ui: { manualTray: !state.ui.manualTray } }));
  // 警告の ? → 該当セクションを開く（イベント委譲。再描画で作り直されるため）
  el.warnings.addEventListener('click', (e) => {
    if (openHelpFrom(e)) return;
    // 警告内の解決ボタン（いまは発光量の上限を上げる1種類）。再描画で作り直されるので委譲。
    const a = e.target.closest('[data-action="raiseCeiling"]');
    if (a) raiseCeiling(Number(a.dataset.to));
  });
  // バッジ（推定値／未校正）も同じ委譲で校正のしかたへ飛ばす。
  // 結果パネルのバッジは再描画で作り直されるので委譲、ストロボパネルのバッジは静的だが同じ経路に乗せる。
  el.resultBadges.addEventListener('click', openHelpFrom);
  el.uncalibratedBadge.addEventListener('click', openHelpFrom);
  // 目次はページ内リンク。履歴を汚さずスクロールだけする。ジャンプ後もトレイは開いたまま（§0.4）
  el.manualIndex.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    scrollManualTo(a.getAttribute('href').slice(1));
  });
  // Esc で閉じる／Tab をシート内に閉じ込める（§0.3）
  el.manual.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); setState({ ui: { manual: null } }); return; }
    if (e.key !== 'Tab') return;
    const f = el.manual.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // スワイプ：横＝トレイ開閉、下＝シートを閉じる（§0.3・§0.4）
  //
  // 開始位置を画面左端に限定しない。左端から始まるスワイプは Safari の戻るジェスチャと
  // 競合するため、シート内のどこからでも効くようにする（シート内に横スワイプで動く部品はない）。
  let touch = null;
  el.manual.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    // 開始時に必ず作り直す。前のジェスチャの残骸を継続扱いしない
    touch = { x: t.clientX, y: t.clientY, atTop: el.manualBody.scrollTop <= 0 };
  }, { passive: true });
  // キャンセルは中断。トレイ開閉もシート閉じも行わず状態だけ捨てる
  // （MAINTENANCE.md §4「タッチのジェスチャ境界」）。
  el.manual.addEventListener('touchcancel', () => { touch = null; }, { passive: true });
  el.manual.addEventListener('touchend', (e) => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    const atTop = touch.atTop;
    touch = null;
    // 軸の判別：横成分が縦の1.5倍を超え、かつ十分な距離があれば横スワイプ
    if (Math.abs(dx) > Math.abs(dy) * SWIPE_AXIS_RATIO && Math.abs(dx) > SWIPE_MIN_PX) {
      setState({ ui: { manualTray: dx > 0 } }); // 右で開く／左で閉じる
      return;
    }
    // それ以外は既存の縦スワイプ判定（本文が最上部にあるときだけ閉じる）
    if (atTop && dy > SWIPE_CLOSE_PX) setState({ ui: { manual: null, manualTray: false } });
  });
}

/** 指定セクションを最上部に表示する。reduced-motion では即時。 */
function scrollManualTo(id) {
  const target = document.getElementById(id);
  if (!target) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/** ラジオグループ共通：クリックで選択、左右キーで移動。data-key を渡す。 */
function radioGroup(container, onPick) {
  container.addEventListener('click', (e) => {
    const item = e.target.closest('[data-key]');
    if (item) onPick(item.dataset.key, item);
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const items = Array.from(container.querySelectorAll('[data-key]'));
    const cur = items.findIndex((it) => it.getAttribute('aria-checked') === 'true');
    const next = items[Math.min(items.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)))];
    if (next) { e.preventDefault(); onPick(next.dataset.key, next); next.focus(); }
  });
}

function onTablistKey(e) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const order = ['easy', 'calc', 'settings'];
  const cur = order.indexOf(state.ui.tab);
  const next = order[Math.min(order.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)))];
  e.preventDefault(); setState({ ui: { tab: next } });
  document.getElementById(`tab-btn-${next}`).focus();
}

function sceneFrom(key) {
  const s = SCENES.find((x) => x.key === key);
  return s ? { key: s.key, evBase: s.ev, adjust: state.scene.adjust } : {};
}

function onFocalPick(key) {
  if (key === '__other__') { showOther('focal', true); return; }
  showOther('focal', false);
  setState({ focal: Number(key) });
}
function onDistancePick(key) {
  if (key === '__other__') { showOther('distance', true); return; }
  showOther('distance', false);
  setState({ flash: { distance: Number(key) } });
}
function showOther(kind, show) {
  const wrap = kind === 'focal' ? el.focalOther : el.distanceOther;
  wrap.hidden = !show;
  if (show) { const i = wrap.querySelector('input'); i.value = ''; i.focus(); }
}

/** その他入力の確定：範囲外はクランプしてトースト。空・非数値は据え置き。UI仕様 §10 */
function commitOther(kind, input) {
  const raw = input.value.trim().replace(/[^\d.]/g, '');
  const n = parseFloat(raw);
  if (!raw || Number.isNaN(n)) { input.value = ''; return; } // 直前の有効値を維持（0にしない）
  if (kind === 'focal') {
    const c = clamp(n, 8, 1200);
    if (c !== n) toast(`8〜1200mm の範囲に丸めました`);
    setState({ focal: c });
  } else {
    const c = clamp(n, 0.3, 50);
    if (c !== n) toast(`0.3〜50m の範囲に丸めました`);
    setState({ flash: { distance: c } });
  }
}

/* ====================================================================== */
/*  render：state と derived だけを見る。計算しない                       */
/* ====================================================================== */

function render() {
  renderTheme();
  renderTabs();
  renderHeader();
  renderTab1();
  renderRuler();
  renderResult();
  renderCalc();
  renderSettings();
  renderManual();
}

/**
 * マニュアルシートの開閉。state.ui.manual だけを見る（再描画経路は setState 一本）。
 * アンカー指定で開いたときは目次を飛ばして該当セクションを最上部に出す（§0.4）。
 */
function renderManual() {
  const id = state.ui.manual;
  const wasOpen = !el.manual.hidden;
  const open = !!id;
  // 目次トレイ（state 駆動。閉じているときは Tab で辿れないようにする）
  const trayOpen = open && !!state.ui.manualTray;
  el.manualIndex.classList.toggle('is-open', trayOpen);
  el.manualIndex.setAttribute('aria-hidden', String(!trayOpen));
  el.manualTrayToggle.setAttribute('aria-expanded', String(trayOpen));
  el.manualTrayToggle.setAttribute('aria-label', trayOpen ? '目次を閉じる' : '目次を開く');
  el.manualIndex.querySelectorAll('a').forEach((a) => { a.tabIndex = trayOpen ? 0 : -1; });
  if (open === wasOpen) {
    if (open && id !== manualShownId) { manualShownId = id; scrollManualTo(id); }
    return;
  }
  document.body.classList.toggle('sheet-open', open);
  if (open) {
    manualReturnFocus = document.activeElement;
    el.manual.hidden = false;
    manualShownId = id;
    // 下から出す（transform のみ。reduced-motion では CSS 側で 0s になる）
    el.manual.classList.add('is-entering');
    requestAnimationFrame(() => {
      el.manual.classList.remove('is-entering');
      el.manualClose.focus();
      if (id !== 'help-intro') scrollManualTo(id);
      else el.manualBody.scrollTop = 0;
    });
  } else {
    el.manual.hidden = true;
    manualShownId = null;
    if (manualReturnFocus && document.contains(manualReturnFocus)) manualReturnFocus.focus();
    manualReturnFocus = null;
  }
}

function renderTheme() {
  const t = state.ui.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  el.themeToggle.setAttribute('aria-label', `テーマ切り替え（現在：${t === 'auto' ? '自動' : t === 'light' ? 'ライト' : 'ダーク'}）`);
}

function renderTabs() {
  el.tabButtons.forEach((btn) => {
    const on = btn.dataset.tab === state.ui.tab;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  Object.entries(el.panels).forEach(([k, panel]) => { panel.hidden = k !== state.ui.tab; });
}

function renderHeader() {
  el.evValue.textContent = derived.evScene.toFixed(1);
}

function renderTab1() {
  // ラジオ選択状態
  setChecked(el.sceneTiles, state.scene.key);
  setChecked(el.intentChips, state.intent);
  setChecked(el.subjectChips, state.subject);
  setChecked(el.focalChips, FOCALS.includes(state.focal) ? String(state.focal) : '__other__');
  setChecked(el.distanceChips, DISTANCES.includes(state.flash.distance) ? String(state.flash.distance) : '__other__');
  setChecked(el.ambientChips, String(state.flash.ambientOffset));
  // 発光量チップ（おまかせ／固定）と、fixed のときの推奨距離の目印
  rebuildPowerChipsIfNeeded();
  setChecked(el.powerChips, state.flash.powerMode === 'auto' ? 'auto' : String(state.flash.powerStops));
  renderPowerHint();

  // 微調整スライダー（state[段] → DOM[1/3段単位] の逆変換。Math.round で旧データの端数もグリッドへ戻す）
  el.sceneAdjust.value = String(Math.round(state.scene.adjust * 3));
  el.sceneAdjust.setAttribute('aria-valuetext', fmtAdjust(state.scene.adjust));
  el.sceneAdjustVal.textContent = fmtAdjust(state.scene.adjust);

  // セレクト（state を反映）
  el.flashProfile.value = state.flash.profileId;
  el.flashModifier.value = state.flash.modifier;

  // トグル
  el.tripodToggle.setAttribute('aria-checked', String(state.flash.tripod));
  el.curtainToggle.setAttribute('aria-checked', String(state.flash.curtain));
  // 拡張ISO（かんたん・計算の両方に同じ state を反映）
  document.querySelectorAll('.exp-iso-toggle').forEach((btn) => {
    btn.setAttribute('aria-checked', String(state.camera.allowExpandedIso));
  });

  // 可視/非可視
  const showSubject = state.intent === 'freeze' || state.intent === 'slowSync';
  const showSlow = state.intent === 'slowSync';
  el.subjectField.hidden = !showSubject;
  el.flashPanel.hidden = !derived.flashOn;
  el.tripodField.hidden = !showSlow;
  el.curtainField.hidden = !showSlow;
  el.uncalibratedBadge.hidden = !derived.uncalibrated;
}

/**
 * 発光量の補助表示：固定時は推奨距離を出し、距離チップの該当値に目印を付ける。
 * 数値は derived（compute の結果）を読むだけで、ここでは計算しない。
 */
function renderPowerHint() {
  const f = derived.flash;
  const fixed = state.flash.powerMode === 'fixed';
  el.powerHint.textContent = fixed && f
    ? `推奨距離 ${f.recommendedDistance.toFixed(1)}m`
    : (f ? `おまかせ：${f.powerLabel}` : '');
  // 距離チップの目印（推奨距離に最も近いプリセット）
  const near = fixed && f
    ? DISTANCES.reduce((a, b) => (Math.abs(b - f.recommendedDistance) < Math.abs(a - f.recommendedDistance) ? b : a))
    : null;
  el.distanceChips.querySelectorAll('[data-key]').forEach((c) => {
    c.classList.toggle('is-suggested', near != null && c.dataset.key === String(near));
  });
}

/** ラジオグループの aria-checked と roving tabindex を state から更新。 */
function setChecked(container, selectedKey) {
  container.querySelectorAll('[data-key]').forEach((item) => {
    const on = item.dataset.key === selectedKey;
    item.setAttribute('aria-checked', String(on));
    item.tabIndex = on ? 0 : -1;
  });
}

/* ---- 結果パネル（表示専用。innerHTML で組み直す）--------------------- */

function renderResult() {
  const d = derived;
  // 高さの段階（選べない段階は画面高でクランプする）
  const size = panelSizeNow();
  el.resultPanel.classList.remove('size-minimal', 'size-normal', 'size-expanded');
  el.resultPanel.classList.add(`size-${size}`);
  // 最小表示の1行（核心の数値。警告はアイコンだけ残す）
  const s = d.summary;
  el.resultSummary.innerHTML = `<span class="sum-values">${s.text}</span>`
    + (s.icon ? `<svg class="icon ${s.level}" aria-hidden="true"><use href="#i-${s.icon}"></use></svg>` : '');
  announceResult(d);
  // derived を描くだけ。タブは見ない（何を映すかは compute() の入口で解決済み）。
  // 同調速度の壁
  if (d.wall) { el.wallReadout.hidden = false; el.wallNum.textContent = d.wall.text; }
  else { el.wallReadout.hidden = true; }
  // バッジ
  // helpId を持つバッジは押せる（警告の ? と同じ委譲で開く）。持たないものは静的な span のまま
  el.resultBadges.innerHTML = d.badges.map((b) => (b.helpId
    ? `<button type="button" class="badge badge-est badge-link" data-help="${b.helpId}"
         aria-label="${b.text}。校正のしかたを開く">${b.text}</button>`
    : `<span class="badge badge-est">${b.text}</span>`)).join('');
  // EV ルーラーは renderRuler() が永続DOMを更新（ここでは触らない）
  // 系統（アンビエント／ストロボ）
  el.resultSystems.className = 'result-systems' + (d.flash ? ' dual' : '');
  el.resultSystems.innerHTML = systemsHtml(d);
  // 経路比較（日中シンクロ）
  if (d.paths && (d.paths.nd || d.paths.hss)) { el.pathCompare.hidden = false; el.pathCompare.innerHTML = pathHtml(d.paths); }
  else { el.pathCompare.hidden = true; el.pathCompare.innerHTML = ''; }
  // 警告
  el.warnings.innerHTML = d.warnings.map(warnHtml).join('');
}

/* ====================================================================== */
/*  EV ルーラー（永続DOM。scale は一度だけ組み、以後は transform を更新）  */
/* ====================================================================== */
const RULER_SPAN = 3, RULER_STEP = 18, RULER_COUNT = 9;

/** 系列キー → ホイール記述子。 */
function descFor(series) {
  switch (series) {
    case 'F': return { labels: F.labels, minIndex: F.minIndex, majorEvery: 3, valueText: (i) => `F${F.label(i)}` };
    case 'SS': return { labels: SS.labels, minIndex: SS.minIndex, majorEvery: 3, valueText: (i) => SS.label(i) };
    case 'ISO': return { labels: ISO.labels, minIndex: ISO.minIndex, majorEvery: 3, valueText: (i) => `ISO${ISO.label(i)}` };
    case 'POWER': return { labels: POWER_STEPS.map((p) => p.label), minIndex: 0, majorEvery: 1, valueText: (i) => `発光量 ${POWER_STEPS[i] ? POWER_STEPS[i].label : ''}` };
    default: return { labels: [], minIndex: 0, majorEvery: 1, valueText: () => '' };
  }
}

function buildRuler() {
  const scale = document.createElement('div'); scale.className = 'ev-scale';
  rulerScaleTrack = document.createElement('div'); rulerScaleTrack.className = 'ev-scale-track animate';
  for (let i = -RULER_COUNT; i <= RULER_COUNT; i++) {
    const t = document.createElement('span');
    t.className = 'ev-scale-tick' + (i % 3 === 0 ? ' major' : ''); t.style.width = `${RULER_STEP}px`;
    if (i % 3 === 0) {
      const l = document.createElement('span'); l.className = 'ev-t-label';
      l.textContent = i === 0 ? '0' : (i > 0 ? '+' : '−') + Math.abs(i / 3);
      t.appendChild(l);
    }
    rulerScaleTrack.appendChild(t);
  }
  const needle = document.createElement('div'); needle.className = 'ev-needle';
  rulerClipL = document.createElement('span'); rulerClipL.className = 'ev-needle-clip left'; rulerClipL.hidden = true;
  rulerClipR = document.createElement('span'); rulerClipR.className = 'ev-needle-clip right'; rulerClipR.hidden = true;
  scale.append(rulerScaleTrack, needle, rulerClipL, rulerClipR);
  el.evRuler.appendChild(scale);
  ['F', 'SS', 'ISO', 'POWER'].forEach((series) => {
    const row = document.createElement('div'); row.className = 'track-row'; row.hidden = true;
    const name = document.createElement('span'); name.className = 'track-name' + (series === 'POWER' ? ' is-flash' : '');
    name.textContent = series === 'POWER' ? '発光' : series;
    const w = makeWheel(descFor(series), { interactive: false });
    const cur = document.createElement('span'); cur.className = 'track-cur tabular' + (series === 'POWER' ? ' is-flash' : '');
    row.append(name, w.root, cur);
    el.evRuler.appendChild(row);
    wheels.ruler[series] = { wheel: w, row, cur };
  });
}

function updateScale(deviation) {
  const dev = clamp(deviation, -RULER_SPAN, RULER_SPAN);
  rulerScaleTrack.style.transform = `translateX(${-((dev * 3 + RULER_COUNT) * RULER_STEP + RULER_STEP / 2)}px)`;
  rulerClipL.hidden = deviation >= -RULER_SPAN; rulerClipL.textContent = `−${RULER_SPAN}.0 ↓`;
  rulerClipR.hidden = deviation <= RULER_SPAN; rulerClipR.textContent = `+${RULER_SPAN}.0 ↑`;
}

const RULER_SERIES = ['F', 'SS', 'ISO', 'POWER'];

function renderRuler() {
  // derived.ruler.tracks を唯一の真実とし、DOM を毎回それに合わせる。
  // まず全行を隠してから該当行だけ出す（前回の描画が残らないことを構造的に保証する）。
  RULER_SERIES.forEach((s) => { wheels.ruler[s].row.hidden = true; });
  const r = derived.ruler;
  if (!r) { updateScale(0); return; }
  updateScale(r.deviation);
  r.tracks.forEach((t) => {
    const slot = wheels.ruler[t.series];
    if (!slot) return;
    slot.row.hidden = false;
    slot.cur.textContent = t.cur;
    slot.wheel.setIndex(t.index, { animate: true });
  });
}

/* ====================================================================== */
/*  計算タブ（タブ2）                                                      */
/* ====================================================================== */

function buildCalcNd() {
  calcNdSuffix = document.createElement('span');
  calcNdSuffix.className = 'chip-suffix';
  el.calcNdChips.appendChild(calcNdSuffix);
  // チップ本体は所有ND設定に応じて renderCalc→rebuildCalcNdIfNeeded で組む
  el.calcNdChips.addEventListener('click', (e) => {
    const c = e.target.closest('[data-key]'); if (!c) return;
    if (c.dataset.key === 'mist') { // 光学フィルター（減光0段だが枚数に数える）
      setState({ filters: { blackMist: !state.filters.blackMist } });
      return;
    }
    const stops = Number(c.dataset.key);
    const set = new Set(state.nd);
    set.has(stops) ? set.delete(stops) : set.add(stops);
    setState({ nd: Array.from(set).sort((a, b) => a - b) });
  });
  // EV 直接入力（blur で検証・クランプ。§10）
  el.calcEv.addEventListener('blur', (e) => {
    const n = parseFloat(String(e.target.value).replace(/[^\d.\-]/g, ''));
    if (Number.isNaN(n)) { el.calcEv.value = derived.evScene.toFixed(1); return; }
    const c = clamp(n, -6, 17);
    if (c !== n) toast('EV −6〜17 の範囲に丸めました');
    setState({ scene: { key: 'custom', evBase: c, adjust: 0 } });
  });
}

function rebuildCalcNdIfNeeded() {
  const sig = state.settings.ownedND.join(',');
  if (sig === calcNdSig) return;
  calcNdSig = sig;
  el.calcNdChips.querySelectorAll('.chip-nd, .chip-sep').forEach((c) => c.remove());
  state.settings.ownedND.forEach((stops) => {
    const c = chipEl(String(stops), `ND${2 ** stops}`);
    c.classList.add('chip-nd'); c.setAttribute('role', 'checkbox'); c.removeAttribute('aria-checked');
    el.calcNdChips.insertBefore(c, calcNdSuffix);
  });
  // ND と光学フィルターの境界（見た目で区別する）
  const sep = document.createElement('span');
  sep.className = 'chip-sep'; sep.setAttribute('aria-hidden', 'true');
  el.calcNdChips.insertBefore(sep, calcNdSuffix);
  const mist = chipEl('mist', 'ブラックミスト');
  mist.classList.add('chip-nd', 'chip-optical'); mist.setAttribute('role', 'checkbox');
  el.calcNdChips.insertBefore(mist, calcNdSuffix);
}

function buildCalcTracks() {
  ['f', 'ss', 'iso'].forEach((key) => {
    const series = key.toUpperCase();
    const row = document.createElement('div'); row.className = 'track-row';
    const col1 = document.createElement('div');
    col1.style.cssText = 'display:flex;align-items:center;gap:4px';
    const lock = document.createElement('button');
    lock.type = 'button'; lock.className = 'track-lock';
    lock.setAttribute('aria-label', `${series} をロック`);
    lock.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-lock"></use></svg>';
    const name = document.createElement('span'); name.className = 'track-name'; name.textContent = series;
    col1.append(lock, name);
    const w = makeWheel(descFor(series), {
      interactive: true, onCommit: (index) => setState({ manual: { [`${key}Index`]: index } }),
    });
    const cur = document.createElement('span'); cur.className = 'track-cur tabular';
    row.append(col1, w.root, cur);
    el.calcTracks.appendChild(row);
    lock.addEventListener('click', () => toggleLock(key));
    wheels.calc[key] = { wheel: w, lock, cur };
  });
}

/** ロックのトグル：常に「2ロック＋1自動算出」を保つ。 */
function toggleLock(x) {
  const L = { ...state.manual.locks };
  const computed = ['f', 'ss', 'iso'].find((k) => !L[k]) || 'ss';
  if (L[x]) { L[x] = false; L[computed] = true; }              // x を自動算出に
  else { L[x] = true; const free = ['f', 'ss', 'iso'].find((k) => k !== x && L[k]); if (free) L[free] = false; }
  setState({ manual: { locks: L } });
}

function renderCalc() {
  if (state.ui.tab !== 'calc') return; // 非表示タブは更新省略
  if (document.activeElement !== el.calcEv) el.calcEv.value = derived.evScene.toFixed(1);
  rebuildCalcNdIfNeeded();
  el.calcNdChips.querySelectorAll('[data-key]').forEach((c) => {
    const on = c.dataset.key === 'mist'
      ? state.filters.blackMist
      : state.nd.includes(Number(c.dataset.key));
    c.setAttribute('aria-checked', String(on));
  });
  // 合計段数は derived（compute の結果）を読む。ブラックミストは既定0段なので影響しない
  const f = derived.filters;
  calcNdSuffix.textContent = f.count
    ? `${f.label}／合計 ${formatStops(f.ndStops)}段`
    : '装着なし';
  const m = derived.manual; if (!m) return;
  ['f', 'ss', 'iso'].forEach((key) => {
    const locked = key !== m.computedKey;
    const slot = wheels.calc[key];
    slot.wheel.setInteractive(locked);
    slot.wheel.setIndex(m[key].index, { animate: true });
    slot.lock.setAttribute('aria-pressed', String(locked));
    slot.lock.querySelector('use').setAttribute('href', locked ? '#i-lock' : '#i-unlock');
    slot.cur.textContent = key === 'f' ? `F${m[key].label}` : key === 'iso' ? `ISO${m[key].label}` : m[key].label;
  });
  el.equivList.innerHTML = equivHtml(derived.equiv);
}

function equivHtml(rows) {
  // **この分岐は現在到達しない。** compute.equivalentList は EQUIV_F_INDEXES の3行を必ず返し、
  // 成立しない行は消さずに disabled + 理由付きで残す（位置が安定するほうが現場で読める）。
  // 意図的に残す理由：UI仕様 §12 が定める文言であり、一覧を可変にしたら即座に必要になる。
  if (!rows || !rows.length) {
    return '<div class="equiv-empty">この条件で成立する組み合わせがありません。ISO上限を上げるか、F値の範囲を広げてください</div>';
  }
  return rows.map((r) => `<div class="equiv-row${r.isMain ? ' is-main' : ''}${r.disabled ? ' is-disabled' : ''}">
    <span>F${r.fLabel}</span><span>${r.ssLabel}</span><span>ISO${r.isoLabel}</span>
    <!-- 回折アイコン：現在の一覧3値（F2.8/F5.6/F11）では到達しない（F13 以上で発火）。
         一覧値が可変になった場合に機能するため実装を保持する。仕様 §10.2 参照 -->
    <span class="equiv-flags">${r.flags.map((f) => `<svg class="icon" aria-hidden="true"><use href="#i-${f}"></use></svg>`).join('')}</span>
    ${r.disabled ? `<span class="equiv-reason">${r.reason}</span>` : ''}
  </div>`).join('');
}

/* ====================================================================== */
/*  設定タブ（タブ3）＋ 校正                                               */
/* ====================================================================== */

// フラットな数値項目（path・種別・範囲）。recip は「1/x秒」を x で入出力。
const FLAT_SETTINGS = [
  { group: 0, path: 'lens.fMin', label: 'レンズ開放F値', kind: 'num', min: 1, max: 32 },
  { group: 0, path: 'lens.fMax', label: 'レンズ最小F値', kind: 'num', min: 4, max: 64 },
  { group: 0, path: 'camera.isoMin', label: 'ベースISO（下限）', kind: 'int', min: 25, max: 800 },
  { group: 0, path: 'camera.expandedISOMin', label: '拡張ISO下限', kind: 'int', min: 25, max: 400 },
  { group: 0, path: 'camera.isoMax', label: '実用ISO上限', kind: 'int', min: 400, max: 102400 },
  { group: 0, path: 'camera.isStops', label: '手ブレ補正(段)', kind: 'num', min: 0, max: 8 },
  { group: 0, path: 'focal', label: '常用焦点距離(mm)', kind: 'int', min: 8, max: 1200 },
  { group: 0, path: 'settings.comp', label: '露出補正(段)', kind: 'num', min: -5, max: 5 },
  { group: 0, path: 'camera.maxSS', label: 'SS上限 (1/x秒)', kind: 'recip', min: 60, max: 16000 },
  { group: 0, path: 'camera.syncSpeed', label: '同調速度 (1/x秒)', kind: 'recip', min: 30, max: 500 },
  { group: 2, path: 'settings.hssBaseLoss', label: 'HSS基準損失(段)', kind: 'num', min: HSS_BASE_LOSS_MIN, max: HSS_BASE_LOSS_MAX },
  { group: 2, path: 'settings.ambientOffsetDefault', label: '既定アンビエント段数', kind: 'num', min: -3, max: 1 },
  // ブラックミストは公称ほぼ減光なし。実測で微小な減光がある場合に備えて調整可
  { group: 2, path: 'settings.blackMistStops', label: 'ブラックミスト減光(段)', kind: 'num', min: 0, max: BLACK_MIST_STOPS_MAX },
];
const OWNED_ND_ALL = [1, 2, 3, 4];

function getByPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function patchByPath(path, value) {
  const keys = path.split('.'); const patch = {}; let cur = patch;
  keys.forEach((k, i) => { if (i === keys.length - 1) cur[k] = value; else { cur[k] = {}; cur = cur[k]; } });
  return patch;
}

function buildSettings() {
  const root = el.settingsRoot;
  const g0 = settingsGroup('カメラ・レンズ');
  FLAT_SETTINGS.filter((f) => f.group === 0).forEach((f) => g0.appendChild(settingRow(f)));
  const g1 = settingsGroup('ストロボプロファイル');
  state.profiles.forEach((p, i) => g1.appendChild(profileCard(p, i)));
  const g2 = settingsGroup('その他');
  FLAT_SETTINGS.filter((f) => f.group === 2).forEach((f) => g2.appendChild(settingRow(f)));
  g2.appendChild(ownedNdRow());
  g2.appendChild(blackMistRow());
  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'btn btn-ghost btn-block'; reset.textContent = '初期値に戻す';
  reset.style.marginTop = '8px';
  reset.addEventListener('click', () => { if (confirm('すべての設定を初期値に戻しますか？')) setState(clone(defaultState)); });
  g2.appendChild(reset);
  root.append(g0, g1, g2);

  // 数値項目の確定（change/blur）：捕捉→検証・クランプ→setState（§10）
  root.addEventListener('change', onSettingChange);
}

function settingsGroup(title) {
  const g = document.createElement('div'); g.className = 'settings-group';
  const h = document.createElement('h3'); h.textContent = title; g.appendChild(h);
  return g;
}

function settingRow(spec) {
  const row = document.createElement('div'); row.className = 'set-row';
  const label = document.createElement('label'); label.textContent = spec.label;
  const id = `set-${spec.path.replace(/\./g, '-')}`; label.setAttribute('for', id);
  const input = document.createElement('input');
  input.className = 'input'; input.id = id; input.type = 'text'; input.inputMode = 'decimal';
  input.setAttribute('autocomplete', 'off'); input.dataset.path = spec.path; input.dataset.kind = spec.kind;
  input.dataset.min = String(spec.min); input.dataset.max = String(spec.max);
  row.append(label, input);
  return row;
}

function onSettingChange(e) {
  const t = e.target;
  if (!t.dataset || !t.dataset.path) return;
  const { path, kind } = t.dataset;
  const min = Number(t.dataset.min), max = Number(t.dataset.max);
  const raw = parseFloat(String(t.value).replace(/[^\d.\-]/g, ''));
  if (Number.isNaN(raw)) { renderSettings(); return; } // 無効は据え置き（直前値へ戻す）
  let x = raw, value;
  if (kind === 'recip') { x = clamp(Math.round(raw), min, max); value = 1 / x; }
  else { x = clamp(kind === 'int' ? Math.round(raw) : raw, min, max); value = x; }
  if (x !== raw) toast(`${min}〜${max} の範囲に丸めました`);
  setState(patchByPath(path, value));
}

/**
 * 発光量のドロップダウン（1/1 〜 1/128）。値は段数（1/1=0 … 1/128=7）。
 * 「1/x の x」をテキストで入れさせると単位が伝わらず、段数の向き（小さいほど強い）も誤解される。
 * @param {string} field data-pfield 名
 * @param {number} stops 現在値（段）
 * @returns {string} HTML
 */
function powerSelectHtml(field, stops, attr = 'data-pfield') {
  const opts = POWER_STEPS.map((s) =>
    `<option value="${s.stops}"${s.stops === stops ? ' selected' : ''}>${s.label}</option>`).join('');
  return `<select class="select" ${attr}="${field}">${opts}</select>`;
}

function profileCard(p, i) {
  const card = document.createElement('div'); card.className = 'profile-card'; card.dataset.pidx = String(i);
  card.innerHTML = `
    <div class="set-row"><label>名称</label><input class="input" data-pfield="name" type="text" value="${p.name}"></div>
    <div class="set-row"><label>出力(Ws)</label><input class="input" data-pfield="ws" type="text" inputmode="decimal" value="${p.ws}"></div>
    <div class="set-row"><label>機材係数 k</label><input class="input" data-pfield="k" type="text" inputmode="decimal" value="${p.k}"></div>
    <div class="set-row"><label>いちばん弱い発光量<br><span class="caption">このストロボが出せる下限</span></label>
      ${powerSelectHtml('minPower', p.minPowerStops)}</div>
    <div class="set-row"><label>おまかせの上限<br><span class="caption">これより強い発光量を自動で選びません</span></label>
      ${powerSelectHtml('powerCeiling', p.powerCeilingStops ?? 0)}</div>
    <div class="toggle-field"><span class="field-label">HSS 対応</span>
      <button type="button" class="toggle" data-pfield="hss" role="switch" aria-checked="${p.hss}" aria-label="HSS対応"><span class="toggle-knob"></span></button></div>`;
  // 校正フォームは常時展開する。押すまで出ないボタンでは発見されない（アプリの精度を決める中核機能）。
  card.appendChild(calibrationForm(i));
  // プロファイル各項目の変更配線
  card.addEventListener('change', (e) => onProfileChange(e, i));
  card.querySelector('[data-pfield="hss"]').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-checked') !== 'true';
    updateProfile(i, { hss: on });
  });
  return card;
}

function onProfileChange(e, i) {
  const t = e.target; const f = t.dataset ? t.dataset.pfield : null;
  if (!f || f === 'hss') return;
  if (f === 'name') { updateProfile(i, { name: String(t.value).slice(0, 12) || `プロファイル${i + 1}` }); return; }
  const raw = parseFloat(String(t.value).replace(/[^\d.]/g, ''));
  if (Number.isNaN(raw)) { renderSettings(); return; }
  if (f === 'ws') updateProfile(i, { ws: clamp(Math.round(raw), 10, 2000) });
  else if (f === 'k') updateProfile(i, { k: clamp(raw, K_MIN, K_MAX) });
  // 発光量はドロップダウン（値は段数そのもの）。上限が下限より弱い組み合わせは成立しないので揃える
  else if (f === 'minPower') {
    const minPowerStops = clamp(Math.round(raw), 0, 7);
    const ceiling = Math.min(state.profiles[i].powerCeilingStops ?? 0, minPowerStops);
    updateProfile(i, { minPowerStops, powerCeilingStops: ceiling });
  } else if (f === 'powerCeiling') {
    updateProfile(i, { powerCeilingStops: clamp(Math.round(raw), 0, state.profiles[i].minPowerStops) });
  }
}

/** プロファイル配列の1件を更新（配列は置換）。 */
function updateProfile(i, patch) {
  const profiles = state.profiles.map((p, idx) => (idx === i ? { ...p, ...patch } : p));
  setState({ profiles });
}

/**
 * 使用中プロファイルの発光量の上限（強い側）を上げる。警告内のボタンから呼ぶ。
 * **上限は機材の限界ではなくユーザーの好み**なので、設定タブへ行かずここで変えられるようにする。
 * @param {number} to 新しい powerCeilingStops（0=1/1 が最強）
 */
function raiseCeiling(to) {
  const i = state.profiles.findIndex((p) => p.id === state.flash.profileId);
  if (i < 0 || !Number.isFinite(to)) return;
  const next = clamp(Math.round(to), 0, state.profiles[i].minPowerStops ?? 7);
  updateProfile(i, { powerCeilingStops: next });
  toast(`発光量の上限を ${POWER_STEPS[next].label} にしました`);
}

/**
 * テスト撮影で校正するフォーム（マニュアル §12 の手順）。常時表示。
 * **発光量は 1/1 から 1/128 まで全部選べる。** 校正は「テスト撮影で実際に使った発光量」を
 * 入れるものなので、撮影用チップの制限（閃光時間の理由で 1/1・1/2 を出さない）を適用しない。
 * @param {number} i プロファイルの添字
 * @returns {HTMLElement}
 */
function calibrationForm(i) {
  const form = document.createElement('div');
  form.className = 'calib-form';
  form.innerHTML = `
    <div class="calib-title">テスト撮影で校正</div>
    <p class="caption">標準リフレクター（または使うモディファイア）で1枚撮り、適正だった値を入れます。
    いま選択中のモディファイアの校正値として保存されます。</p>
    <div class="set-row"><label>ストロボ→被写体の距離(m)</label><input class="input" data-c="distance" type="text" inputmode="decimal" value="3"></div>
    <div class="set-row"><label>適正だったF値</label><input class="input" data-c="f" type="text" inputmode="decimal" value="11"></div>
    <div class="set-row"><label>そのときのISO</label><input class="input" data-c="iso" type="text" inputmode="decimal" value="100"></div>
    <div class="set-row"><label>そのときの発光量</label>${powerSelectHtml('power', 0, 'data-c')}</div>`;
  const run = document.createElement('button');
  run.type = 'button'; run.className = 'btn btn-primary btn-block'; run.textContent = 'この結果で校正する';
  run.addEventListener('click', () => runCalibration(form, i));
  form.appendChild(run);
  return form;
}

/**
 * 校正の実行：純関数 calibrate で k を逆算して保存する。
 * 発光量は「1/x」表記でも「x」表記でも受ける（`1/128` と `128` の両方を 7段と解釈する）。
 * 分数を数字だけに削ると `1/128` が 1128 になり、段数が壊れるため専用に解析する。
 */
function runCalibration(form, i) {
  const mod = state.flash.modifier;
  try {
    const field = (c) => {
      const input = form.querySelector(`[data-c="${c}"]`);
      if (!input) throw new Error(`入力欄 ${c} がありません`);
      return String(input.value).trim();
    };
    const num = (c) => parseFloat(field(c).replace(/[^\d.]/g, ''));
    // 空欄・非数値は既定値で補わず失敗させる。黙って別の値で校正してしまうほうが危険
    const distance = num('distance'), fAperture = num('f'), iso = num('iso');
    // 発光量はドロップダウン（値は段数）。1/1=0 … 1/128=7
    const powerStops = parsePowerStops(field('power'));
    if (![distance, fAperture, iso, powerStops].every(Number.isFinite)) {
      throw new Error('数値として読めない入力があります');
    }
    const { k } = calibrate({
      ws: state.profiles[i].ws,
      distance: clamp(distance, 0.3, 50),
      fAperture: clamp(fAperture, 1, 32),
      iso: clamp(iso, 25, 102400),
      powerStops: clamp(powerStops, 0, 10),
    });
    if (!Number.isFinite(k)) throw new Error('k を計算できません');
    const kClamped = clamp(k, K_MIN, K_MAX);

    // 実測 k はモディファイアごとに保存する（切り替えても正確なまま／未校正の組み合わせはバッジが出る）
    updateProfile(i, { cal: { ...(state.profiles[i].cal || {}), [mod]: kClamped } });

    // 書き込めたことを state から読み返して確認する。書けていないのに成功と表示しない
    const saved = state.profiles[i].cal ? state.profiles[i].cal[mod] : undefined;
    if (saved == null) throw new Error('保存できませんでした');

    toast(Math.abs(kClamped - k) > 1e-9
      ? `k = ${kClamped.toFixed(2)} で校正しました（実測 ${k.toFixed(2)} を 2.0〜6.0 に丸めました。入力を確認してください）`
      : `k = ${k.toFixed(2)} で校正しました`);
  } catch (e) {
    // 黙って何もしない状態を作らない。バッジの消失だけが手がかりだと原因を追えない
    toast(`校正できませんでした。入力を確認してください（${e.message}）`);
  }
}

/**
 * 発光量の入力を段数に変換する。
 * ドロップダウンの値（`0`〜`7`）はそのまま段数。手入力の `1/128` や `128` も受ける
 * （数字だけに削ると `1/128` が 1128 になり段数が壊れるため、分数を専用に解析する）。
 * @param {string} text @returns {number} 段（フル発光からの絞り段数）
 */
function parsePowerStops(text) {
  const s = String(text).trim();
  if (/^[0-7]$/.test(s)) return Number(s);                  // ドロップダウンの値＝段数
  const m = s.match(/^\s*1\s*\/\s*(\d+(?:\.\d+)?)\s*$/);     // 「1/x」表記
  const denom = m ? parseFloat(m[1]) : parseFloat(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(denom) || denom <= 0) return NaN;
  return Math.round(Math.log2(denom));
}

function ownedNdRow() {
  const row = document.createElement('div'); row.className = 'field';
  const label = document.createElement('div'); label.className = 'field-label'; label.textContent = '所有 ND';
  const chips = document.createElement('div'); chips.className = 'chip-row'; chips.id = 'owned-nd-chips';
  OWNED_ND_ALL.forEach((stops) => {
    const c = chipEl(String(stops), `ND${2 ** stops}`); c.classList.add('chip-nd'); c.setAttribute('role', 'checkbox');
    chips.appendChild(c);
  });
  chips.addEventListener('click', (e) => {
    const c = e.target.closest('[data-key]'); if (!c) return;
    const stops = Number(c.dataset.key);
    const set = new Set(state.settings.ownedND);
    set.has(stops) ? set.delete(stops) : set.add(stops);
    setState({ settings: { ownedND: Array.from(set).sort((a, b) => a - b) } });
  });
  row.append(label, chips);
  return row;
}

/**
 * 「ブラックミストを常時装着」。レンズに付いているかどうかは機材の事実で、
 * タブによって変わらないので設定タブに置く（計算タブのトグルと同じ state を見る）。
 */
function blackMistRow() {
  const row = document.createElement('div');
  row.className = 'field toggle-field';
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = 'ブラックミストを常時装着';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'toggle'; btn.id = 'black-mist-toggle';
  btn.setAttribute('role', 'switch'); btn.setAttribute('aria-label', 'ブラックミストを常時装着');
  btn.innerHTML = '<span class="toggle-knob"></span>';
  btn.addEventListener('click', () => setState({ filters: { blackMist: !state.filters.blackMist } }));
  row.append(label, btn);
  return row;
}

function renderSettings() {
  if (state.ui.tab !== 'settings') return;
  const mist = el.settingsRoot.querySelector('#black-mist-toggle');
  if (mist) mist.setAttribute('aria-checked', String(state.filters.blackMist));
  el.settingsRoot.querySelectorAll('input[data-path]').forEach((input) => {
    if (input === document.activeElement) return;
    const spec = FLAT_SETTINGS.find((f) => f.path === input.dataset.path);
    const v = getByPath(state, input.dataset.path);
    input.value = spec && spec.kind === 'recip' ? String(Math.round(1 / v)) : String(v);
  });
  el.settingsRoot.querySelectorAll('.profile-card').forEach((card) => {
    const i = Number(card.dataset.pidx); const p = state.profiles[i]; if (!p) return;
    setInputVal(card, 'name', p.name); setInputVal(card, 'ws', p.ws); setInputVal(card, 'k', p.k);
    setInputVal(card, 'minPower', p.minPowerStops);
    setInputVal(card, 'powerCeiling', p.powerCeilingStops ?? 0);
    card.querySelector('[data-pfield="hss"]').setAttribute('aria-checked', String(p.hss));
  });
  const owned = el.settingsRoot.querySelector('#owned-nd-chips');
  if (owned) owned.querySelectorAll('[data-key]').forEach((c) => {
    c.setAttribute('aria-checked', String(state.settings.ownedND.includes(Number(c.dataset.key))));
  });
}

function setInputVal(card, field, v) {
  const inp = card.querySelector(`[data-pfield="${field}"]`);
  if (inp && inp !== document.activeElement) inp.value = String(v);
}

function systemsHtml(d) {
  if (!d.flash) {
    const a = d.ambient;
    const alts = (d.alternatives || []).map((x) =>
      `<div class="sys-sub">${x.tag}：${x.fLabel} · ${x.ssLabel} · ISO${x.isoLabel}</div>`).join('');
    return `
      <div class="sys-card sys-primary">
        <div class="sys-title">推奨設定</div>
        <div class="sys-main">F${a.fLabel} · ${a.ssLabel} · ISO${a.isoLabel}</div>
        ${a.ndLabel ? `<div class="sys-sub">${a.ndLabel} 装着</div>` : ''}
        ${alts}
      </div>`;
  }
  const a = d.ambient;
  const f = d.flash;
  const offTxt = a.offset != null ? `背景 ${a.offset >= 0 ? '+' : '−'}${Math.abs(a.offset).toFixed(1)} 段` : '';
  return `
    <div class="sys-card sys-primary">
      <div class="sys-title">アンビエント（背景）</div>
      <div class="sys-main">F${a.fLabel} · ${a.ssLabel}</div>
      <div class="sys-sub">ISO${a.isoLabel}${a.ndLabel ? ` · ${a.ndLabel}` : ''}</div>
      ${offTxt ? `<div class="sys-sub">${offTxt}</div>` : ''}
    </div>
    <div class="sys-card sys-flash">
      <div class="sys-title">ストロボ（主被写体）</div>
      <div class="sys-main">発光量 ${f.powerLabel}${f.fecText ? ` <span style="font-size:12px">${f.fecText}</span>` : ''}</div>
      <div class="sys-sub">${f.reachText}</div>
      <div class="sys-sub">閃光 ${f.durationLabel}</div>
    </div>`;
}

function pathHtml(p) {
  const row = (name, r) => r ? `<tr><td>${name}${r.note ? `<br><span class="caption">${r.note}</span>` : ''}</td><td>${r.ss}</td><td>${r.nd}</td><td>${r.power}</td><td>${r.reach.toFixed(1)}m</td></tr>` : '';
  return `<table>
    <thead><tr><th>経路</th><th>SS</th><th>ND</th><th>発光量</th><th>到達</th></tr></thead>
    <tbody>${row('ND経路', p.nd)}${row('HSS経路', p.hss)}</tbody>
  </table>${p.advantage ? `<div class="sys-sub adv" style="padding:6px 8px">${p.advantage}</div>` : ''}`;
}

function warnHtml(w) {
  // helpId を持つ警告にはマニュアルへ飛ぶ ? を付ける（manual.md §0.5）
  const help = w.helpId
    ? `<button type="button" class="warn-help" data-help="${w.helpId}" aria-label="この警告の説明を開く">
         <svg class="icon" aria-hidden="true"><use href="#i-help"></use></svg>
       </button>`
    : '';
  // 設定を直せば解決する警告には、その場で直せるボタンを置く（設定タブへ移動させない）。
  // action は compute() が組み立てた純粋なデータ。ui は description どおりに描くだけ。
  const act = w.action
    ? `<button type="button" class="warn-action" data-action="${w.action.kind}" data-to="${w.action.to}">${w.action.label}</button>`
    : '';
  // UI仕様 §13：alert だけ role="alert"（割り込んで読む）、info/warn は role="status"。
  // **コンテナ側にライブリージョンを置かないこと。**入れ子にすると二重発話になる。
  // 数値の読み上げは #result-announce に集約してあるので、ここは1件ごとの意味付けだけを担う。
  const role = w.level === 'alert' ? 'alert' : 'status';
  return `<div class="warn-item ${w.level}" role="${role}">
    <svg class="icon" aria-hidden="true"><use href="#i-${w.icon}"></use></svg>
    <span>${w.message}</span>${help}${act}
  </div>`;
}

/* ---- 読み上げ（UI仕様 §13）-------------------------------------------- */

/**
 * 読み上げを待つ時間(ms)。**この値の根拠：**
 *
 * 連続変更を起こす入力はシーン微調整スライダーだけで、ドラッグ中は `input` が
 * 数十ms間隔で飛ぶ（1/3段ごとに `setState`）。指を動かし続けている限り次の描画が来るので、
 * **「ドラッグ中の最も遅い刻み間隔」より長く、「指を離してから読み始まるまでの待ちが
 * 気にならない長さ」より短い**必要がある。
 *
 * - 150ms（`--dur-slide`）では刻みの合間に発火して連続発話が残る
 * - 1000ms では操作と読み上げが結びつかず、押し間違いに気づけない
 *
 * 400ms を採る。ホイールやチップは離した瞬間に1回しか描画しないので、この待ちは
 * 「読み始めが 0.4秒遅れる」だけの意味しか持たない。
 */
const ANNOUNCE_DELAY_MS = 400;
let announceTimer = null;

/**
 * 結果を読み上げ用リージョンへ入れる。**操作が落ち着いてから一度だけ。**
 * 読ませるのは主案の数値と警告の件数だけ（カード全文は長すぎて使えない）。
 * @param {object} d derived
 */
function announceResult(d) {
  if (!el.resultAnnounce) return;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    const ws = d.warnings || [];
    const alerts = ws.filter((w) => w.level === 'alert').length;
    // 「この設定で撮れます」1件だけのときは件数を言わない（無い問題を数えない）
    const only = ws.length === 1 && ws[0].level === 'info';
    const tail = only ? ws[0].message
      : `警告 ${ws.length}件${alerts ? `（要対応 ${alerts}件）` : ''}`;
    el.resultAnnounce.textContent = `${d.summary.text}。${tail}`;
  }, ANNOUNCE_DELAY_MS);
}

/* ---- トースト --------------------------------------------------------- */
let toastTimer = null;
function toast(msg) {
  if (!el.toast) return; // init 前に呼ばれても落とさない
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2500);
}

/**
 * ui.js の外（main.js の Service Worker 配線）から一時的な通知を出すための入口。
 * **トーストの DOM を二重に持たないための唯一の公開点。** 状態は変えないので再描画しない。
 * @param {string} msg 表示する文言
 */
export function showToast(msg) { toast(msg); }

/* ---- 小道具（clone / mergeDeep は state.js に集約）------------------- */
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
