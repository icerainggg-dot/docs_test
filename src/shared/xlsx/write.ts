// XLSX 저장: 원본 파일에서 고친 셀만 바꿔 넣는다.
// 차트·피벗·조건부 서식·인쇄 설정처럼 우리가 다루지 않는 부분은 원본 그대로 남는다.

import { zipSync, strToU8, strFromU8 } from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Element as XElement, Document as XDocument } from '@xmldom/xmldom';
import { addrOf, parseAddr, parseRange, colName } from './addr.ts';
import { Calculator } from './calc.ts';
import { isError } from './format.ts';
import type { CellValue } from './format.ts';
import { unzip, kid, kids, deep, parseXlsx } from './parse.ts';
import type { Files } from './parse.ts';
import type { BaseCell, CellInput, WorkbookModel } from './types.ts';

const BAD_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
const clean = (s: string): string => s.replace(BAD_XML, '');

/** 고친 셀: 시트 번호 → (주소 → 입력) */
export type Edits = Map<number, Map<string, CellInput>>;

function parseDoc(files: Files, path: string): XDocument {
  return new DOMParser().parseFromString(strFromU8(files[path]!), 'text/xml');
}

function serialize(doc: XDocument): Uint8Array {
  let xml = new XMLSerializer().serializeToString(doc);
  if (!xml.startsWith('<?xml')) xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xml;
  return strToU8(xml);
}

/** 문서 뿌리와 같은 이름공간·접두어로 요소를 만든다. */
function maker(doc: XDocument): (name: string) => XElement {
  const root = doc.documentElement!;
  const ns = root.namespaceURI;
  const prefix = root.prefix;
  return (name) => doc.createElementNS(ns, prefix ? `${prefix}:${name}` : name);
}

function removeKids(el: XElement, names: string[]): void {
  for (const n of names) for (const k of kids(el, n)) el.removeChild(k);
}

/** 계산 결과를 캐시 값(<v>)으로 적는다. */
function setCached(c: XElement, value: CellValue, mk: (n: string) => XElement): void {
  removeKids(c, ['v']);
  c.removeAttribute('t');
  if (value === null) return;
  const v = mk('v');
  if (isError(value)) {
    c.setAttribute('t', 'e');
    v.textContent = value.error;
  } else if (typeof value === 'boolean') {
    c.setAttribute('t', 'b');
    v.textContent = value ? '1' : '0';
  } else if (typeof value === 'string') {
    c.setAttribute('t', 'str');
    v.textContent = clean(value);
  } else {
    v.textContent = String(value);
  }
  c.appendChild(v);
}

function patchSheet(
  doc: XDocument,
  sheetNo: number,
  edits: Map<string, CellInput>,
  base: WorkbookModel,
  calc: Calculator,
): void {
  const root = doc.documentElement!;
  const mk = maker(doc);
  let sheetData = kid(root, 'sheetData');
  if (!sheetData) {
    sheetData = mk('sheetData');
    root.appendChild(sheetData);
  }

  const rows = new Map<number, XElement>();
  let rowNo = 0;
  for (const r of kids(sheetData, 'row')) {
    rowNo = Number(r.getAttribute('r')) || rowNo + 1;
    r.setAttribute('r', String(rowNo));
    rows.set(rowNo, r);
  }
  const getRow = (n: number): XElement => {
    let r = rows.get(n);
    if (r) return r;
    r = mk('row');
    r.setAttribute('r', String(n));
    const after = [...rows.keys()].filter((k) => k > n).sort((a, b) => a - b)[0];
    sheetData!.insertBefore(r, after !== undefined ? rows.get(after)! : null);
    rows.set(n, r);
    return r;
  };
  const cellsOf = (r: XElement): Map<number, XElement> => {
    const out = new Map<number, XElement>();
    let col = 0;
    for (const c of kids(r, 'c')) {
      const p = parseAddr(c.getAttribute('r') ?? '');
      col = p ? p.col : col + 1;
      c.setAttribute('r', addrOf(Number(r.getAttribute('r')), col));
      out.set(col, c);
    }
    return out;
  };

  let maxRow = 0;
  let maxCol = 0;
  for (const [addr, input] of edits) {
    const pos = parseAddr(addr);
    if (!pos) continue;
    const r = getRow(pos.row);
    r.removeAttribute('spans');
    const cells = cellsOf(r);
    let c = cells.get(pos.col);
    if (!c) {
      if (input.t === 'z') continue;
      c = mk('c');
      c.setAttribute('r', addr);
      const after = [...cells.keys()].filter((k) => k > pos.col).sort((a, b) => a - b)[0];
      r.insertBefore(c, after !== undefined ? cells.get(after)! : null);
    }
    removeKids(c, ['f', 'v', 'is']);
    c.removeAttribute('t');
    maxRow = Math.max(maxRow, pos.row);
    maxCol = Math.max(maxCol, pos.col);
    switch (input.t) {
      case 'z':
        if (!c.getAttribute('s') || c.getAttribute('s') === '0') r.removeChild(c);
        break;
      case 'n': {
        const v = mk('v');
        v.textContent = String(input.v);
        c.appendChild(v);
        break;
      }
      case 'b': {
        c.setAttribute('t', 'b');
        const v = mk('v');
        v.textContent = input.v ? '1' : '0';
        c.appendChild(v);
        break;
      }
      case 's': {
        c.setAttribute('t', 'inlineStr');
        const is = mk('is');
        const t = mk('t');
        t.setAttribute('xml:space', 'preserve');
        t.textContent = clean(input.v);
        is.appendChild(t);
        c.appendChild(is);
        break;
      }
      case 'f': {
        const f = mk('f');
        f.textContent = clean(input.f);
        c.appendChild(f);
        setCached(c, calc.canEvaluate(sheetNo, addr) ? calc.value(sheetNo, addr) : null, mk);
        break;
      }
    }
  }

  // 공유 수식은 셀마다 풀어 쓰고, 다른 셀이 바뀌어 달라진 수식 결과를 고친다.
  const sheet = base.sheets[sheetNo]!;
  for (const r of kids(sheetData, 'row')) {
    for (const c of kids(r, 'c')) {
      const addr = c.getAttribute('r') ?? '';
      if (edits.has(addr)) continue;
      const f = kid(c, 'f');
      if (!f) continue;
      const baseCell: BaseCell | undefined = sheet.cells[addr];
      if (!baseCell || baseCell.arr) continue;
      if (f.getAttribute('t') === 'shared' && baseCell.f) {
        f.removeAttribute('t');
        f.removeAttribute('ref');
        f.removeAttribute('si');
        f.textContent = baseCell.f;
      }
      if (calc.canEvaluate(sheetNo, addr)) setCached(c, calc.value(sheetNo, addr), mk);
    }
  }

  // 쓰인 범위 표시 갱신
  const dim = kid(root, 'dimension');
  if (dim && maxRow) {
    const cur = parseRange(dim.getAttribute('ref') ?? 'A1');
    const to = { row: Math.max(cur?.to.row ?? 1, maxRow), col: Math.max(cur?.to.col ?? 1, maxCol) };
    const from = cur?.from ?? { row: 1, col: 1 };
    dim.setAttribute('ref', `${colName(from.col)}${from.row}:${colName(to.col)}${to.row}`);
  }
}

