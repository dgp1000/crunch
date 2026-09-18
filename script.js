"use strict";

const TIME_LIMIT_MS = 300_000;
const WARN_AT_MS = 100_000;
const DANGER_AT_MS = 50_000;

const LARGE_POOL = [25, 50, 75, 100];
const LARGE_COUNT = 2;
const SMALL_COUNT = 4;

const OPS = {
  "+": (a, b) => a + b,
  "−": (a, b) => a - b,
  "×": (a, b) => a * b,
  "÷": (a, b) => a / b,
};
const OP_CHARS = "+−×÷";

// --- Daily-puzzle plumbing ---
const STORAGE_KEY = "crunch:state";
const LEGACY_STORAGE_KEY = "calcle:state";
const INTRO_SEEN_KEY = "crunch:seenIntro";
// Migrate any pre-rename save once on load so existing streaks survive.
try {
  if (!localStorage.getItem(STORAGE_KEY)) {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      localStorage.setItem(STORAGE_KEY, legacy);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  }
} catch (_) { /* localStorage unavailable; non-fatal */ }

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// "2026-06-26" → "Fri 26 Jun" for the top-left date label.
function formatPuzzleDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d)
    .toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
    .replace(",", "");
}

function msUntilLocalMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next - now;
}

function seedFromString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultStats() {
  return { currentStreak: 0, maxStreak: 0, streakLastDay: null, gamesPlayed: 0, wins: 0, totalPoints: 0 };
}

// Parse a solver-produced expression (numbers + + − × ÷ + balanced parens) into
// an AST node tree. Used purely for hint generation — we need *compute order*
// of tiles and a step-by-step trace, neither of which can be read off the raw
// text. The solver always fully parenthesises each binary op, so the grammar
// at every level is `atom op atom` where atom is a number or `(expr)`.
function parseSolverExpr(expr) {
  if (!expr) return null;
  const tokens = tokenize(String(expr));
  let pos = 0;
  function parseAtom() {
    const t = tokens[pos];
    if (!t) return null;
    if (t.type === "NUM") { pos++; return { kind: "num", value: t.value }; }
    if (t.type === "PAREN" && t.value === "(") {
      pos++;
      const inner = parseExpr();
      if (tokens[pos] && tokens[pos].value === ")") pos++;
      return inner;
    }
    return null;
  }
  function parseExpr() {
    let left = parseAtom();
    while (pos < tokens.length && tokens[pos].type === "OP") {
      const op = tokens[pos].value; pos++;
      const right = parseAtom();
      left = { kind: "op", op, left, right };
    }
    return left;
  }
  return parseExpr();
}

// Tiles in the order they're first introduced into a computation: depth-first
// into op children before lone-number children at each level. For
// `75 + (100 ÷ 4)` this yields [100, 4, 75] — the order the player will
// actually use them — not text order [75, 100, 4].
function tilesInComputeOrder(node) {
  if (!node) return [];
  if (node.kind === "num") return [node.value];
  const opsFirst = [];
  const numsAfter = [];
  if (node.left.kind === "op") opsFirst.push(...tilesInComputeOrder(node.left));
  else numsAfter.push(node.left.value);
  if (node.right.kind === "op") opsFirst.push(...tilesInComputeOrder(node.right));
  else numsAfter.push(node.right.value);
  return [...opsFirst, ...numsAfter];
}

// Step-by-step computation in evaluation order, each as
// `"<lhs> <op> <rhs> = <result>"`. For `Add(Mul(75, 6), 22)` →
// ["75 × 6 = 450", "450 + 22 = 472"]. The lhs/rhs are the actual values at
// that step (so the second step shows the running total, not the original
// sub-expression).
function stepsInComputeOrder(node) {
  const steps = [];
  function applyOp(a, op, b) {
    if (op === "+") return a + b;
    if (op === "−") return a - b;
    if (op === "×") return a * b;
    if (op === "÷") return a / b;
    return 0;
  }
  function recurse(n) {
    if (!n) return 0;
    if (n.kind === "num") return n.value;
    const lv = recurse(n.left);
    const rv = recurse(n.right);
    const result = applyOp(lv, n.op, rv);
    steps.push(`${lv} ${n.op} ${rv} = ${result}`);
    return result;
  }
  recurse(node);
  return steps;
}

// Build the ordered list of progressive hint strings for a given solver
// expression. The number of levels scales with solution complexity:
//   3-tile solution → 6 hints (3 tile reveals + start-with + 2 step reveals)
//   4-tile solution → 8 hints
//   2-tile solution → 4 hints
// Last level is always the final step showing the complete computation.
function buildHintLevels(solutionExpr) {
  if (!solutionExpr) return [];
  const ast = parseSolverExpr(solutionExpr);
  if (!ast) return [];
  const tiles = tilesInComputeOrder(ast);
  const steps = stepsInComputeOrder(ast);
  const levels = [];

  // Phase 1 — reveal tiles one at a time, in compute order, cumulatively.
  // Consistent phrasing across all tile reveals so the running list reads
  // as one growing sentence over multiple clicks.
  for (let i = 0; i < tiles.length; i++) {
    levels.push(`The tiles used in this order: ${tiles.slice(0, i + 1).join(", ")}.`);
  }

  // Phase 2 — reveal the first operation as an expression only (no result).
  // Skip for trivial 1-tile "solutions" where there's no operation to hint.
  if (steps.length > 0) {
    const firstOpExpr = steps[0].split(" = ")[0];
    levels.push(`Start with: ${firstOpExpr}.`);
  }

  // Phase 3 — walk each computation step, showing the running total.
  for (let i = 0; i < steps.length; i++) {
    levels.push(`${steps[i]}.`);
  }

  // Phase 4 — final reveal of the full expression. For a 2-tile solution
  // the last running-total step (`100 + 8 = 108`) IS the full expression,
  // so skip the redundant level. Anything with nested ops genuinely benefits
  // from seeing the full parenthesised form laid out.
  if (steps.length > 1) {
    const finalValue = steps[steps.length - 1].split(" = ")[1];
    levels.push(`Full solution: ${solutionExpr} = ${finalValue}.`);
  }

  return levels;
}

