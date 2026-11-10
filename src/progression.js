// ─────────────────────────────────────────────────────────────────────────────
// A. LEVEL-UNLOCK PROGRESSION
//
// Every level is ALWAYS listed (simultaneous visibility). A level is playable when
// it is Level 1 or the immediately previous level has been cleared at least once.
// Cleared levels stay replayable forever (sandbox replay) and keep their best rating.
// ─────────────────────────────────────────────────────────────────────────────
import { LEVELS } from './levels.js';

const KEY = 'killhouse.progress.v1';

const GRADE_ORDER = ['C', 'B', 'A', 'S'];

function blankSave() {
  return { results: {} }; // results[levelId] = { cleared, bestGrade, bestTime, perfect, attempts }
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return Object.assign(blankSave(), JSON.parse(raw));
  } catch (e) { /* private mode / blocked storage: play without persistence */ }
  return blankSave();
}

let save = load();

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(save)); } catch (e) { /* ignore */ }
}

// Dev/testing escape hatch: ?unlockall in the URL.
const UNLOCK_ALL = typeof location !== 'undefined' && /[?&]unlockall\b/.test(location.search);

export function getResult(levelId) {
  return save.results[levelId] || null;
}

export function isCleared(levelId) {
  return !!(save.results[levelId] && save.results[levelId].cleared);
}

/** Level N is unlocked iff N is the first level or level N-1 has been cleared. */
export function isUnlocked(levelId) {
  if (UNLOCK_ALL) return true;
  if (levelId === 0) return true;
  return isCleared(levelId - 1);
}

/** Status for the level-select grid: every level is returned (visible), with its lock state. */
export function levelStatuses() {
  return LEVELS.map((lvl) => {
    const res = getResult(lvl.id);
    let status = 'locked';
    if (isUnlocked(lvl.id)) status = res && res.cleared ? 'cleared' : 'available';
    return {
      level: lvl,
      status,
      bestGrade: res ? res.bestGrade : null,
      perfect: res ? !!res.perfect : false,
      bestTime: res ? res.bestTime : null,
      lockReason: status === 'locked' ? `Clear Level ${lvl.id} to unlock` : null,
    };
  });
}

/**
 * Called when a simulation round ends. Beating level X (win === true) marks it cleared,
 * which is exactly the condition isUnlocked(X + 1) checks — so X+1 opens and every
 * later level stays visible but locked.
 * Returns { newlyUnlocked: levelId | null }.
 */
export function recordResult(levelId, { win, grade, time, perfect }) {
  const prev = save.results[levelId] || { cleared: false, bestGrade: null, bestTime: null, perfect: false, attempts: 0 };
  const wasNextUnlocked = isUnlocked(levelId + 1);
  prev.attempts += 1;
  if (win) {
    prev.cleared = true;
    if (!prev.bestGrade || GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(prev.bestGrade)) prev.bestGrade = grade;
    if (prev.bestTime == null || time < prev.bestTime) prev.bestTime = time;
    prev.perfect = prev.perfect || !!perfect;
  }
  save.results[levelId] = prev;
  persist();
  const next = levelId + 1;
  const newlyUnlocked = win && next < LEVELS.length && !wasNextUnlocked && isUnlocked(next) ? next : null;
  return { newlyUnlocked };
}

export function resetProgress() {
  save = blankSave();
  persist();
}
