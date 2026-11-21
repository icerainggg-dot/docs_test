// 타입 정의가 없는 라이브러리의 최소 선언

declare module 'fast-formula-parser' {
  export interface CellRef {
    sheet: string;
    row: number;
    col: number;
  }
  export interface RangeRef {
    sheet: string;
    from: { row: number; col: number };
    to: { row: number; col: number };
  }
  export interface ParserOptions {
    onCell?: (ref: CellRef) => unknown;
    onRange?: (ref: RangeRef) => unknown[][];
    onVariable?: (name: string, sheet: string) => CellRef | RangeRef | null;
    functions?: Record<string, (...args: unknown[]) => unknown>;
  }
  export class FormulaError extends Error {
    constructor(error: string, msg?: string);
    readonly error: string;
  }
  /** CommonJS 패키지라 이름 있는 내보내기는 기본 내보내기의 정적 속성으로만 쓴다. */
  export default class FormulaParser {
    constructor(options: ParserOptions);
    parse(formula: string, position: CellRef, allowReturnArray?: boolean): unknown;
    static FormulaError: typeof FormulaError;
  }
}

declare module 'fast-formula-parser/ssf/ssf.js' {
  const SSF: {
    format(fmt: string | number, value: unknown, opts?: object): string;
    is_date(fmt: string): boolean;
    get_table(): Record<number, string>;
    load(fmt: string, idx?: number): number;
  };
  export default SSF;
}