function hintLevelsCount(solutionExpr) {
  return buildHintLevels(solutionExpr).length;
}

function buildHintText(level, solutionExpr) {
  const levels = buildHintLevels(solutionExpr);
  if (levels.length === 0) return "";
  const idx = Math.max(0, Math.min(level - 1, levels.length - 1));
  return levels[idx];
}

// Tiered Countdown-style scoring with a speed bonus. Accuracy sets the ceiling
// (10 exact / 7 within 5 / 5 within 10 / else 0); within each tier, each unused
// 30-second bucket adds one point. Solve fast and accurate to hit the cap.
function pointsFor(distance, timeUsedMs) {
  if (distance == null) return 0;
  let cap;
  if (distance === 0) cap = 10;
  else if (distance <= 5) cap = 7;
  else if (distance <= 10) cap = 5;
  else return 0;
  const remainingMs = Math.max(0, TIME_LIMIT_MS - (timeUsedMs ?? TIME_LIMIT_MS));
  const speedPts = Math.floor(remainingMs / 30_000) + 1;
  return Math.min(cap, speedPts);
}

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Migrate legacy shape ({date, result}) → ({lastPlayed, stats}).
    if (data.date && data.result && !data.lastPlayed) {
      return {
        lastPlayed: { date: data.date, result: data.result },
        stats: defaultStats(),
      };
    }
    if (!data.stats) data.stats = defaultStats();
    if (data.stats.totalPoints == null) data.stats.totalPoints = 0;
    return data;
  } catch (_) { return null; }
}

function saveStored(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch (_) { /* localStorage unavailable; non-fatal */ }
}

// Persist (or clear) the in-progress round so refreshing the page resumes
// the timer from the original start instead of resetting to 5:00. Closes
// off the cheat where refreshing rewinds the clock.
function persistActiveRound(active) {
  const data = loadStored() || { stats: defaultStats() };
  if (active) data.activeRound = active;
  else delete data.activeRound;
  saveStored(data);
}

function yesterdayKey(todayK) {
  const [y, m, d] = todayK.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
}

let rng = Math.random;

// --- Step engine (pure; exercised by tests.js) ---
// A round is a list of steps, each combining two live tiles into a new one.
// `steps` is the single source of truth: [{ aId, op, bId }]. Everything
// else (the live tile set, the step trace, the best value so far) is
// derived by replaying it against the day's pool. Undo is just pop().

// Combine two values. Countdown rules: no negatives, no fractions.
// − and ÷ are auto-oriented (larger first / divisible first) so the player
// never has to think about tap order; the trace shows the form computed.
function computeStep(a, op, b) {
  switch (op) {
    case "+": return { ok: true, a, b, value: a + b };
    case "×": return { ok: true, a, b, value: a * b };
    case "−": {
      const [hi, lo] = a >= b ? [a, b] : [b, a];
      if (hi === lo) return { ok: false, error: `${a} − ${b} = 0 — that won't help.` };
      return { ok: true, a: hi, b: lo, value: hi - lo };
    }
    case "÷": {
      if (a === 0 || b === 0) return { ok: false, error: "Can't divide by zero." };
      if (a % b === 0) return { ok: true, a, b, value: a / b };
      if (b % a === 0) return { ok: true, a: b, b: a, value: b / a };
      return { ok: false, error: `${a} ÷ ${b} isn't a whole number.` };
    }
    default: return { ok: false, error: "Unknown operator." };
  }
}

// Replay steps against the pool. Returns the full tile list (originals
// t0..t5 then derived d1..dN, each with used flag + expression string), a
// detail trace for the on-screen working, and the ids of the live tiles in
// board order. Stops at the first step that
// can't be applied, so a corrupt saved round degrades to a shorter one.
function replaySteps(pool, steps) {
  const tiles = pool.map((v, i) => ({ id: `t${i}`, value: v, expr: String(v), used: false, derived: false }));
  const detail = [];
  // Board order: the new tile takes the slot of the first tile tapped and
  // the second tile's slot closes up, so the row shrinks by one per step.
  const order = tiles.map(t => t.id);
  const byId = id => tiles.find(t => t.id === id);
  for (let i = 0; i < (steps || []).length; i++) {
    const s = steps[i];
    const a = byId(s.aId), b = byId(s.bId);
    if (!a || !b || a === b || a.used || b.used) break;
    const r = computeStep(a.value, s.op, b.value);
    if (!r.ok) break;
    a.used = true; b.used = true;
    const [ea, eb] = r.a === a.value && (r.b === b.value) ? [a.expr, b.expr] : [b.expr, a.expr];
    const nt = { id: `d${i + 1}`, value: r.value, expr: `(${ea} ${s.op} ${eb})`, used: false, derived: true };
    tiles.push(nt);
    order[order.indexOf(a.id)] = nt.id;
    order.splice(order.indexOf(b.id), 1);
    detail.push({ a: r.a, op: s.op, b: r.b, value: r.value, tileId: nt.id });
  }
  return { tiles, detail, order };
}

