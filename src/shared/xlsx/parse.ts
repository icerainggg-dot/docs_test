// XLSX 해석: 원본 파일 → WorkbookModel (화면 표시·수식 계산·저장에 쓰는 요약)

import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import type { Element as XElement, Document as XDocument } from '@xmldom/xmldom';
import { addrOf, parseAddr, parseRange, shiftFormula } from './addr.ts';
import { builtinFormat } from './format.ts';
import type { BaseCell, BorderSide, CellStyle, SheetModel, WorkbookModel } from './types.ts';

export type Files = Record<string, Uint8Array>;

/** XLSX(zip) 인지 대강 확인 */
export function isXlsxZip(files: Files): boolean {
  return 'xl/workbook.xml' in files && '[Content_Types].xml' in files;
}

export function unzip(bytes: Uint8Array): Files {
  return unzipSync(bytes);
}

export function readXml(files: Files, path: string): XDocument | null {
  const data = files[path];
  if (!data) return null;
  return new DOMParser().parseFromString(strFromU8(data), 'text/xml');
}

/** 이름공간과 관계없이 localName 으로 찾는다 */
export function kids(el: XElement | XDocument | null | undefined, name: string): XElement[] {
  const out: XElement[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as XElement).localName === name) out.push(n as XElement);
  }
  return out;
}

export const kid = (el: XElement | XDocument | null | undefined, name: string): XElement | null => kids(el, name)[0] ?? null;

export function deep(el: XElement | XDocument | null | undefined, name: string): XElement[] {
  if (!el) return [];
  const list = el.getElementsByTagNameNS('*', name);
  const out: XElement[] = [];
  for (let i = 0; i < list.length; i++) out.push(list.item(i)!);
  return out;
}

const textOf = (el: XElement | null): string => (el ? (el.textContent ?? '') : '');

/** 관계 파일 (rels) → id: 대상 경로 */
export function readRels(files: Files, relsPath: string, baseDir: string): Record<string, string> {
  const doc = readXml(files, relsPath);
  const out: Record<string, string> = {};
  for (const r of deep(doc, 'Relationship')) {
    const id = r.getAttribute('Id');
    let target = r.getAttribute('Target') ?? '';
    if (!id || r.getAttribute('TargetMode') === 'External') continue;
    target = target.startsWith('/') ? target.slice(1) : normalize(`${baseDir}/${target}`);
    out[id] = target;
  }
  return out;
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// ── 색 ───────────────────────────────────────────────────────

// 엑셀 기본 색표 (indexed 색)
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

function applyTint(hex: string, tint: number): string {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let rr = l;
  let gg = l;
  let bb = l;
  if (s) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rr = hue(p, q, h + 1 / 3);
    gg = hue(p, q, h);
    bb = hue(p, q, h - 1 / 3);
  }
  const x = (v: number): string => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `${x(rr)}${x(gg)}${x(bb)}`.toUpperCase();
}

function readTheme(files: Files, workbookRels: Record<string, string>): string[] {
  const path = Object.values(workbookRels).find((p) => /theme\/theme\d*\.xml$/.test(p)) ?? 'xl/theme/theme1.xml';
  const doc = readXml(files, path);
  const scheme = deep(doc, 'clrScheme')[0];
  const byName: Record<string, string> = {};
  for (let n = scheme?.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const el = n as XElement;
    const c = kid(el, 'srgbClr')?.getAttribute('val') ?? kid(el, 'sysClr')?.getAttribute('lastClr');
    if (c) byName[el.localName ?? ''] = c.toUpperCase();
  }
  // 엑셀의 테마 번호는 밝은색/어두운색 순서가 바뀌어 있다.
  return ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(
    (k, i) => byName[k] ?? (i === 1 ? '000000' : i === 0 ? 'FFFFFF' : '808080'),
  );
}

function colorOf(el: XElement | null, theme: string[]): string | null {
  if (!el || el.getAttribute('auto') === '1') return null;
  let hex: string | null = null;
  const rgb = el.getAttribute('rgb');
  const th = el.getAttribute('theme');
  const ix = el.getAttribute('indexed');
  if (rgb) hex = rgb.length === 8 ? rgb.slice(2) : rgb;
  else if (th !== null && th !== '') hex = theme[Number(th)] ?? null;
  else if (ix !== null && ix !== '') hex = INDEXED[Number(ix)] ?? null;
  if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return null;
  const tint = Number(el.getAttribute('tint') || 0);
  if (tint) hex = applyTint(hex, tint);
  return `#${hex.toUpperCase()}`;
}

// ── 서식 ─────────────────────────────────────────────────────

