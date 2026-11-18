// rHWP(HwpDocument) 위에 얹는 얇은 어댑터.
// 본문 구역과 표 셀을 "문단 리스트"라는 하나의 개념으로 다룰 수 있게 해 준다.
//
// rHWP 의 API 는 결과를 JSON 문자열로 돌려주므로, 여기서 읽어 타입을 붙여 돌려준다.

import type { HwpDocument } from '@rhwp/core';

/**
 * 문단 리스트의 rHWP 위치.
 *   - 본문: parent === -1
 *   - 표 셀: parent = 표를 품은 본문 문단 번호, ctrl = 문단 내 컨트롤 번호, cell = 셀 번호
 */
export interface ListRef {
  sec: number;
  parent: number;
  ctrl: number;
  cell: number;
}

/** 글자 서식 (Yjs Y.Text 의 글자 속성) */
export interface TextAttrs {
  /** 원본 문서의 글자모양(CharShape) 번호 */
  cs?: number | null;
  /** 동시편집 중에 덧입힌 서식: 굵게/기울임/밑줄/취소선/글자색 */
  b?: boolean | null;
  i?: boolean | null;
  u?: boolean | null;
  s?: boolean | null;
  col?: string | null;
}

export type OverlayKey = 'b' | 'i' | 'u' | 's' | 'col';

/** 글자모양 구간 */
export interface ShapeRun {
  len: number;
  cs: number;
}

export interface CursorRect {
  pageIndex: number;
  x: number;
  y: number;
  height: number;
}

export interface SelectionRect extends CursorRect {
  width: number;
}

export interface CellPathStep {
  controlIndex: number;
  cellIndex: number;
  cellParaIndex: number;
}

/** hitTest·moveVertical 이 돌려주는 문서 위치 */
export interface HitResult {
  sectionIndex: number;
  paragraphIndex: number;
  charOffset: number;
  parentParaIndex?: number | null;
  controlIndex?: number;
  cellIndex?: number;
  cellParaIndex?: number;
  cellPath?: CellPathStep[];
  preferredX?: number;
}

export interface LineInfo {
  lineIndex: number;
  lineCount: number;
  charStart: number;
  charEnd: number;
}

export interface PageInfo {
  width: number;
  height: number;
}

export interface CharProps {
  charShapeId: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  textColor: string;
}

/** rHWP 에 넘기는 글자 서식 */
interface FormatProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  textColor?: string;
}

const NONE = 0xffffffff;
const parse = <T>(s: string): T => JSON.parse(s) as T;

export const bodyRef = (sec: number): ListRef => ({ sec, parent: -1, ctrl: 0, cell: 0 });
export const cellRef = (sec: number, parent: number, ctrl: number, cell: number): ListRef => ({ sec, parent, ctrl, cell });
export const isBody = (ref: ListRef): boolean => ref.parent < 0;

// 덧입힌 서식(Yjs 속성) → rHWP applyCharFormat 속성
const OVERLAY_PROPS: Record<OverlayKey, keyof FormatProps> = {
  b: 'bold',
  i: 'italic',
  u: 'underline',
  s: 'strikethrough',
  col: 'textColor',
};
export const OVERLAY_KEYS = Object.keys(OVERLAY_PROPS) as OverlayKey[];

export function overlayToProps(attrs: TextAttrs): FormatProps | null {
  let props: Record<string, unknown> | null = null;
  for (const k of OVERLAY_KEYS) {
    const v = attrs[k];
    if (v !== undefined && v !== null) (props ??= {})[OVERLAY_PROPS[k]] = v;
  }
  return props as FormatProps | null;
}

export class HwpAdapter {
  readonly doc: HwpDocument;

  constructor(doc: HwpDocument) {
    this.doc = doc;
  }

  path(ref: ListRef, i: number): string {
    const step: CellPathStep = { controlIndex: ref.ctrl, cellIndex: ref.cell, cellParaIndex: i };
    return JSON.stringify([step]);
  }

  sectionCount(): number {
    return this.doc.getSectionCount();
  }

  paraCount(ref: ListRef): number {
    return isBody(ref)
      ? this.doc.getParagraphCount(ref.sec)
      : this.doc.getCellParagraphCountByPath(ref.sec, ref.parent, this.path(ref, 0));
  }

  paraLen(ref: ListRef, i: number): number {
    return isBody(ref)
      ? this.doc.getParagraphLength(ref.sec, i)
      : this.doc.getCellParagraphLengthByPath(ref.sec, ref.parent, this.path(ref, i));
  }

  text(ref: ListRef, i: number): string {
    const n = this.paraLen(ref, i);
    if (!n) return '';
    return isBody(ref)
      ? this.doc.getTextRange(ref.sec, i, 0, n)
      : this.doc.getTextInCellByPath(ref.sec, ref.parent, this.path(ref, i), 0, n);
  }

  insertText(ref: ListRef, i: number, off: number, text: string): void {
    if (isBody(ref)) this.doc.insertText(ref.sec, i, off, text);
    else this.doc.insertTextInCellByPath(ref.sec, ref.parent, this.path(ref, i), off, text);
  }

  deleteText(ref: ListRef, i: number, off: number, count: number): void {
    if (isBody(ref)) this.doc.deleteText(ref.sec, i, off, count);
    else this.doc.deleteTextInCellByPath(ref.sec, ref.parent, this.path(ref, i), off, count);
  }