// Closest tile to the target among everything the player has made. Ties go
// to the most recently made tile (it's what they were working towards).
function bestTile(tiles, target) {
  let best = null;
  for (const t of tiles) {
    if (!t.derived) continue;
    const d = Math.abs(t.value - target);
    if (!best || d <= Math.abs(best.value - target)) best = t;
  }
  return best;
}

// --- DOM ---
const puzzleDateEl    = document.getElementById("puzzleDate");
const targetEl        = document.getElementById("target");
const timerBar        = document.getElementById("timerBar");
const timerFill       = document.getElementById("timerFill");
const timerReadout    = document.getElementById("timerReadout");
const startArea       = document.getElementById("startArea");
const lockedNotice    = document.getElementById("lockedNotice");
const lockedSummary   = document.getElementById("lockedSummary");
const lockedSolution  = document.getElementById("lockedSolution");
const lockedShareBtn  = document.getElementById("lockedShareBtn");
const lockedCountdown = document.getElementById("lockedCountdown");
const boardEl         = document.getElementById("board");
const numbersRow      = document.getElementById("numbersRow");
const stepsList       = document.getElementById("stepsList");
const stepsEmpty      = document.getElementById("stepsEmpty");
const undoBtn         = document.getElementById("undoBtn");
const statusEl        = document.getElementById("status");
const submitBtn       = document.getElementById("submitBtn");
const endModal        = document.getElementById("endModal");
const endTitle        = document.getElementById("endTitle");
const endMessage      = document.getElementById("endMessage");
const endSolution     = document.getElementById("endSolution");
const endStats        = document.getElementById("endStats");
const lockedStats     = document.getElementById("lockedStats");
const newGameBtn      = document.getElementById("newGameBtn");
const shareBtn        = document.getElementById("shareBtn");
const endShareBar     = document.getElementById("endShareBar");
const lockedShareBar  = document.getElementById("lockedShareBar");
const introModal      = document.getElementById("introModal");
const introCloseBtn   = document.getElementById("introCloseBtn");
const helpBtn         = document.getElementById("helpBtn");
const opButtons       = Array.from(document.querySelectorAll(".op-btn"));
const hintRow         = document.getElementById("hintRow");
const hintBtn         = document.getElementById("hintBtn");
const hintDisplay     = document.getElementById("hintDisplay");

// --- State ---
let state;
let tickHandle = null;
let countdownHandle = null;

function newPuzzle({ devRandom = false } = {}) {
  if (tickHandle) { clearTimeout(tickHandle); tickHandle = null; }
  if (countdownHandle) { clearInterval(countdownHandle); countdownHandle = null; }

  const today = todayKey();
  if (puzzleDateEl) puzzleDateEl.textContent = formatPuzzleDate(today);
  rng = devRandom
    ? mulberry32(Math.floor(Math.random() * 0x7fffffff))
    : mulberry32(seedFromString(today));

  const pool = [];
  const largeShuffle = shuffle([...LARGE_POOL]);
  for (let i = 0; i < LARGE_COUNT; i++) pool.push(largeShuffle[i]);
  const smallPool = [];
  for (let n = 1; n <= 10; n++) { smallPool.push(n, n); }
  const smallShuffle = shuffle(smallPool);
  for (let i = 0; i < SMALL_COUNT; i++) pool.push(smallShuffle[i]);
  shuffleInPlace(pool);

  const target = 100 + Math.floor(rng() * 900);

  const stored = loadStored();
  const alreadyPlayed = stored && stored.lastPlayed && stored.lastPlayed.date === today;
  const stats = (stored && stored.stats) || defaultStats();
  // Resume an in-progress round if one exists for today and hasn't been
  // finalised. Refreshing restores the original startTimeMs and the steps
  // taken so far instead of resetting the clock.
  const activeRound = (!alreadyPlayed && stored && stored.activeRound
    && stored.activeRound.date === today)
    ? stored.activeRound : null;

  // Pre-solve so we know up front whether hints are even possible (no
  // exact solution → hint button hidden) and have the optimal expression
  // cached for the hint generator.
  const presolve = solve(pool, target);
  const solutionExpr = presolve && presolve.distance === 0 ? presolve.expr : null;

  state = {
    pool,
    day: today, // the date this puzzle was generated for — used to auto-refresh across midnight
    steps: activeRound ? (activeRound.steps || []) : [],
    sel: { aId: null, op: null },
    target,
    phase: alreadyPlayed ? "locked" : (activeRound ? "running" : "idle"),
    startTimeMs: activeRound ? activeRound.startTimeMs : 0,
    endTimeMs: activeRound ? activeRound.startTimeMs + TIME_LIMIT_MS : 0,
    msLeft: TIME_LIMIT_MS,
    result: alreadyPlayed ? stored.lastPlayed.result : null,
    stats,
    solutionExpr,
    hintCount: activeRound ? (activeRound.hintCount || 0)
             : alreadyPlayed && stored.lastPlayed.result ? (stored.lastPlayed.result.hintCount || 0)
             : 0,
  };

  endModal.hidden = true;
  setStatus("");

  if (alreadyPlayed) {
    showLockedInline();
  } else {
    startArea.hidden = true;
    lockedNotice.hidden = true;
    if (activeRound) {
      const remaining = state.endTimeMs - Date.now();
      if (remaining <= 0) {
        // Clock already expired during the refresh — finalise as a timeout
        // with whatever was made so far.
        timeUp();
      } else {
        scheduleTick();
      }
    }
  }

  render();
  if (state.phase === "running") {
    renderTimer(Math.max(0, state.endTimeMs - Date.now()));
  } else {
    renderTimer(TIME_LIMIT_MS);
  }
}

