// 시험용 XLSX: 서식, 병합, 공유 수식, 시트 간 참조, 한글 시트 이름
import ExcelJS from 'exceljs';

export async function sampleXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('예산');
  ws.columns = [{ width: 14 }, { width: 12 }, { width: 12 }, { width: 14 }];
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = '2027년 부서별 예산';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.addRow(['부서', '상반기', '하반기', '합계']);
  ws.getRow(2).font = { bold: true };
  ws.getRow(2).eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
  });
  const rows: [string, number, number][] = [
    ['총무과', 1200000, 1300000],
    ['기획과', 800000, 950000],
    ['정보과', 2100000, 1900000],
  ];
  rows.forEach(([name, a, b], i) => {
    const r = 3 + i;
    ws.getCell(`A${r}`).value = name;
    ws.getCell(`B${r}`).value = a;
    ws.getCell(`C${r}`).value = b;
    ws.getCell(`D${r}`).value = i === 0 ? { formula: `B${r}+C${r}`, result: a + b } : { sharedFormula: 'D3', result: a + b };
    for (const col of ['B', 'C', 'D']) ws.getCell(`${col}${r}`).numFmt = '#,##0';
  });
  ws.getCell('A6').value = '총계';
  ws.getCell('D6').value = { formula: 'SUM(D3:D5)', result: 8250000 };
  ws.getCell('D6').numFmt = '#,##0';
  ws.getCell('A7').value = '정보과 비율';
  ws.getCell('D7').value = { formula: 'D5/D6', result: 4000000 / 8250000 };
  ws.getCell('D7').numFmt = '0.0%';

  const s2 = wb.addWorksheet('요약');
  s2.getCell('A1').value = '예산 총계';
  s2.getCell('B1').value = { formula: "'예산'!D6", result: 8250000 };
  s2.getCell('A2').value = '작성일';
  s2.getCell('B2').value = new Date(Date.UTC(2026, 10, 21));
  s2.getCell('B2').numFmt = 'yyyy-mm-dd';
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** ExcelJS 로 다시 읽어 셀 값을 꺼낸다 (우리 코드와 다른 해석기로 확인) */
export async function readWithExcelJS(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  return wb;
}
