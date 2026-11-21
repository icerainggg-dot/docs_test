// 셀 주소 도우미. 행·열 번호는 1부터 센다 (엑셀과 같음).

export interface CellPos {
  row: number;
  col: number;
}

export interface RangePos {
  from: CellPos;
  to: CellPos;
}

export function colName(col: number): string {
  let s = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function colNumber(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export const addrOf = (row: number, col: number): string => `${colName(col)}${row}`;

const ADDR_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

export function parseAddr(addr: string): CellPos | null {
  const m = ADDR_RE.exec(addr.trim());
  if (!m) return null;
  return { col: colNumber(m[1]!), row: Number(m[2]) };
}

export function parseRange(ref: string): RangePos | null {
  const [a, b = a] = ref.split(':');
  const from = a ? parseAddr(a) : null;
  const to = b ? parseAddr(b) : null;
  if (!from || !to) return null;
  return {
    from: { row: Math.min(from.row, to.row), col: Math.min(from.col, to.col) },
    to: { row: Math.max(from.row, to.row), col: Math.max(from.col, to.col) },
  };
}

export const rangeRef = (r: RangePos): string =>
  r.from.row === r.to.row && r.from.col === r.to.col
    ? addrOf(r.from.row, r.from.col)
    : `${addrOf(r.from.row, r.from.col)}:${addrOf(r.to.row, r.to.col)}`;

/**
 * 수식 안의 상대 참조를 옮긴다 (공유 수식 펼치기용). $ 가 붙은 쪽은 그대로 둔다.
 * 문자열("...")과 따옴표 친 시트 이름('...')은 건드리지 않는다.
 */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  if (!dRow && !dCol) return formula;
  let out = '';
  let i = 0;
  const ref = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\w.(!])/;
  while (i < formula.length) {
    const ch = formula[i]!;
    if (ch === '"' || ch === "'") {
      // 문자열·시트 이름: 짝이 되는 따옴표까지 (두 번 겹친 따옴표는 글자)
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === ch) {
          if (formula[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const prev = i > 0 ? formula[i - 1]! : '';
    if (/[A-Za-z$]/.test(ch) && !/[\w.]/.test(prev)) {
      const m = ref.exec(formula.slice(i));
      if (m) {
        const [whole, cAbs, cName, rAbs, rNum] = m as unknown as [string, string, string, string, string];
        const col = cAbs ? colNumber(cName) : colNumber(cName) + dCol;
        const row = rAbs ? Number(rNum) : Number(rNum) + dRow;
        out += col < 1 || row < 1 ? '#REF!' : `${cAbs}${colName(col)}${rAbs}${row}`;
        i += whole.length;
        continue;
      }
      // 함수 이름·정의된 이름 등은 통째로 넘긴다.
      const word = /^[\w.$]+/.exec(formula.slice(i))![0];
      out += word;
      i += word.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