function shuffle(arr) { const a = arr.slice(); shuffleInPlace(a); return a; }
function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function showLockedInline() {
  startArea.hidden = false;
  lockedNotice.hidden = false;
  const r = state.result;
  const hintSuffix = r && r.hintCount
    ? ` · ${r.hintCount} hint${r.hintCount === 1 ? "" : "s"} used`
    : "";
  if (r && r.kind === "noanswer") {
    lockedSummary.textContent = `You didn't submit a guess. (0/10)${hintSuffix}`;
  } else if (r && r.distance != null) {
    const pts = r.points != null ? r.points : pointsFor(r.distance, r.timeUsedMs);
    let off;
    if (r.distance === 0) {
      const clock = r.timeUsedMs != null ? formatClock(r.timeUsedMs) : null;
      off = clock != null ? `exact hit in ${clock} 🎯` : "exact hit 🎯";
    } else {
      off = `off by ${r.distance}`;
    }
    lockedSummary.textContent = `${pts}/10 — ${r.exprText} = ${r.result} (${off})${hintSuffix}`;
  } else {
    lockedSummary.textContent = "";
  }
  renderSolution(lockedSolution, r);
  renderShareBars();
  renderStats(lockedStats);
  startCountdownTicker();
}

function startCountdownTicker() {
  if (countdownHandle) clearInterval(countdownHandle);
  const update = () => {
    const ms = msUntilLocalMidnight();
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    lockedCountdown.textContent =
      `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    if (ms <= 0) {
      clearInterval(countdownHandle);
      countdownHandle = null;
      // Cross-midnight: reload to pick up the new puzzle
      newPuzzle();
    }
  };
  update();
  countdownHandle = setInterval(update, 1000);
}

// --- Round lifecycle ---
// The clock starts on the first tile tap (no Start button). Tiles show "?"
// until then so nobody can plan before the timer is running.
function startRound() {
  if (state.phase !== "idle") return;
  state.phase = "running";
  state.startTimeMs = Date.now();
  state.endTimeMs = state.startTimeMs + TIME_LIMIT_MS;
  state.steps = [];
  state.sel = { aId: null, op: null };
  persistRound();
  setStatus("");
  scheduleTick();
  render();
}

function persistRound() {
  if (state.phase !== "running") return;
  persistActiveRound({
    date: todayKey(),
    startTimeMs: state.startTimeMs,
    steps: state.steps,
    hintCount: state.hintCount || 0,
  });
}

function scheduleTick() {
  if (tickHandle) clearTimeout(tickHandle);
  tickHandle = setTimeout(tick, 100);
}

function tick() {
  if (state.phase !== "running") return;
  const remaining = Math.max(0, state.endTimeMs - Date.now());
  state.msLeft = remaining;
  renderTimer(remaining);
  if (remaining === 0) {
    timeUp();
  } else {
    tickHandle = setTimeout(tick, 100);
  }
}

function timeUp() {
  if (state.phase !== "running") return;
  const { tiles } = replaySteps(state.pool, state.steps);
  finishRound(bestTile(tiles, state.target), true, TIME_LIMIT_MS);
}

function submitGuess() {
  if (state.phase !== "running") return;
  const { tiles } = replaySteps(state.pool, state.steps);
  const best = bestTile(tiles, state.target);
  if (!best) {
    setStatus("Combine some tiles first — tap a tile, an operator, then another tile.", "error");
    return;
  }
  finishRound(best, false, Date.now() - state.startTimeMs);
}

// Modal title keyed off accuracy tier + speed-based points. Faster, closer
// solves earn stronger praise; egregious misses get called out.
function resultTitle(distance, points, byTimeout) {
  if (distance === 0) {
    if (byTimeout)       return "Just in time! 🎯";
    if (points === 10)   return "Bullseye! 🎯";
    if (points >= 8)     return "Brilliant! 🎯";
    if (points >= 5)     return "Nice one! 🎯";
    if (points >= 3)     return "Got there! 🎯";
    return "Just made it! 🎯";
  }
  const prefix = byTimeout ? "Time's up — " : "";
  if (distance <= 5) {
    if (points >= 5) return prefix + "So close!";
    if (points >= 3) return prefix + "Nearly had it!";
    return prefix + "A hair off.";
  }
  if (distance <= 10) {
    if (points >= 3) return prefix + "In the neighborhood.";
    return prefix + "Within range.";
  }
  // Off by >10 — zero points. Tone scales with how far off.
  if (byTimeout) return "Time's up.";
  if (distance > 100) return "Way off this time.";
  if (distance > 30)  return "Not even close.";
  return "Next time.";
}

// `tile` is the player's declared tile (closest made value), or null when
// they never combined anything.
function finishRound(tile, byTimeout, timeUsedMs = TIME_LIMIT_MS) {
  if (tickHandle) { clearTimeout(tickHandle); tickHandle = null; }
  state.phase = "locked";
  state.sel = { aId: null, op: null };

  let title, message;
  let points = 0;
  const hintCount = state.hintCount || 0;
  const hintTail = hintCount
    ? `\n${hintCount} hint${hintCount === 1 ? "" : "s"} used.`
    : "";
  if (!tile) {
    state.result = { kind: "noanswer", points: 0, timeUsedMs, hintCount };
    title = "Time's up";
    message = `You didn't make anything.${hintTail}`;
  } else {
    const result = tile.value;
    const exprText = stripOuterParens(tile.expr);
    const distance = Math.abs(result - state.target);
    points = pointsFor(distance, timeUsedMs);
    state.result = { exprText, result, distance, byTimeout, timeUsedMs, points, hintCount };
    const clock = formatClock(timeUsedMs);
    title = resultTitle(distance, points, byTimeout);
    if (distance === 0) {
      message = `${points}/10 — solved in ${clock}.\n${exprText} = ${result}${hintTail}`;
    } else if (distance <= 5) {
      message = `${points}/10 — ${exprText} = ${result} (off by ${distance})${hintTail}`;
    } else {
      message = `${points}/10 — ${exprText} = ${result} (off by ${distance}, target was ${state.target})${hintTail}`;
    }
  }
  // Compute solution once for non-exact rounds; cache on state.result.
  if (!state.result || state.result.distance !== 0) {
    const sol = solve(state.pool, state.target);
    if (sol && sol.distance === 0) state.result.solutionExpr = sol.expr;
  }
  endTitle.textContent = title;
  endMessage.textContent = message + "\n\nCome back tomorrow to play again.";
  renderSolution(endSolution, state.result);
  renderShareBars();
  endModal.hidden = false;

  // Update stats. Streak tracks exact hits only; totalPoints accumulates speed-based scores.
  const today = todayKey();
  const won = !!(state.result && state.result.distance === 0);
  const prev = state.stats || defaultStats();
  const newStats = {
    gamesPlayed: prev.gamesPlayed + 1,
    wins: prev.wins + (won ? 1 : 0),
    totalPoints: (prev.totalPoints || 0) + points,
    currentStreak: won
      ? (prev.streakLastDay === yesterdayKey(today) ? prev.currentStreak + 1 : 1)
      : 0,
    maxStreak: prev.maxStreak,
    streakLastDay: won ? today : null,
  };
  newStats.maxStreak = Math.max(prev.maxStreak, newStats.currentStreak);
  state.stats = newStats;

  saveStored({
    lastPlayed: { date: today, result: state.result },
    stats: newStats,
  });
  renderStats(endStats);
  showLockedInline();
  render();
  renderTimer(0);
}

