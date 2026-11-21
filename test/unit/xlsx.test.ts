import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { unzipSync, strFromU8 } from 'fflate';
import { sampleXlsx, readWithExcelJS } from './xlsx-sample.ts';
import { parseXlsx } from '../../src/shared/xlsx/parse.ts';
import { patchXlsx, verifyXlsx, blankXlsx } from '../../src/shared/xlsx/write.ts';
import type { Edits } from '../../src/shared/xlsx/write.ts';
import { Calculator } from '../../src/shared/xlsx/calc.ts';
import { formatValue, parseInput, inputText } from '../../src/shared/xlsx/format.ts';
import { shiftFormula, parseRange, colName, colNumber } from '../../src/shared/xlsx/addr.ts';
import { CELLS, cellKey } from '../../src/shared/xlsx/types.ts';
import type { CellInput } from '../../src/shared/xlsx/types.ts';
import { editsFromYDoc } from '../../src/shared/xlsx/sheetdoc.ts';

const base = await sampleXlsx();

test('주소·수식 옮기기 도우미', () => {
  assert.equal(colName(1), 'A');
  assert.equal(colName(28), 'AB');
  assert.equal(colNumber('AB'), 28);
  assert.deepEqual(parseRange('C3:A1'), { from: { row: 1, col: 1 }, to: { row: 3, col: 3 } });
  assert.equal(shiftFormula('B3+C3', 2, 0), 'B5+C5');
  assert.equal(shiftFormula('SUM($B$3:B3)*LOG10(A1)&"B3"', 1, 1), 'SUM($B$3:C4)*LOG10(B2)&"B3"');
  assert.equal(shiftFormula("'시트 B3'!A1+A1", 1, 0), "'시트 B3'!A2+A2");
});

test('입력 해석과 숫자 서식', () => {
  assert.deepEqual(parseInput('1,234.5'), { t: 'n', v: 1234.5 });
  assert.deepEqual(parseInput('12%'), { t: 'n', v: 0.12 });
  assert.deepEqual(parseInput('=SUM(A1:A3)'), { t: 'f', f: 'SUM(A1:A3)' });
  assert.deepEqual(parseInput("'007"), { t: 's', v: '007' });
  assert.deepEqual(parseInput('true'), { t: 'b', v: true });
  assert.deepEqual(parseInput('서울'), { t: 's', v: '서울' });
  assert.deepEqual(parseInput(''), { t: 'z' });
  assert.equal(inputText({ t: 'f', f: 'A1*2' }), '=A1*2');
  assert.equal(formatValue(2500000, '#,##0'), '2,500,000');
  assert.equal(formatValue(0.4848, '0.0%'), '48.5%');
  assert.equal(formatValue(46347, 'yyyy-mm-dd'), '2026-11-21');
  assert.equal(formatValue({ error: '#DIV/0!' }), '#DIV/0!');
});

test('XLSX 해석: 시트·서식·병합·공유 수식', () => {
  const m = parseXlsx(base);
  assert.deepEqual(m.sheets.map((s) => s.name), ['예산', '요약']);
  const s = m.sheets[0]!;
  assert.deepEqual(s.merges, ['A1:D1']);
  assert.equal(s.cells.A1?.v, '2027년 부서별 예산');
  assert.equal(m.styles[s.cells.A1!.s!]?.bold, true);
  assert.equal(m.styles[s.cells.B3!.s!]?.numFmt, '#,##0');
  assert.equal(s.cells.B3?.v, 1200000);
  assert.equal(s.cells.D4?.f, 'B4+C4', '공유 수식을 셀마다 펼친다');
  assert.equal(s.cells.D5?.f, 'B5+C5');
  assert.equal(s.cells.D6?.f, 'SUM(D3:D5)');
  assert.ok((s.colWidths[1] ?? 0) > s.defaultColWidth);
  assert.equal(m.styles[m.sheets[0]!.cells.B2!.s!]?.fill, '#DDEBF7');
});

