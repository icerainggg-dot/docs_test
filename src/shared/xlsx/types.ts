// XLSX 동시편집 데이터 모델.
//
// 원본 파일은 그대로 두고, 사람들이 고친 셀만 Yjs 문서에 담는다.
//   ydoc.getMap('cells') : Y.Map<"<시트번호>:<주소>", CellInput>
// 같은 셀을 두 사람이 동시에 고치면 나중 것이 이긴다(엑셀 공동편집과 같은 방식).

/** 셀에 들어가는 값 (사람이 입력한 것) */
export type CellInput =
  | { t: 'n'; v: number }
  | { t: 's'; v: string }
  | { t: 'b'; v: boolean }
  /** 수식 (= 없이) */
  | { t: 'f'; f: string }
  /** 지운 셀 */
  | { t: 'z' };

/** 원본 파일에 있던 셀 */
export interface BaseCell {
  /** n 숫자, s 글자, b 참/거짓, e 오류 */
  t: 'n' | 's' | 'b' | 'e';
  /** 값 (수식이면 원본에 저장되어 있던 계산 결과) */
  v: number | string | boolean;
  /** 수식 (= 없이, 공유 수식은 펼친 것) */
  f?: string;
  /** 배열 수식: 계산하지 않고 원본 결과를 쓴다 */
  arr?: boolean;
  /** 셀 서식 번호 (styles.xml cellXfs) */
  s?: number;
}

export interface BorderSide {
  style: string;
  color: string | null;
}

/** 화면 표시용 셀 서식 */
export interface CellStyle {
  numFmt: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string | null;
  /** 글자 크기 (pt) */
  size?: number;
  font?: string;
  fill?: string | null;
  hAlign?: string;
  vAlign?: string;
  wrap?: boolean;
  border?: { left?: BorderSide; right?: BorderSide; top?: BorderSide; bottom?: BorderSide };
}

export interface SheetModel {
  name: string;
  /** zip 안의 경로 (예: xl/worksheets/sheet1.xml) */
  path: string;
  hidden: boolean;
  /** 쓰인 범위 */
  maxRow: number;
  maxCol: number;
  /** 열 너비·행 높이 (px). 없는 것은 기본값 */
  colWidths: Record<number, number>;
  rowHeights: Record<number, number>;
  defaultColWidth: number;
  defaultRowHeight: number;
  /** 병합 범위 (예: "A1:C2") */
  merges: string[];
  cells: Record<string, BaseCell>;
}

export interface WorkbookModel {
  sheets: SheetModel[];
  styles: CellStyle[];
  /** 정의된 이름 → 참조 (예: "Sheet1!$A$1:$B$4") */
  names: Record<string, string>;
  /** 1904 날짜 체계 */
  date1904: boolean;
}

export const CELLS = 'cells';
export const cellKey = (sheet: number, addr: string): string => `${sheet}:${addr}`;

export function splitCellKey(key: string): { sheet: number; addr: string } | null {
  const i = key.indexOf(':');
  if (i < 0) return null;
  return { sheet: Number(key.slice(0, i)), addr: key.slice(i + 1) };
}
