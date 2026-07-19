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
  const dp = Array.from({ length: beforeLength + 1 }, () => new Float64Array(afterLength + 1));

  for (let i = beforeLength - 1; i >= 0; i--) {
    for (let j = afterLength - 1; j >= 0; j--) {
      const pairScore = scoreAt(i, j);
      const align = Number.isFinite(pairScore)
        ? floatCell(dp, i + 1, j + 1) + pairScore
        : pairScore;
      floatRow(dp, i)[j] = Math.max(align, floatCell(dp, i + 1, j), floatCell(dp, i, j + 1));
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < beforeLength && j < afterLength) {
    const pairScore = scoreAt(i, j);
    const align = Number.isFinite(pairScore) ? floatCell(dp, i + 1, j + 1) + pairScore : pairScore;
    if (Number.isFinite(pairScore) && sameAlignmentScore(floatCell(dp, i, j), align)) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (floatCell(dp, i + 1, j) >= floatCell(dp, i, j + 1)) {
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
  const dp = Array.from({ length: beforeLength + 1 }, () =>
    Array.from({ length: afterLength + 1 }, () => 0),
  );

  for (let i = 1; i <= beforeLength; i++) {
    for (let j = 1; j <= afterLength; j++) {
      const pairScore = scoreAt(i - 1, j - 1);
      const pair = Number.isFinite(pairScore)
        ? numberCell(dp, i - 1, j - 1) + pairScore
        : pairScore;
      numberRow(dp, i)[j] = Math.max(numberCell(dp, i - 1, j), numberCell(dp, i, j - 1), pair);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = beforeLength;
  let j = afterLength;
  while (i > 0 && j > 0) {
    const pairScore = scoreAt(i - 1, j - 1);
    const pair = Number.isFinite(pairScore) ? numberCell(dp, i - 1, j - 1) + pairScore : pairScore;
    if (Number.isFinite(pairScore) && sameAlignmentScore(numberCell(dp, i, j), pair)) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (numberCell(dp, i - 1, j) >= numberCell(dp, i, j - 1)) {
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

function floatCell(rows: Float64Array[], rowIndex: number, columnIndex: number): number {
  return numericAt(floatRow(rows, rowIndex), columnIndex);
}

function floatRow(rows: Float64Array[], index: number): Float64Array {
  const row = rows[index];
  if (row === undefined) throw new RangeError(`Missing alignment row ${index}`);
  return row;
}

function numberCell(rows: number[][], rowIndex: number, columnIndex: number): number {
  return numericAt(numberRow(rows, rowIndex), columnIndex);
}

function numberRow(rows: number[][], index: number): number[] {
  const row = rows[index];
  if (row === undefined) throw new RangeError(`Missing alignment row ${index}`);
  return row;
}

function numericAt(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Missing alignment cell ${index}`);
  return value;
}