test('수식 계산: 고친 값이 시트를 건너 퍼진다', () => {
  const m = parseXlsx(base);
  const edits = new Map<string, CellInput>();
  const calc = new Calculator(m, (si, addr) => edits.get(`${si}:${addr}`) ?? m.sheets[si]?.cells[addr]);
  assert.equal(calc.value(0, 'D6'), 8250000);
  assert.equal(calc.value(1, 'B1'), 8250000);
  edits.set('0:B5', { t: 'n', v: 3100000 });
  calc.invalidate();
  assert.equal(calc.value(0, 'D5'), 5000000);
  assert.equal(calc.value(0, 'D6'), 9250000);
  assert.equal(calc.value(1, 'B1'), 9250000);
  edits.set('0:E1', { t: 'f', f: 'E1+1' });
  calc.invalidate();
  assert.deepEqual(calc.value(0, 'E1'), { error: '#CYCLE!' });
  edits.set('0:E2', { t: 'f', f: 'NOSUCHFN(1)' });
  calc.invalidate();
  assert.deepEqual(calc.value(0, 'E2'), { error: '#NAME?' });
});

test('XLSX 저장: 고친 셀만 바뀌고 다른 프로그램(ExcelJS)으로도 열린다', async () => {
  const m = parseXlsx(base);
  const edits: Edits = new Map([
    [
      0,
      new Map<string, CellInput>([
        ['B5', { t: 'n', v: 3100000 }],
        ['A4', { t: 's', v: '기획예산과 <특별> & "팀"' }],
        ['E2', { t: 's', v: '비고' }],
        ['E3', { t: 'f', f: 'D3*0.1' }],
        ['A7', { t: 'z' }],
        ['F10', { t: 'b', v: true }],
      ]),
    ],
  ]);
  const out = patchXlsx(base, m, edits);
  assert.deepEqual(verifyXlsx(out, edits), []);

  const re = parseXlsx(out);
  const s = re.sheets[0]!;
  assert.equal(s.cells.B5?.v, 3100000);
  assert.equal(s.cells.B5?.s, m.sheets[0]!.cells.B5?.s, '셀 서식은 그대로');
  assert.equal(s.cells.D5?.f, 'B5+C5', '공유 수식은 풀어 쓴다');
  assert.equal(s.cells.D5?.v, 5000000, '다른 셀이 바뀌면 수식 결과(캐시)도 고친다');
  assert.equal(s.cells.D6?.v, 9250000);
  assert.equal(s.cells.E3?.v, 250000);
  assert.equal(s.cells.A7, undefined);
  assert.equal(re.sheets[1]!.cells.B1?.v, 9250000, '다른 시트의 수식도 고친다');
  assert.deepEqual(s.merges, ['A1:D1'], '병합은 그대로');

  const wb = await readWithExcelJS(out);
  const ws = wb.getWorksheet('예산')!;
  assert.equal(ws.getCell('A4').value, '기획예산과 <특별> & "팀"');
  assert.equal(ws.getCell('B5').value, 3100000);
  assert.equal(ws.getCell('B5').numFmt, '#,##0');
  const d6 = ws.getCell('D6').value as { formula: string; result: number };
  assert.equal(d6.formula, 'SUM(D3:D5)');
  assert.equal(d6.result, 9250000);
  assert.equal(ws.getCell('F10').value, true);
  const files = unzipSync(out);
  assert.match(strFromU8(files['xl/workbook.xml']!), /<calcPr[^>]*fullCalcOnLoad="1"/, '열 때 다시 계산하도록 표시');
  assert.equal(files['xl/calcChain.xml'], undefined, '계산 체인은 지워 엑셀이 다시 만들게 한다');
});

test('Y 문서의 고친 셀을 시트별로 모은다', () => {
  const ydoc = new Y.Doc();
  const cells = ydoc.getMap<CellInput>(CELLS);
  cells.set(cellKey(0, 'B3'), { t: 'n', v: 1 });
  cells.set(cellKey(1, 'A1'), { t: 's', v: 'x' });
  cells.set('잘못된열쇠', { t: 'n', v: 1 });
  const edits = editsFromYDoc(ydoc, 2);
  assert.deepEqual([...edits.keys()].sort(), [0, 1]);
  assert.deepEqual(edits.get(0)?.get('B3'), { t: 'n', v: 1 });
});

test('빈 통합 문서를 만들고 고칠 수 있다', async () => {
  const blank = blankXlsx();
  const m = parseXlsx(blank);
  assert.equal(m.sheets.length, 1);
  const edits: Edits = new Map([[0, new Map<string, CellInput>([['A1', { t: 's', v: '안녕' }], ['B2', { t: 'f', f: 'LEN(A1)' }]])]]);
  const out = patchXlsx(blank, m, edits);
  assert.deepEqual(verifyXlsx(out, edits), []);
  const ws = (await readWithExcelJS(out)).worksheets[0]!;
  assert.equal(ws.getCell('A1').value, '안녕');
  assert.equal((ws.getCell('B2').value as { result: number }).result, 2);
});
