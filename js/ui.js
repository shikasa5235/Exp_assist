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
import { SCENES, SUBJECTS, MODIFIERS, POWER_STEPS } from './scenes.js';
import { F, SS, ISO } from './stops.js';
import { calibrate } from './flash.js';
import { makeWheel } from './wheel.js';
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

/* ---- 既定状態（実機確定の上書き込み。confirmed-default-overrides）---- */
export const defaultState = {
  scene: { key: 'sunny', evBase: 15, adjust: 0 },
  intent: 'blur',
  subject: 'walking',
  focal: 50,
  camera: { syncSpeed: 1 / 250, maxSS: 1 / 8000, isoMin: 200, isoMax: 6400, isStops: 0, expandedISOMin: 50 },
  lens: { fMin: 2.8, fMax: 22 },
  flash: { profileId: 'p1', modifier: 'reflector', distance: 3, ambientOffset: -1, useHSS: true, tripod: false, curtain: false },
  nd: [],
  manual: { fIndex: null, ssIndex: null, isoIndex: null, locks: { f: true, ss: true, iso: false } },
  profiles: [
    { id: 'p1', name: '100Ws', ws: 100, k: 4.0, hss: true, minPowerStops: 7, modifier: 'reflector', calibrated: false },
    { id: 'p2', name: '200Ws', ws: 200, k: 4.0, hss: true, minPowerStops: 7, modifier: 'reflector', calibrated: false },
  ],
  settings: { hssBaseLoss: 2.0, ambientOffsetDefault: -1, ownedND: [1, 2, 3, 4], comp: 0 },
  ui: { tab: 'easy', theme: 'auto', firstRun: true },
};

/* ---- モジュールスコープの単一状態 ------------------------------------ */
let state = null;
let derived = null;
const el = {}; // 要素参照キャッシュ（index.html の固定要素）
const wheels = { ruler: {}, calc: {} }; // 共有ホイールのコントローラ
let rulerScaleTrack = null, rulerClipL = null, rulerClipR = null;
let calcNdSuffix = null, calcNdSig = null;

/* ====================================================================== */
/*  初期化                                                                 */
/* ====================================================================== */

/**
 * アプリ起動。保存状態を復元し、DOM を組み立てて初回描画する。
 * @param {object|null} loaded storage.load() の結果
 */