function readStyles(files: Files, theme: string[]): CellStyle[] {
  const doc = readXml(files, 'xl/styles.xml');
  const root = doc?.documentElement ?? null;
  if (!root) return [{ numFmt: 'General' }];

  const custom: Record<number, string> = {};
  for (const n of kids(kid(root, 'numFmts'), 'numFmt')) {
    custom[Number(n.getAttribute('numFmtId'))] = n.getAttribute('formatCode') ?? 'General';
  }

  const fonts = kids(kid(root, 'fonts'), 'font').map((f) => {
    const val = (name: string): XElement | null => kid(f, name);
    const on = (name: string): boolean => {
      const e = val(name);
      return !!e && e.getAttribute('val') !== '0' && e.getAttribute('val') !== 'false';
    };
    const u = val('u');
    return {
      bold: on('b'),
      italic: on('i'),
      underline: !!u && u.getAttribute('val') !== 'none',
      strike: on('strike'),
      color: colorOf(val('color'), theme),
      size: Number(val('sz')?.getAttribute('val')) || undefined,
      font: val('name')?.getAttribute('val') ?? undefined,
    };
  });

  const fills = kids(kid(root, 'fills'), 'fill').map((f) => {
    const p = kid(f, 'patternFill');
    if (!p) return null;
    const type = p.getAttribute('patternType');
    if (!type || type === 'none') return null;
    return colorOf(kid(p, 'fgColor'), theme) ?? colorOf(kid(p, 'bgColor'), theme);
  });

  const borders = kids(kid(root, 'borders'), 'border').map((b) => {
    const side = (name: string): BorderSide | undefined => {
      const e = kid(b, name);
      const style = e?.getAttribute('style');
      if (!e || !style || style === 'none') return undefined;
      return { style, color: colorOf(kid(e, 'color'), theme) };
    };
    const out: CellStyle['border'] = {};
    const l = side('left') ?? side('start');
    const r = side('right') ?? side('end');
    const t = side('top');
    const bt = side('bottom');
    if (l) out.left = l;
    if (r) out.right = r;
    if (t) out.top = t;
    if (bt) out.bottom = bt;
    return Object.keys(out).length ? out : undefined;
  });

  const xfs = kids(kid(root, 'cellXfs'), 'xf');
  if (!xfs.length) return [{ numFmt: 'General' }];
  return xfs.map((xf) => {
    const numFmtId = Number(xf.getAttribute('numFmtId') || 0);
    const font = fonts[Number(xf.getAttribute('fontId') || 0)];
    const fill = fills[Number(xf.getAttribute('fillId') || 0)];
    const border = borders[Number(xf.getAttribute('borderId') || 0)];
    const al = kid(xf, 'alignment');
    const style: CellStyle = { numFmt: custom[numFmtId] ?? builtinFormat(numFmtId) };
    if (font) Object.assign(style, font);
    if (fill) style.fill = fill;
    if (border) style.border = border;
    if (al) {
      const h = al.getAttribute('horizontal');
      const v = al.getAttribute('vertical');
      if (h && h !== 'general') style.hAlign = h;
      if (v) style.vAlign = v;
      if (al.getAttribute('wrapText') === '1' || al.getAttribute('wrapText') === 'true') style.wrap = true;
    }
    return style;
  });
}

function readSharedStrings(files: Files, path: string | undefined): string[] {
  const doc = path ? readXml(files, path) : null;
  if (!doc?.documentElement) return [];
  return kids(doc.documentElement, 'si').map(siText);
}

/** <si> 또는 <is> 의 글자 (덧말 rPh 제외) */
export function siText(si: XElement): string {
  const direct = kid(si, 't');
  if (direct) return textOf(direct);
  return kids(si, 'r')
    .map((r) => textOf(kid(r, 't')))
    .join('');
}

// ── 시트 ─────────────────────────────────────────────────────

const widthToPx = (w: number): number => Math.max(0, Math.round(w * 7 + 5));
const ptToPx = (pt: number): number => Math.max(0, Math.round((pt * 96) / 72));

