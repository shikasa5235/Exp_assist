// storage.js — localStorage の読み書きラッパー。必ず try/catch で包む。
// 失敗しても計算機能は落とさない（プライベートブラウズ等で例外を投げる環境がある）。

const KEY = 'expo-state-v1';

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
 * localStorage が使えるか（書込テスト）。
 * @returns {boolean}
 */
export function available() {
  try {
    const k = '__expo_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch (e) {
    return false;
  }
}