export function init(loaded) {
  state = mergeDeep(clone(defaultState), loaded || {});
  cacheElements();
  buildStaticDom();
  wireEvents();
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
    'calc-ev', 'calc-ev-err', 'calc-nd-chips', 'calc-tracks', 'equiv-list', 'settings-root',
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
  if (persist) storage.save(state);
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
  // EV ルーラー（永続DOM）・計算タブ・設定タブ
  buildRuler();
  buildCalcNd();
  buildCalcTracks();
  buildSettings();
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
  // TODO(切り分け用・確認後に削除): compute の分岐結果と描画対象を突き合わせる
  console.log('[render]', {
    tab: state.ui.tab,
    intent: state.intent,
    tracks: derived.ruler?.tracks?.length,
    series: derived.ruler?.tracks?.map((t) => t.series).join(','),
    wall: derived.wall,
    flashOn: derived.flashOn,
    badges: derived.badges.length,
  });
  renderTheme();
  renderTabs();
  renderHeader();
  renderTab1();
  renderRuler();
  renderResult();
  renderCalc();
  renderSettings();
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

  // 可視/非可視
  const showSubject = state.intent === 'freeze' || state.intent === 'slowSync';
  const showSlow = state.intent === 'slowSync';
  el.subjectField.hidden = !showSubject;
  el.flashPanel.hidden = !derived.flashOn;
  el.tripodField.hidden = !showSlow;
  el.curtainField.hidden = !showSlow;
  el.uncalibratedBadge.hidden = !derived.uncalibrated;
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
  // derived を描くだけ。タブは見ない（何を映すかは compute() の入口で解決済み）。
  // 同調速度の壁
  if (d.wall) { el.wallReadout.hidden = false; el.wallNum.textContent = d.wall.text; }
  else { el.wallReadout.hidden = true; }
  // バッジ
  el.resultBadges.innerHTML = d.badges.map((b) => `<span class="badge badge-est">${b.text}</span>`).join('');
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
  // TODO(切り分け用・確認後に削除)
  console.log('[ruler]', {
    called: true,
    rows: RULER_SERIES.map((s) => `${wheels.ruler[s].row.tagName}.${wheels.ruler[s].row.className}`),
    showing: r.tracks.map((t) => t.series),
    powerRowHidden: wheels.ruler.POWER.row.hidden,
    powerRowDisplay: getComputedStyle(wheels.ruler.POWER.row).display,
    wallHidden: el.wallReadout.hidden,
    wallDisplay: getComputedStyle(el.wallReadout).display,
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
  el.calcNdChips.querySelectorAll('.chip-nd').forEach((c) => c.remove());
  state.settings.ownedND.forEach((stops) => {
    const c = chipEl(String(stops), `ND${2 ** stops}`);
    c.classList.add('chip-nd'); c.setAttribute('role', 'checkbox'); c.removeAttribute('aria-checked');
    el.calcNdChips.insertBefore(c, calcNdSuffix);
  });
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
  const sum = state.nd.reduce((a, b) => a + b, 0);
  el.calcNdChips.querySelectorAll('[data-key]').forEach((c) => {
    c.setAttribute('aria-checked', String(state.nd.includes(Number(c.dataset.key))));
  });
  calcNdSuffix.textContent = sum ? `合計 ${sum}段（−${sum}EV）` : '装着なし';
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
  if (!rows || !rows.length) {
    return '<div class="equiv-empty">この条件で成立する組み合わせがありません。ISO上限を上げるか、F値の範囲を広げてください</div>';
  }
  return rows.map((r) => `<div class="equiv-row${r.isMain ? ' is-main' : ''}">
    <span>F${r.fLabel}</span><span>${r.ssLabel}</span><span>ISO${r.isoLabel}</span>
    <span class="equiv-flags">${r.flags.map((f) => `<svg class="icon" aria-hidden="true"><use href="#i-${f}"></use></svg>`).join('')}</span>
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
  { group: 2, path: 'settings.hssBaseLoss', label: 'HSS基準損失(段)', kind: 'num', min: 1, max: 2.5 },
  { group: 2, path: 'settings.ambientOffsetDefault', label: '既定アンビエント段数', kind: 'num', min: -3, max: 1 },
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

function profileCard(p, i) {
  const card = document.createElement('div'); card.className = 'profile-card'; card.dataset.pidx = String(i);
  card.innerHTML = `
    <div class="set-row"><label>名称</label><input class="input" data-pfield="name" type="text" value="${p.name}"></div>
    <div class="set-row"><label>出力(Ws)</label><input class="input" data-pfield="ws" type="text" inputmode="decimal" value="${p.ws}"></div>
    <div class="set-row"><label>機材係数 k</label><input class="input" data-pfield="k" type="text" inputmode="decimal" value="${p.k}"></div>
    <div class="set-row"><label>最小発光量 (1/x)</label><input class="input" data-pfield="minPower" type="text" inputmode="decimal" value="${2 ** p.minPowerStops}"></div>
    <div class="toggle-field"><span class="field-label">HSS 対応</span>
      <button type="button" class="toggle" data-pfield="hss" role="switch" aria-checked="${p.hss}" aria-label="HSS対応"><span class="toggle-knob"></span></button></div>`;
  const cal = document.createElement('button');
  cal.type = 'button'; cal.className = 'btn btn-ghost btn-block'; cal.textContent = p.calibrated ? 'テスト撮影で再校正' : 'テスト撮影で校正';
  cal.addEventListener('click', () => toggleCalibration(card, i));
  card.appendChild(cal);
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
  else if (f === 'k') updateProfile(i, { k: clamp(raw, 2.0, 6.0) });
  else if (f === 'minPower') updateProfile(i, { minPowerStops: clamp(Math.round(Math.log2(raw)), 0, 10) });
}

/** プロファイル配列の1件を更新（配列は置換）。 */
function updateProfile(i, patch) {
  const profiles = state.profiles.map((p, idx) => (idx === i ? { ...p, ...patch } : p));
  setState({ profiles });
}

/** 校正フォームの開閉。 */
function toggleCalibration(card, i) {
  const existing = card.querySelector('.calib-form');
  if (existing) { existing.remove(); return; }
  const p = state.profiles[i];
  const form = document.createElement('div'); form.className = 'calib-form'; form.style.marginTop = '8px';
  form.innerHTML = `
    <div class="set-row"><label>距離(m)</label><input class="input" data-c="distance" type="text" inputmode="decimal" value="3"></div>
    <div class="set-row"><label>適正だったF値</label><input class="input" data-c="f" type="text" inputmode="decimal" value="11"></div>
    <div class="set-row"><label>そのときのISO</label><input class="input" data-c="iso" type="text" inputmode="decimal" value="${state.camera.isoMin}"></div>
    <div class="set-row"><label>発光量(1/x)</label><input class="input" data-c="power" type="text" inputmode="decimal" value="1"></div>`;
  const run = document.createElement('button');
  run.type = 'button'; run.className = 'btn btn-primary btn-block'; run.textContent = 'この結果で校正する';
  run.addEventListener('click', () => runCalibration(form, i));
  form.appendChild(run);
  card.appendChild(form);
}

/** 校正の実行：純関数 calibrate で k を逆算し setState。 */
function runCalibration(form, i) {
  const get = (c) => parseFloat(String(form.querySelector(`[data-c="${c}"]`).value).replace(/[^\d.]/g, ''));
  const distance = clamp(get('distance') || 3, 0.3, 50);
  const fAperture = clamp(get('f') || 11, 1, 32);
  const iso = clamp(get('iso') || state.camera.isoMin, 25, 102400);
  const powerX = get('power') || 1;
  const powerStops = clamp(Math.round(Math.log2(powerX)), 0, 10);
  const { k } = calibrate({ ws: state.profiles[i].ws, distance, fAperture, iso, powerStops });
  updateProfile(i, { k: clamp(k, 2.0, 6.0), calibrated: true });
  toast(`校正しました：k = ${k.toFixed(2)}`);
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

function renderSettings() {
  if (state.ui.tab !== 'settings') return;
  el.settingsRoot.querySelectorAll('input[data-path]').forEach((input) => {
    if (input === document.activeElement) return;
    const spec = FLAT_SETTINGS.find((f) => f.path === input.dataset.path);
    const v = getByPath(state, input.dataset.path);
    input.value = spec && spec.kind === 'recip' ? String(Math.round(1 / v)) : String(v);
  });
  el.settingsRoot.querySelectorAll('.profile-card').forEach((card) => {
    const i = Number(card.dataset.pidx); const p = state.profiles[i]; if (!p) return;
    setInputVal(card, 'name', p.name); setInputVal(card, 'ws', p.ws); setInputVal(card, 'k', p.k);
    setInputVal(card, 'minPower', 2 ** p.minPowerStops);
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
  const row = (name, r) => r ? `<tr><td>${name}</td><td>${r.ss}</td><td>${r.nd}</td><td>${r.power}</td><td>${r.reach.toFixed(1)}m</td></tr>` : '';
  return `<table>
    <thead><tr><th>経路</th><th>SS</th><th>ND</th><th>発光量</th><th>到達</th></tr></thead>
    <tbody>${row('ND経路', p.nd)}${row('HSS経路', p.hss)}</tbody>
  </table>${p.advantage ? `<div class="sys-sub adv" style="padding:6px 8px">${p.advantage}</div>` : ''}`;
}

function warnHtml(w) {
  return `<div class="warn-item ${w.level}">
    <svg class="icon" aria-hidden="true"><use href="#i-${w.icon}"></use></svg>
    <span>${w.message}</span>
  </div>`;
}

/* ---- トースト --------------------------------------------------------- */
let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2500);
}

/* ---- 小道具 ----------------------------------------------------------- */
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
/** 2階層までの深いマージ（配列は置換）。 */
function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = isObj(out[k]) && isObj(patch[k]) ? { ...out[k], ...patch[k] } : patch[k];
  }
  return out;
}
