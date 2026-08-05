// storage.js — localStorage の読み書きラッパー。必ず try/catch で包む。
// 失敗しても計算機能は落とさない（プライベートブラウズ等で例外を投げる環境がある）。

const KEY = 'expo-state-v1';

// 「一度だけ出す」たぐいのフラグ。**アプリ状態（KEY）とは別に持つ。**
// compute の入力でも描画の材料でもないので state に混ぜない：混ぜると schemaVersion を
// 上げる必要が出るうえ、設定リセットで「初回通知」がもう一度出てしまう。
const FLAG_KEY = 'expo-flags-v1';

/**
 * 保存済み状態を読み込む。失敗時は null。
 * @returns {object|null}
 */
export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 状態を保存する。成功可否を返す（失敗しても呼び出し側は続行する）。
 * @param {object} state
 * @returns {boolean}
 */
export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 一度きりのフラグを読む。失敗時（プライベートブラウズ等）は false。
 * @param {string} name フラグ名
 * @returns {boolean}
 */
export function getFlag(name) {
  try {
    const raw = localStorage.getItem(FLAG_KEY);
    return !!(raw && JSON.parse(raw)[name]);
  } catch (e) {
    return false;
  }
}

/**
 * 一度きりのフラグを立てる／下ろす。失敗しても呼び出し側は続行する。
 * 保存できない環境では毎回 false が返るため通知が繰り返されるが、機能は落とさない。
 * @param {string} name フラグ名
 * @param {boolean} value
 * @returns {boolean} 保存できたか
 */
export function setFlag(name, value) {
  try {
    const raw = localStorage.getItem(FLAG_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    obj[name] = value;
    localStorage.setItem(FLAG_KEY, JSON.stringify(obj));
    return true;
  } catch (e) {
    return false;
  }
}

// available()（書込テストで可否を先に調べる関数）は削除した。
// save() が成否を返すので、本番の書き込みそのものが最も正確な判定になる。
// 探りの書き込みを1回増やすだけで、判定が二重になり食い違う余地を作っていた。
// 保存できないことの通知は ui.setState → warnStorageOnce が担う（UI仕様 §12）。