function readSheet(files: Files, name: string, path: string, hidden: boolean, strings: string[]): SheetModel {
  const doc = readXml(files, path);
  const root = doc?.documentElement ?? null;
  const fmt = kid(root, 'sheetFormatPr');
  const baseW = Number(fmt?.getAttribute('baseColWidth') || 8);
  const defW = Number(fmt?.getAttribute('defaultColWidth')) || baseW + 0.71;
  const sheet: SheetModel = {
    name,
    path,
    hidden,
    maxRow: 0,
    maxCol: 0,
    colWidths: {},
    rowHeights: {},
    defaultColWidth: widthToPx(defW),
    defaultRowHeight: ptToPx(Number(fmt?.getAttribute('defaultRowHeight')) || 15),
    merges: [],
    cells: {},
  };

  for (const c of kids(kid(root, 'cols'), 'col')) {
    const min = Number(c.getAttribute('min'));
    const max = Math.min(Number(c.getAttribute('max')), min + 1000); // 끝없는 범위 방지
    const hiddenCol = c.getAttribute('hidden') === '1' || c.getAttribute('hidden') === 'true';
    const w = hiddenCol ? 0 : widthToPx(Number(c.getAttribute('width') || defW));
    for (let i = min; i <= max; i++) sheet.colWidths[i] = w;
  }

  const shared: Record<string, { f: string; row: number; col: number }> = {};
  let rowNo = 0;
  for (const r of kids(kid(root, 'sheetData'), 'row')) {
    rowNo = Number(r.getAttribute('r')) || rowNo + 1;
    if (r.getAttribute('hidden') === '1' || r.getAttribute('hidden') === 'true') sheet.rowHeights[rowNo] = 0;
    else if (r.getAttribute('ht') && r.getAttribute('customHeight') !== '0') sheet.rowHeights[rowNo] = ptToPx(Number(r.getAttribute('ht')));
    let colNo = 0;
    for (const c of kids(r, 'c')) {
      const pos = parseAddr(c.getAttribute('r') ?? '');
      colNo = pos ? pos.col : colNo + 1;
      const addr = addrOf(rowNo, colNo);
      const t = c.getAttribute('t') ?? 'n';
      const s = c.getAttribute('s');
      const v = kid(c, 'v');
      const fEl = kid(c, 'f');
      const cell: BaseCell = { t: 'n', v: '' };
      if (s !== null && s !== '' && s !== '0') cell.s = Number(s);

      if (t === 's') cell.v = strings[Number(textOf(v))] ?? '';
      else if (t === 'inlineStr') cell.v = kid(c, 'is') ? siText(kid(c, 'is')!) : '';
      else if (t === 'str' || t === 'd') cell.v = textOf(v);
      else if (t === 'b') cell.v = textOf(v) === '1' || textOf(v) === 'true';
      else if (t === 'e') cell.v = textOf(v);
      else cell.v = v ? Number(textOf(v)) : '';
      cell.t = t === 'b' ? 'b' : t === 'e' ? 'e' : typeof cell.v === 'number' ? 'n' : 's';

      if (fEl) {
        const ft = fEl.getAttribute('t');
        const text = textOf(fEl);
        if (ft === 'shared') {
          const si = fEl.getAttribute('si') ?? '';
          if (text) {
            shared[si] = { f: text, row: rowNo, col: colNo };
            cell.f = text;
          } else if (shared[si]) {
            const m = shared[si];
            cell.f = shiftFormula(m.f, rowNo - m.row, colNo - m.col);
          }
        } else if (ft === 'array' || ft === 'dataTable') {
          if (text) cell.f = text;
          cell.arr = true;
        } else if (text) {
          cell.f = text;
        }
      }
      // 값도 서식도 수식도 없는 빈 셀은 담지 않는다.
      if (cell.v === '' && cell.f === undefined && cell.s === undefined && t !== 's' && t !== 'inlineStr' && t !== 'str') continue;
      if (cell.v === '' && cell.t === 'n') cell.t = 's';
      sheet.cells[addr] = cell;
      sheet.maxRow = Math.max(sheet.maxRow, rowNo);
      sheet.maxCol = Math.max(sheet.maxCol, colNo);
    }
  }

  for (const m of kids(kid(root, 'mergeCells'), 'mergeCell')) {
    const ref = m.getAttribute('ref');
    const rg = ref ? parseRange(ref) : null;
    if (!rg) continue;
    sheet.merges.push(ref!);
    sheet.maxRow = Math.max(sheet.maxRow, rg.to.row);
    sheet.maxCol = Math.max(sheet.maxCol, rg.to.col);
  }
  return sheet;
}

export function parseWorkbookFiles(files: Files): WorkbookModel {
  if (!isXlsxZip(files)) throw new Error('XLSX 파일이 아닙니다.');
  const wb = readXml(files, 'xl/workbook.xml');
  const rels = readRels(files, 'xl/_rels/workbook.xml.rels', 'xl');
  const theme = readTheme(files, rels);
  const relTypes = readXml(files, 'xl/_rels/workbook.xml.rels');
  let ssPath: string | undefined;
  for (const r of deep(relTypes, 'Relationship')) {
    if ((r.getAttribute('Type') ?? '').endsWith('/sharedStrings')) ssPath = rels[r.getAttribute('Id') ?? ''];
  }
  const strings = readSharedStrings(files, ssPath ?? 'xl/sharedStrings.xml');
  const styles = readStyles(files, theme);

  const sheets: SheetModel[] = [];
  for (const s of deep(wb, 'sheet')) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? s.getAttribute('r:id');
    const path = rid ? rels[rid] : undefined;
    if (!path || !files[path]) continue; // 차트 시트 등은 건너뛴다
    const state = s.getAttribute('state');
    sheets.push(readSheet(files, s.getAttribute('name') ?? `Sheet${sheets.length + 1}`, path, state === 'hidden' || state === 'veryHidden', strings));
  }
  if (!sheets.length) throw new Error('편집할 수 있는 시트가 없습니다.');

  const names: Record<string, string> = {};
  for (const d of deep(wb, 'definedName')) {
    const name = d.getAttribute('name');
    if (name && !name.startsWith('_xlnm.') && d.getAttribute('localSheetId') === null) names[name.toUpperCase()] = textOf(d);
  }
  const pr = deep(wb, 'workbookPr')[0];
  const date1904 = pr?.getAttribute('date1904') === '1' || pr?.getAttribute('date1904') === 'true';
  return { sheets, styles, names, date1904 };
}

export function parseXlsx(bytes: Uint8Array): WorkbookModel {
  return parseWorkbookFiles(unzip(bytes));
}
