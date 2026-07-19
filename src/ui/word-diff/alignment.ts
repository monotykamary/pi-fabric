// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.
const ALIGNMENT_SCORE_EPSILON = 1e-9;

type PairScoreAt = (beforeIndex: number, afterIndex: number) => number;

function sameAlignmentScore(a: number, b: number): boolean {
  return Math.abs(a - b) < ALIGNMENT_SCORE_EPSILON;
}

export function suffixAlignedPairs(
  beforeLength: number,
  afterLength: number,
  scoreAt: PairScoreAt,
): Array<[number, number]> {
  const columns = afterLength + 1;
  const dp = new Float64Array((beforeLength + 1) * columns);

  for (let i = beforeLength - 1; i >= 0; i--) {
    const rowOffset = i * columns;
    const nextRowOffset = rowOffset + columns;
    for (let j = afterLength - 1; j >= 0; j--) {
      const pairScore = scoreAt(i, j);
      const align = Number.isFinite(pairScore) ? dp[nextRowOffset + j + 1]! + pairScore : pairScore;
      dp[rowOffset + j] = Math.max(align, dp[nextRowOffset + j]!, dp[rowOffset + j + 1]!);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < beforeLength && j < afterLength) {
    const rowOffset = i * columns;
    const nextRowOffset = rowOffset + columns;
    const pairScore = scoreAt(i, j);
    const align = Number.isFinite(pairScore) ? dp[nextRowOffset + j + 1]! + pairScore : pairScore;
    if (Number.isFinite(pairScore) && sameAlignmentScore(dp[rowOffset + j]!, align)) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[nextRowOffset + j]! >= dp[rowOffset + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export function prefixAlignedPairs(
  beforeLength: number,
  afterLength: number,
  scoreAt: PairScoreAt,
): Array<[number, number]> {
  const columns = afterLength + 1;
  const dp = new Float64Array((beforeLength + 1) * columns);

  for (let i = 1; i <= beforeLength; i++) {
    const rowOffset = i * columns;
    const previousRowOffset = rowOffset - columns;
    for (let j = 1; j <= afterLength; j++) {
      const pairScore = scoreAt(i - 1, j - 1);
      const pair = Number.isFinite(pairScore)
        ? dp[previousRowOffset + j - 1]! + pairScore
        : pairScore;
      dp[rowOffset + j] = Math.max(dp[previousRowOffset + j]!, dp[rowOffset + j - 1]!, pair);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = beforeLength;
  let j = afterLength;
  while (i > 0 && j > 0) {
    const rowOffset = i * columns;
    const previousRowOffset = rowOffset - columns;
    const pairScore = scoreAt(i - 1, j - 1);
    const pair = Number.isFinite(pairScore)
      ? dp[previousRowOffset + j - 1]! + pairScore
      : pairScore;
    if (Number.isFinite(pairScore) && sameAlignmentScore(dp[rowOffset + j]!, pair)) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[previousRowOffset + j]! >= dp[rowOffset + j - 1]!) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

export function suffixAlignmentScore(
  beforeLength: number,
  afterLength: number,
  scoreAt: PairScoreAt,
): number {
  let next = new Float64Array(afterLength + 1);
  let current = new Float64Array(afterLength + 1);

  for (let i = beforeLength - 1; i >= 0; i--) {
    current[afterLength] = 0;
    for (let j = afterLength - 1; j >= 0; j--) {
      const pairScore = scoreAt(i, j);
      const match = Number.isFinite(pairScore) ? numericAt(next, j + 1) + pairScore : pairScore;
      current[j] = Math.max(match, numericAt(next, j), numericAt(current, j + 1));
    }
    [next, current] = [current, next];
  }

  return numericAt(next, 0);
}

function numericAt(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Missing alignment cell ${index}`);
  return value;
}
