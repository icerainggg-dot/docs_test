// rHWP(HwpDocument) 위에 얹는 얇은 어댑터.
// 본문 구역과 표 셀을 "문단 리스트"라는 하나의 개념으로 다룰 수 있게 해 준다.
//
// ref = { sec, parent, ctrl, cell }
//   - 본문: parent === -1
//   - 표 셀: parent = 표를 품은 본문 문단 번호, ctrl = 문단 내 컨트롤 번호, cell = 셀 번호

const NONE = 0xffffffff;
const parse = (s) => JSON.parse(s);

export const bodyRef = (sec) => ({ sec, parent: -1, ctrl: 0, cell: 0 });
export const cellRef = (sec, parent, ctrl, cell) => ({ sec, parent, ctrl, cell });
export const isBody = (ref) => ref.parent < 0;

// 글자 겹침 서식(Yjs 속성) → rHWP applyCharFormat 속성
const OVERLAY_PROPS = { b: 'bold', i: 'italic', u: 'underline', s: 'strikethrough', col: 'textColor' };
export const OVERLAY_KEYS = Object.keys(OVERLAY_PROPS);

export function overlayToProps(attrs) {
  let props = null;
  for (const k of OVERLAY_KEYS) {
    if (attrs[k] !== undefined && attrs[k] !== null) {
      (props ??= {})[OVERLAY_PROPS[k]] = attrs[k];
    }
  }
  return props;
}

export class HwpAdapter {
  constructor(doc) {
    this.doc = doc;
  }

  path(ref, i) {
    return JSON.stringify([{ controlIndex: ref.ctrl, cellIndex: ref.cell, cellParaIndex: i }]);
  }

  sectionCount() {
    return this.doc.getSectionCount();
  }

  paraCount(ref) {
    return isBody(ref)
      ? this.doc.getParagraphCount(ref.sec)
      : this.doc.getCellParagraphCountByPath(ref.sec, ref.parent, this.path(ref, 0));
  }

  paraLen(ref, i) {
    return isBody(ref)
      ? this.doc.getParagraphLength(ref.sec, i)
      : this.doc.getCellParagraphLengthByPath(ref.sec, ref.parent, this.path(ref, i));
  }

  text(ref, i) {
    const n = this.paraLen(ref, i);
    if (!n) return '';
    return isBody(ref)
      ? this.doc.getTextRange(ref.sec, i, 0, n)
      : this.doc.getTextInCellByPath(ref.sec, ref.parent, this.path(ref, i), 0, n);
  }

  insertText(ref, i, off, text) {
    if (isBody(ref)) this.doc.insertText(ref.sec, i, off, text);
    else this.doc.insertTextInCellByPath(ref.sec, ref.parent, this.path(ref, i), off, text);
  }

  deleteText(ref, i, off, count) {
    if (isBody(ref)) this.doc.deleteText(ref.sec, i, off, count);
    else this.doc.deleteTextInCellByPath(ref.sec, ref.parent, this.path(ref, i), off, count);
  }

  /** 문단 i 를 off 에서 가른다. 새 문단은 i+1 이 된다. */
  split(ref, i, off) {
    if (isBody(ref)) this.doc.splitParagraph(ref.sec, i, off);
    else this.doc.splitParagraphInCellByPath(ref.sec, ref.parent, this.path(ref, i), off);
  }

  /** 문단 i 를 앞 문단(i-1)에 합친다. */
  merge(ref, i) {
    if (isBody(ref)) this.doc.mergeParagraph(ref.sec, i);
    else this.doc.mergeParagraphInCellByPath(ref.sec, ref.parent, this.path(ref, i));
  }

  /** 문단 i 바로 뒤에 빈 문단을 만든다. 표·그림 같은 개체는 원래 문단에 그대로 남는다. */
  insertParaAfter(ref, i) {
    if (isBody(ref)) this.doc.insertParagraph(ref.sec, i + 1);
    else this.split(ref, i, this.paraLen(ref, i));
  }