function renderSolution(container, result) {
  if (!container) return;
  // Show solution for any non-exact result (including no-answer). Hide on exact wins.
  if (!result || result.distance === 0) {
    container.innerHTML = "";
    return;
  }
  let expr = result.solutionExpr;
  if (!expr) {
    const sol = solve(state.pool, state.target);
    if (sol && sol.distance === 0) {
      expr = sol.expr;
      result.solutionExpr = expr;
    }
  }
  if (expr) {
    container.innerHTML = `<span class="lbl">A possible solution</span><span class="expr">${expr} = ${state.target}</span>`;
  } else {
    container.innerHTML = `<span class="lbl">No exact solution exists for this puzzle.</span>`;
  }
}

function renderStats(container) {
  if (!container) return;
  const s = state.stats || defaultStats();
  const avg = s.gamesPlayed ? ((s.totalPoints || 0) / s.gamesPlayed).toFixed(1) : "0";
  container.innerHTML = "";
  const cells = [
    { num: s.currentStreak, lbl: "Streak", streak: true },
    { num: s.maxStreak,     lbl: "Best",   streak: true },
    { num: s.gamesPlayed,   lbl: "Played" },
    { num: avg,             lbl: "Avg pts" },
  ];
  for (const c of cells) {
    const cell = document.createElement("div");
    cell.className = "stat" + (c.streak ? " streak" : "");
    const n = document.createElement("div");
    n.className = "num";
    n.textContent = String(c.num);
    const l = document.createElement("div");
    l.className = "lbl";
    l.textContent = c.lbl;
    cell.appendChild(n);
    cell.appendChild(l);
    container.appendChild(cell);
  }
}

// --- Tap handling ---
function tapTile(id) {
  if (state.phase === "idle") { startRound(); return; }
  if (state.phase !== "running") return;
  const sel = state.sel;
  setStatus("");
  if (sel.aId === id) {
    // Tapping the selected tile again clears the selection.
    state.sel = { aId: null, op: null };
  } else if (sel.aId && sel.op) {
    applyStep(sel.aId, sel.op, id);
    return;
  } else {
    // Either nothing selected, or a tile selected with no operator yet:
    // this tile becomes the selection.
    state.sel = { aId: id, op: null };
  }
  render();
}

function tapOp(op) {
  if (state.phase !== "running") return;
  if (!state.sel.aId) {
    setStatus("Pick a tile first.", "error");
    return;
  }
  state.sel.op = state.sel.op === op ? null : op;
  setStatus("");
  render();
}

function applyStep(aId, op, bId) {
  const { tiles } = replaySteps(state.pool, state.steps);
  const a = tiles.find(t => t.id === aId), b = tiles.find(t => t.id === bId);
  if (!a || !b || a.used || b.used) { state.sel = { aId: null, op: null }; render(); return; }
  const r = computeStep(a.value, op, b.value);
  if (!r.ok) {
    setStatus(r.error, "error");
    return; // keep the selection so they can pick a different second tile
  }
  state.steps.push({ aId, op, bId });
  state.sel = { aId: null, op: null };
  persistRound();
  if (r.value === state.target) {
    // Hit it — finish straight away, no Submit needed.
    render();
    const made = replaySteps(state.pool, state.steps).tiles;
    finishRound(made[made.length - 1], false, Date.now() - state.startTimeMs);
    return;
  }
  render();
}

function undo() {
  if (state.phase !== "running") return;
  setStatus("");
  if (state.sel.aId || state.sel.op) {
    state.sel = { aId: null, op: null };
  } else if (state.steps.length) {
    state.steps.pop();
    persistRound();
  }
  render();
}

// --- Hint ---
function useHint() {
  if (!state || state.phase !== "running") return;
  if (!state.solutionExpr) return;
  const max = hintLevelsCount(state.solutionExpr);
  if ((state.hintCount || 0) >= max) return;
  state.hintCount = (state.hintCount || 0) + 1;
  persistRound();
  renderHint();
}