  /** 문단 i 를 off 에서 가른다. 새 문단은 i+1 이 된다. */
  split(ref: ListRef, i: number, off: number): void {
    if (isBody(ref)) this.doc.splitParagraph(ref.sec, i, off);
    else this.doc.splitParagraphInCellByPath(ref.sec, ref.parent, this.path(ref, i), off);
  }

  /** 문단 i 를 앞 문단(i-1)에 합친다. */
  merge(ref: ListRef, i: number): void {
    if (isBody(ref)) this.doc.mergeParagraph(ref.sec, i);
    else this.doc.mergeParagraphInCellByPath(ref.sec, ref.parent, this.path(ref, i));
  }

  /** 문단 i 바로 뒤에 빈 문단을 만든다. 표·그림 같은 개체는 원래 문단에 그대로 남는다. */
  insertParaAfter(ref: ListRef, i: number): void {
    if (isBody(ref)) this.doc.insertParagraph(ref.sec, i + 1);
    else this.split(ref, i, this.paraLen(ref, i));
  }

  /** 문단 i 를 없앤다. */
  removePara(ref: ListRef, i: number): void {
    if (isBody(ref)) {
      this.doc.deleteParagraph(ref.sec, i);
      return;
    }
    const len = this.paraLen(ref, i);
    if (len) this.deleteText(ref, i, 0, len);
    this.merge(ref, i);
  }

  /** 문단 전체의 글자모양 구간 */
  runs(ref: ListRef, i: number): ShapeRun[] {
    const n = this.paraLen(ref, i);
    if (!n) return [];
    const raw = parse<{ startOffset: number; endOffset: number; charShapeId: number }[]>(
      isBody(ref)
        ? this.doc.getCharShapeRuns(ref.sec, i, 0, n)
        : this.doc.getCharShapeRunsInCellByPath(ref.sec, ref.parent, this.path(ref, i), 0, n),
    );
    return raw.map((r) => ({ len: r.endOffset - r.startOffset, cs: r.charShapeId }));
  }

  charProps(ref: ListRef, i: number, off: number): CharProps {
    return parse<CharProps>(
      isBody(ref)
        ? this.doc.getCharPropertiesAt(ref.sec, i, off)
        : this.doc.getCellCharPropertiesAtByPath(ref.sec, ref.parent, this.path(ref, i), off),
    );
  }

  setShape(ref: ListRef, i: number, start: number, end: number, cs: number): void {
    if (isBody(ref)) this.doc.setCharShapeId(ref.sec, i, start, end, cs);
    else this.doc.setCharShapeIdInCellByPath(ref.sec, ref.parent, this.path(ref, i), start, end, cs);
  }

  applyFormat(ref: ListRef, i: number, start: number, end: number, props: FormatProps): void {
    const json = JSON.stringify(props);
    if (isBody(ref)) this.doc.applyCharFormat(ref.sec, i, start, end, json);
    else this.doc.applyCharFormatInCellByPath(ref.sec, ref.parent, this.path(ref, i), start, end, json);
  }

  /** 문단이 품은 컨트롤(표·그림·구역정의 등) 수. 본문 문단만 조회할 수 있다. */
  controlCount(ref: ListRef, i: number): number {
    if (!isBody(ref)) return 0;
    return parse<number[]>(this.doc.getControlTextPositions(ref.sec, i)).length;
  }

  /** 컨트롤이 표이면 셀 수를, 아니면 0 을 돌려준다. */
  tableCellCount(sec: number, para: number, ctrl: number): number {
    try {
      return parse<{ cellCount?: number }>(this.doc.getTableDimensions(sec, para, ctrl)).cellCount || 0;
    } catch {
      return 0;
    }
  }

  // ── 화면 좌표 관련 (편집기 전용) ─────────────────────────────

  cursorRect(ref: ListRef, i: number, off: number): CursorRect {
    return parse<CursorRect>(
      isBody(ref)
        ? this.doc.getCursorRect(ref.sec, i, off)
        : this.doc.getCursorRectByPath(ref.sec, ref.parent, this.path(ref, i), off),
    );
  }

  selectionRects(ref: ListRef, i1: number, o1: number, i2: number, o2: number): SelectionRect[] {
    return parse<SelectionRect[]>(
      isBody(ref)
        ? this.doc.getSelectionRects(ref.sec, i1, o1, i2, o2)
        : this.doc.getSelectionRectsInCellByPath(ref.sec, ref.parent, this.path(ref, i1), i1, o1, i2, o2),
    );
  }

  lineInfo(ref: ListRef, i: number, off: number): LineInfo {
    return parse<LineInfo>(
      isBody(ref)
        ? this.doc.getLineInfo(ref.sec, i, off)
        : this.doc.getLineInfoInCell(ref.sec, ref.parent, ref.ctrl, ref.cell, i, off),
    );
  }

  moveVertical(ref: ListRef, i: number, off: number, delta: number, preferredX: number): HitResult {
    return parse<HitResult>(
      isBody(ref)
        ? this.doc.moveVertical(ref.sec, i, off, delta, preferredX, NONE, NONE, NONE, NONE)
        : this.doc.moveVerticalByPath(ref.sec, ref.parent, this.path(ref, i), off, delta, preferredX),
    );
  }

  hitTest(page: number, x: number, y: number): HitResult {
    return parse<HitResult>(this.doc.hitTest(page, x, y));
  }

  pageCount(): number {
    return this.doc.pageCount();
  }

  pageInfo(page: number): PageInfo {
    return parse<PageInfo>(this.doc.getPageInfo(page));
  }
}