  /** 문단 i 를 없앤다. */
  removePara(ref, i) {
    if (isBody(ref)) {
      this.doc.deleteParagraph(ref.sec, i);
      return;
    }
    const len = this.paraLen(ref, i);
    if (len) this.deleteText(ref, i, 0, len);
    this.merge(ref, i);
  }

  /** [{len, cs}] — 문단 전체의 글자모양 구간 */
  runs(ref, i) {
    const n = this.paraLen(ref, i);
    if (!n) return [];
    const raw = parse(
      isBody(ref)
        ? this.doc.getCharShapeRuns(ref.sec, i, 0, n)
        : this.doc.getCharShapeRunsInCellByPath(ref.sec, ref.parent, this.path(ref, i), 0, n),
    );
    return raw.map((r) => ({ len: r.endOffset - r.startOffset, cs: r.charShapeId }));
  }

  charProps(ref, i, off) {
    return parse(
      isBody(ref)
        ? this.doc.getCharPropertiesAt(ref.sec, i, off)
        : this.doc.getCellCharPropertiesAtByPath(ref.sec, ref.parent, this.path(ref, i), off),
    );
  }

  setShape(ref, i, start, end, cs) {
    if (isBody(ref)) this.doc.setCharShapeId(ref.sec, i, start, end, cs);
    else this.doc.setCharShapeIdInCellByPath(ref.sec, ref.parent, this.path(ref, i), start, end, cs);
  }

  applyFormat(ref, i, start, end, props) {
    const json = JSON.stringify(props);
    if (isBody(ref)) this.doc.applyCharFormat(ref.sec, i, start, end, json);
    else this.doc.applyCharFormatInCellByPath(ref.sec, ref.parent, this.path(ref, i), start, end, json);
  }

  /** 문단이 품은 컨트롤(표·그림·구역정의 등) 수. 본문 문단만 조회할 수 있다. */
  controlCount(ref, i) {
    if (!isBody(ref)) return 0;
    return parse(this.doc.getControlTextPositions(ref.sec, i)).length;
  }

  /** 컨트롤이 표이면 셀 수를, 아니면 0 을 돌려준다. */
  tableCellCount(sec, para, ctrl) {
    try {
      return parse(this.doc.getTableDimensions(sec, para, ctrl)).cellCount || 0;
    } catch {
      return 0;
    }
  }

  // ── 화면 좌표 관련 (편집기 전용) ─────────────────────────────

  cursorRect(ref, i, off) {
    return parse(
      isBody(ref)
        ? this.doc.getCursorRect(ref.sec, i, off)
        : this.doc.getCursorRectByPath(ref.sec, ref.parent, this.path(ref, i), off),
    );
  }

  selectionRects(ref, i1, o1, i2, o2) {
    return parse(
      isBody(ref)
        ? this.doc.getSelectionRects(ref.sec, i1, o1, i2, o2)
        : this.doc.getSelectionRectsInCellByPath(ref.sec, ref.parent, this.path(ref, i1), i1, o1, i2, o2),
    );
  }

  lineInfo(ref, i, off) {
    return parse(
      isBody(ref)
        ? this.doc.getLineInfo(ref.sec, i, off)
        : this.doc.getLineInfoInCell(ref.sec, ref.parent, ref.ctrl, ref.cell, i, off),
    );
  }

  moveVertical(ref, i, off, delta, preferredX) {
    return parse(
      isBody(ref)
        ? this.doc.moveVertical(ref.sec, i, off, delta, preferredX, NONE, NONE, NONE, NONE)
        : this.doc.moveVerticalByPath(ref.sec, ref.parent, this.path(ref, i), off, delta, preferredX),
    );
  }

  hitTest(page, x, y) {
    return parse(this.doc.hitTest(page, x, y));
  }

  pageCount() {
    return this.doc.pageCount();
  }

  pageInfo(page) {
    return parse(this.doc.getPageInfo(page));
  }
}