function renderHint() {
  if (!hintRow || !hintBtn || !hintDisplay) return;
  // Hide the entire row whenever the hint button shouldn't be reachable:
  //   - no exact solution exists
  //   - round isn't actively running
  //   - no step taken yet (a hint is for getting unstuck, not starting cold)
  const hasSteps = !!(state && state.steps && state.steps.length);
  const canShow = state && state.phase === "running" && !!state.solutionExpr
    && (hasSteps || (state.hintCount || 0) > 0);
  hintRow.classList.toggle("is-hidden", !canShow);
  hintRow.hidden = !canShow;
  if (!canShow) return;
  const count = state.hintCount || 0;
  const max = hintLevelsCount(state.solutionExpr);
  if (count === 0) {
    hintBtn.textContent = "Need a hint?";
    hintBtn.disabled = false;
    hintDisplay.hidden = true;
    hintDisplay.textContent = "";
    return;
  }
  hintBtn.textContent = count >= max
    ? `Hint (${count} used)`
    : `Another hint? (${count} used)`;
  hintBtn.disabled = count >= max;
  hintDisplay.hidden = false;
  hintDisplay.textContent = buildCumulativeHintDisplay(count, state.solutionExpr);
}

// Render every revealed hint so the solution visibly builds up on screen.
// The tile-reveal lines (phase 1) are inherently cumulative — each level is
// a longer list than the last — so we only show the latest. Anything from
// the step-reveal phase onward stacks below it as a new line.
function buildCumulativeHintDisplay(count, solutionExpr) {
  if (count <= 0 || !solutionExpr) return "";
  const levels = buildHintLevels(solutionExpr);
  if (levels.length === 0) return "";
  const ast = parseSolverExpr(solutionExpr);
  const tileCount = ast ? tilesInComputeOrder(ast).length : 0;
  const safeCount = Math.min(count, levels.length);
  const lines = [];
  // Latest tile-list line (collapses phase-1 entries 1..tileCount into one).
  if (tileCount > 0) {
    const tilesShown = Math.min(safeCount, tileCount);
    if (tilesShown > 0) lines.push(levels[tilesShown - 1]);
  }
  // Each subsequent reveal (start-with, step traces, full solution) stacks.
  for (let i = tileCount; i < safeCount; i++) {
    lines.push(levels[i]);
  }
  return lines.join("\n");
}

// --- Tokenizer (used by the hint AST parser) ---
// --- Tokenizer / parser ---
function tokenize(input) {
  const eq = input.indexOf("=");
  if (eq >= 0) input = input.slice(0, eq);

  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      tokens.push({ type: "NUM", value: parseInt(input.slice(i, j), 10) });
      i = j;
      continue;
    }
    let op = c;
    if (op === "*" || op === "x" || op === "X") op = "×";
    if (op === "/") op = "÷";
    if (op === "-") op = "−";
    if (op === "(" || op === ")") {
      tokens.push({ type: "PAREN", value: op });
    } else if (OP_CHARS.includes(op)) {
      tokens.push({ type: "OP", value: op });
    } else {
      throw new Error(`Unexpected character: "${c}"`);
    }
    i++;
  }
  return tokens;
}

// --- Solver: bitmask DP over tile subsets. ---
// Returns { value, expr, distance } for the closest reachable value (exact if possible).
function solve(pool, target) {
  const n = pool.length;
  const sets = new Array(1 << n);
  for (let i = 0; i < n; i++) {
    const m = new Map();
    m.set(pool[i], String(pool[i]));
    sets[1 << i] = m;
  }
  let best = { value: pool[0], expr: String(pool[0]), distance: Math.abs(pool[0] - target) };
  const consider = (v, e) => {
    const d = Math.abs(v - target);
    if (d < best.distance) best = { value: v, expr: e, distance: d };
  };
  for (const v of pool) consider(v, String(v));

  const popcount = x => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };
  const subsets = [];
  for (let s = 1; s < (1 << n); s++) if (popcount(s) >= 2) subsets.push(s);
  subsets.sort((a, b) => popcount(a) - popcount(b));

  const tryCombo = (m, r, e) => {
    if (!m.has(r)) m.set(r, e);
    consider(r, e);
  };

  for (const s of subsets) {
    const m = new Map();
    // Iterate non-empty proper subsets of s; each unordered partition appears twice (a, s\a) and (s\a, a),
    // which is fine — duplicate work is bounded and Map dedupes results.
    for (let a = (s - 1) & s; a > 0; a = (a - 1) & s) {
      const b = s ^ a;
      const ma = sets[a];
      const mb = sets[b];
      if (!ma || !mb) continue;
      for (const [va, ea] of ma) {
        for (const [vb, eb] of mb) {
          tryCombo(m, va + vb, `(${ea} + ${eb})`);
          tryCombo(m, va * vb, `(${ea} × ${eb})`);
          if (va > vb) tryCombo(m, va - vb, `(${ea} − ${eb})`);
          else if (vb > va) tryCombo(m, vb - va, `(${eb} − ${ea})`);
          if (vb !== 0 && va % vb === 0 && va !== 0)
            tryCombo(m, va / vb, `(${ea} ÷ ${eb})`);
          if (va !== 0 && vb % va === 0 && vb !== 0)
            tryCombo(m, vb / va, `(${eb} ÷ ${ea})`);
        }
      }
    }
    sets[s] = m;
    if (best.distance === 0) break;
  }
  best.expr = stripOuterParens(best.expr);
  return best;
}

function stripOuterParens(e) {
  if (!(e.startsWith("(") && e.endsWith(")"))) return e;
  let depth = 0;
  for (let i = 0; i < e.length - 1; i++) {
    if (e[i] === "(") depth++;
    else if (e[i] === ")") depth--;
    if (depth === 0) return e;
  }
  return e.slice(1, -1);
}