/** 수식 계산 체인을 지우고, 파일을 열 때 다시 계산하게 한다. */
function markRecalc(files: Files): void {
  const wb = parseDoc(files, 'xl/workbook.xml');
  const root = wb.documentElement!;
  let calcPr = kid(root, 'calcPr');
  if (!calcPr) {
    calcPr = maker(wb)('calcPr');
    const before = ['oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst']
      .map((n) => kid(root, n))
      .find(Boolean);
    root.insertBefore(calcPr, before ?? null);
  }
  calcPr.setAttribute('fullCalcOnLoad', '1');
  files['xl/workbook.xml'] = serialize(wb);

  if (files['xl/calcChain.xml']) {
    delete files['xl/calcChain.xml'];
    const ct = parseDoc(files, '[Content_Types].xml');
    for (const o of deep(ct, 'Override')) {
      if (o.getAttribute('PartName') === '/xl/calcChain.xml') o.parentNode?.removeChild(o);
    }
    files['[Content_Types].xml'] = serialize(ct);
    const relsPath = 'xl/_rels/workbook.xml.rels';
    if (files[relsPath]) {
      const rels = parseDoc(files, relsPath);
      for (const r of deep(rels, 'Relationship')) {
        if ((r.getAttribute('Target') ?? '').endsWith('calcChain.xml')) r.parentNode?.removeChild(r);
      }
      files[relsPath] = serialize(rels);
    }
  }
}

/** 원본 + 고친 셀 → 새 XLSX 바이트 */
export function patchXlsx(baseBytes: Uint8Array, model: WorkbookModel, edits: Edits): Uint8Array {
  const files = unzip(baseBytes);
  const any = [...edits.values()].some((m) => m.size > 0);
  if (!any) return baseBytes;

  const calc = new Calculator(model, (si, addr) => edits.get(si)?.get(addr) ?? model.sheets[si]?.cells[addr]);
  model.sheets.forEach((sheet, si) => {
    const sheetEdits = edits.get(si) ?? new Map<string, CellInput>();
    const hasFormula = Object.values(sheet.cells).some((c) => c.f !== undefined);
    if (!sheetEdits.size && !hasFormula) return;
    const doc = parseDoc(files, sheet.path);
    patchSheet(doc, si, sheetEdits, model, calc);
    files[sheet.path] = serialize(doc);
  });
  markRecalc(files);
  return zipSync(files, { level: 6 });
}

export interface XlsxDiff {
  sheet: number;
  addr: string;
  want: string;
  got: string;
}

const describe = (c: CellInput | BaseCell | undefined): string => {
  if (!c || c.t === 'z') return '';
  if (c.t === 'f') return `=${c.f}`;
  if ('f' in c && c.f !== undefined) return `=${c.f}`;
  return `${c.t}:${String(c.v)}`;
};

/** 저장 검사: 만든 파일을 다시 읽어 고친 셀이 그대로 들어 있는지 확인한다. */
export function verifyXlsx(bytes: Uint8Array, edits: Edits): XlsxDiff[] {
  const model = parseXlsx(bytes);
  const diffs: XlsxDiff[] = [];
  for (const [si, m] of edits) {
    for (const [addr, input] of m) {
      const got = model.sheets[si]?.cells[addr];
      const want = describe(input);
      const have = got && (got.v !== '' || got.f !== undefined) ? describe(got) : '';
      if (want !== have) diffs.push({ sheet: si, addr, want, got: have });
    }
  }
  return diffs;
}

/** 빈 통합 문서 */
export function blankXlsx(): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetFormatPr defaultRowHeight="16.5"/><sheetData/></worksheet>',
    ),
    'xl/styles.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="맑은 고딕"/><family val="3"/><charset val="129"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="표준" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    ),
  };
  return zipSync(files, { level: 6 });
}
