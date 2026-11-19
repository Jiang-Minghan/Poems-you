// Pure helpers shared by the Node server, the browser client, and tests.
// No DOM, no Node APIs.

const HAN = /^\p{Script=Han}$/u;
const STRIP = /[\p{P}\p{Z}\p{C}]/gu;
const EXTRA_STRIP = /[·・〜～]/gu;

/**
 * Clean a line of poetry the way a player would expect:
 * punctuation, whitespace and invisible characters are washed away.
 * Anything that is not a Han character survives cleaning and marks the
 * input invalid (so Latin letters and emoji are reported, not silently eaten).
 */
export function sanitizePoem(raw) {
  if (typeof raw !== 'string') {
    return { text: '', count: 0, removed: 0, invalid: false };
  }
  const original = raw.normalize('NFC');
  const stripped = original.replace(STRIP, '').replace(EXTRA_STRIP, '');
  const chars = Array.from(stripped);
  return {
    text: chars.join(''),
    count: chars.length,
    removed: Array.from(original).length - chars.length,
    invalid: chars.some(ch => !HAN.test(ch)),
  };
}

export function poemChars(text) {
  return Array.from(text);
}

/**
 * Clean both lines of a couplet independently. Punctuation is washed from each
 * line; the two lines are never merged, so cross-line duplicate characters do
 * not affect marking.
 */
export function sanitizeCouplet(upperRaw, lowerRaw) {
  const upper = sanitizePoem(upperRaw);
  const lower = sanitizePoem(lowerRaw);
  return {
    upper,
    lower,
    count: upper.count + lower.count,
    removed: upper.removed + lower.removed,
    invalid: upper.invalid || lower.invalid,
  };
}

export function coupletKey(upper, lower) {
  return `${upper}\n${lower}`;
}

/**
 * Mark a two-line guess against a two-line answer as one complete couplet.
 * The line break is visual only: a character guessed in the upper line can be
 * "present" because it occurs in the lower answer, and vice versa. Both lines
 * must be fully correct to solve.
 */
export function markCouplet(answer, guess) {
  const upperAnswer = Array.from(answer.upper || '');
  const lowerAnswer = Array.from(answer.lower || '');
  const upperGuess = Array.from(guess.upper || '');
  const lowerGuess = Array.from(guess.lower || '');
  const allMarks = markGuess(
    [...upperAnswer, ...lowerAnswer].join(''),
    [...upperGuess, ...lowerGuess].join('')
  );
  const upper = allMarks.slice(0, upperGuess.length);
  const lower = allMarks.slice(upperGuess.length);
  return {
    upper,
    lower,
    correct: isAllCorrect(upper) && isAllCorrect(lower),
  };
}

export function coupletSummary(marksUpper, marksLower) {
  const upper = markSummary(marksUpper);
  const lower = markSummary(marksLower);
  return {
    correct: upper.correct + lower.correct,
    present: upper.present + lower.present,
  };
}

/**
 * Wordle-style marking with duplicate-aware counts.
 * correct: right character, right place.
 * present: character exists in the answer, but not at this place (once per copy).
 * absent:  no remaining copy of this character.
 */
export function markGuess(answer, guess) {
  const a = Array.from(answer);
  const g = Array.from(guess);
  const marks = new Array(g.length).fill('absent');
  const remaining = new Map();

  for (let i = 0; i < a.length; i++) {
    if (g[i] === a[i]) {
      marks[i] = 'correct';
    } else {
      remaining.set(a[i], (remaining.get(a[i]) || 0) + 1);
    }
  }

  for (let i = 0; i < g.length; i++) {
    if (marks[i] === 'correct') continue;
    const left = remaining.get(g[i]) || 0;
    if (left > 0) {
      marks[i] = 'present';
      remaining.set(g[i], left - 1);
    }
  }

  return marks;
}

export function isAllCorrect(marks) {
  return marks.length > 0 && marks.every(m => m === 'correct');
}

/** A compact count used for the small summary beside a guess. */
export function markSummary(marks) {
  let correct = 0;
  let present = 0;
  for (const m of marks) {
    if (m === 'correct') correct++;
    else if (m === 'present') present++;
  }
  return { correct, present };
}

export const PALETTE_KEYS = [
  'bg', 'bg2', 'paper', 'paper2', 'ink', 'inkSoft', 'line',
  'accent', 'accentSoft', 'onAccent', 'seal', 'onSeal',
  'absent', 'onAbsent', 'present', 'onPresent',
  'correct', 'onCorrect', 'shadow', 'noise',
];