// --- Share ---
function buildShareBar() {
  const r = state && state.result;
  const pts = !r ? 0
            : r.points != null ? r.points
            : r.distance != null ? pointsFor(r.distance, r.timeUsedMs)
            : 0;
  // For 0 pts, show the full row as black so the band is still visible.
  if (pts === 0) return "⬛".repeat(10);
  // Color band reflects speed: 8-10 green, 4-7 yellow, 1-3 orange.
  const filledGlyph = pts >= 8 ? "🟩" : pts >= 4 ? "🟨" : "🟧";
  return filledGlyph.repeat(pts) + "⬜".repeat(10 - pts);
}

function buildShareText() {
  const r = state && state.result;
  const date = todayKey();
  const bar = buildShareBar();
  const hintsTag = r && r.hintCount
    ? ` · ${r.hintCount} hint${r.hintCount === 1 ? "" : "s"}`
    : "";
  if (!r || r.kind === "noanswer") {
    return `Crunch ${date} — 0/10 (no guess)${hintsTag}\n${bar}`;
  }
  const dist = r.distance;
  const pts = pointsFor(dist, r.timeUsedMs);
  const clock = formatClock(r.timeUsedMs ?? TIME_LIMIT_MS);
  const headline = dist === 0
    ? `${pts}/10 🎯 in ${clock}`
    : `${pts}/10 (off by ${dist}, ${clock})`;
  return `Crunch ${date} — ${headline}${hintsTag}\n${bar}`;
}

function renderShareBars() {
  const bar = buildShareBar();
  if (endShareBar) endShareBar.textContent = bar;
  if (lockedShareBar) lockedShareBar.textContent = bar;
}

async function shareResult(btn) {
  const text = buildShareText();
  const url = location.href.split("?")[0].split("#")[0];
  // Merge URL into the text body. iMessage and some other apps turn the
  // separate `url` field into a rich-link card and drop the score+bar
  // entirely — combining keeps the headline + share bar visible.
  const shareBody = `${text}\n${url}`;

  // Native share sheet (iOS, Android, modern desktop) — lets the user pick
  // Messages / WhatsApp / Mail / etc.
  if (navigator.share) {
    try {
      await navigator.share({ title: "Crunch", text: shareBody });
      return;
    } catch (err) {
      // User dismissed the sheet — bail quietly.
      if (err && err.name === "AbortError") return;
      // Any other error: fall through to clipboard.
    }
  }

  // Clipboard fallback (desktop Firefox, anything without Web Share).
  const clipText = shareBody;
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(clipText);
      ok = true;
    }
  } catch (_) { /* fall through */ }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = clipText;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (_) { ok = false; }
  }
  if (btn) {
    const original = btn.textContent;
    btn.textContent = ok ? "Copied!" : "Copy failed";
    setTimeout(() => { btn.textContent = original; }, 1500);
  }
}

// --- Rendering ---
function render() {
  targetEl.textContent = String(state.target);
  const { tiles, detail, order } = replaySteps(state.pool, state.steps);
  renderTiles(tiles, order);
  renderSteps(detail);
  renderControls(detail);
  renderHint();
}

function formatClock(ms) {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderTimer(ms) {
  const running = state && state.phase === "running";
  const idle = state && state.phase === "idle";
  // Idle (pre-round) shows a full bar; once the round ends/locks it's empty.
  const shownMs = running ? ms : (idle ? TIME_LIMIT_MS : 0);
  timerReadout.textContent = formatClock(shownMs);
  timerFill.style.width = `${(shownMs / TIME_LIMIT_MS) * 100}%`;
  const danger = running && ms <= DANGER_AT_MS;
  const warn = running && ms <= WARN_AT_MS && ms > DANGER_AT_MS;
  timerBar.classList.toggle("danger", danger);
  timerBar.classList.toggle("warn", warn);
}

function makeTileButton(t) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tile";
  if (t.derived) btn.classList.add("derived");
  if (state.sel.aId === t.id) btn.classList.add("selected");
  btn.disabled = state.phase !== "running" || t.used;
  btn.textContent = String(t.value);
  btn.addEventListener("click", () => tapTile(t.id));
  return btn;
}

function renderTiles(tiles, order) {
  numbersRow.innerHTML = "";
  if (state.phase === "idle") {
    // Concealed tiles: tapping any one reveals the board and starts the clock.
    for (let i = 0; i < state.pool.length; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tile hidden-tile";
      btn.textContent = "?";
      btn.setAttribute("aria-label", "Tap to reveal the tiles and start the clock");
      btn.addEventListener("click", () => tapTile(null));
      numbersRow.appendChild(btn);
    }
    return;
  }
  const byId = new Map(tiles.map(t => [t.id, t]));
  order.forEach(id => numbersRow.appendChild(makeTileButton(byId.get(id))));
}

function renderSteps(detail) {
  stepsList.innerHTML = "";
  for (const s of detail) {
    const li = document.createElement("li");
    li.textContent = `${s.a} ${s.op} ${s.b} = ${s.value}`;
    stepsList.appendChild(li);
  }
  const running = state.phase === "running";
  if (state.phase === "idle") {
    stepsEmpty.textContent = "Tap a tile to reveal the numbers and start the clock.";
  } else if (state.sel.aId && !state.sel.op) {
    stepsEmpty.textContent = "Now pick an operator.";
  } else if (state.sel.aId && state.sel.op) {
    stepsEmpty.textContent = "Now tap a second tile.";
  } else {
    stepsEmpty.textContent = "Tap a tile, an operator, then another tile.";
  }
  stepsEmpty.hidden = !(running || state.phase === "idle") || (detail.length > 0 && !state.sel.aId);
}

function renderControls(detail) {
  const running = state.phase === "running";
  const hasSel = !!(state.sel.aId || state.sel.op);
  boardEl.hidden = state.phase === "locked";
  undoBtn.disabled = !running || (!hasSel && detail.length === 0);
  undoBtn.textContent = hasSel ? "Cancel" : "Undo";
  // Submit stays clickable when nothing's been made so a tap can trigger
  // the helper message. Visually muted so it still reads as not-yet-usable.
  submitBtn.disabled = !running;
  submitBtn.classList.toggle("muted", running && detail.length === 0);
  opButtons.forEach(b => {
    b.disabled = !running || !state.sel.aId;
    b.classList.toggle("selected", running && state.sel.op === b.dataset.op);
  });
}

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.classList.remove("error", "ok");
  if (kind) statusEl.classList.add(kind);
}

// --- Wire-up ---
opButtons.forEach(b => b.addEventListener("click", () => tapOp(b.dataset.op)));
undoBtn.addEventListener("click", undo);
submitBtn.addEventListener("click", submitGuess);
if (hintBtn) hintBtn.addEventListener("click", useHint);
newGameBtn.addEventListener("click", () => { endModal.hidden = true; });
shareBtn.addEventListener("click", () => shareResult(shareBtn));
lockedShareBtn.addEventListener("click", () => shareResult(lockedShareBtn));
endModal.addEventListener("click", e => {
  if (e.target === endModal) endModal.hidden = true;
});

// --- First-run walkthrough ---
function showIntro() { introModal.hidden = false; }
function dismissIntro() {
  introModal.hidden = true;
  try { localStorage.setItem(INTRO_SEEN_KEY, "1"); } catch (_) { }
}
helpBtn.addEventListener("click", showIntro);
introCloseBtn.addEventListener("click", dismissIntro);

// --- Theme ---
// Follows the OS. The <head> script already applied it before first paint;
// this just keeps it in sync if the OS setting changes while the tab is
// open. A stored explicit choice (from the old toggle) still wins.
const THEME_KEY = "crunch:theme";
const systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");
systemDarkQuery.addEventListener("change", e => {
  try { if (localStorage.getItem(THEME_KEY)) return; } catch (_) { }
  document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
});
introModal.addEventListener("click", e => {
  if (e.target === introModal) dismissIntro();
});

// Dev reset: Cmd+Option+S (Mac) / Ctrl+Alt+S (others) clears the daily lock
// AND re-rolls with a random seed so you get a fresh puzzle each time.
function devReset() {
  localStorage.removeItem(STORAGE_KEY);
  newPuzzle({ devRandom: true });
}

document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyS") {
    e.preventDefault();
    devReset();
  }
});

// Tap-friendly reset: triple-tap the "Crunch" title within 1.5s.
// Long-press was unreliable on iOS Safari (text selection magnifier still
// appears even with -webkit-touch-callout/user-select disabled). Quick
// successive taps don't trigger any native gesture, and the third tap
// fires confirm() inside an active user gesture. Listening on `pointerup`
// rather than `click` because the page-wide double-tap-zoom guard below
// preventDefaults touchend, which suppresses the synthetic click for taps
// 2 and 3 — pointerup fires regardless.
(() => {
  const title = document.querySelector("header h1");
  if (!title) return;
  const WINDOW_MS = 1500;
  const REQUIRED = 3;
  let taps = [];

  title.addEventListener("pointerup", () => {
    const now = Date.now();
    taps = taps.filter(t => now - t < WINDOW_MS);
    taps.push(now);
    if (taps.length < REQUIRED) return;
    taps = [];
    if (confirm("Reset today's puzzle? You'll get a fresh random one.")) {
      devReset();
    }
  });
  title.addEventListener("contextmenu", e => e.preventDefault());
})();

// Belt-and-braces double-tap-zoom suppression. iOS Safari ignores the
// viewport maximum-scale + user-scalable directives in many cases, and
// touch-action: manipulation only applies to the tap target itself. This
// catches any second tap within 350ms anywhere on the page and stops the
// browser from interpreting the pair as a zoom gesture.
let _lastTouchEndMs = 0;
document.addEventListener("touchend", e => {
  const now = Date.now();
  if (now - _lastTouchEndMs <= 350) e.preventDefault();
  _lastTouchEndMs = now;
}, { passive: false });

// Safari bfcache repaint bug: restoring via back/forward sometimes leaves the
// gradient-clipped CRUNCH text invisible (border stays, letters vanish).
// Force a reflow on persisted pageshow so the gradient gets re-rasterised.
window.addEventListener("pageshow", e => {
  if (!e.persisted) return;
  maybeRefreshForNewDay(); // bfcache restore (e.g. mobile tab switch) → catch a day change
  const title = document.querySelector("header h1");
  if (!title) return;
  title.style.display = "none";
  void title.offsetHeight;
  title.style.display = "";
});

// A tab left open across midnight kept showing yesterday's puzzle (the only
// midnight reload was on the locked/countdown screen). Regenerate whenever the
// tab comes back and the calendar day has moved on — unless a round is actively
// being played (don't yank the board mid-attempt).
function maybeRefreshForNewDay() {
  if (state && state.day && state.day !== todayKey() && state.phase !== "running") {
    newPuzzle();
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") maybeRefreshForNewDay();
});
window.addEventListener("focus", maybeRefreshForNewDay);


newPuzzle();

try {
  if (!localStorage.getItem(INTRO_SEEN_KEY)) showIntro();
} catch (_) { }
