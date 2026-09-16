export interface TableCell {
  text: string | null;
  truncated: boolean;
}
export interface TablePage {
  path: string;
  format: 'csv' | 'tsv' | 'jsonl';
  identity: string;
  sizeBytes: number;
  rowStart: number;
  columns: Array<{ name: string; types: string[]; truncated: boolean }>;
  rows: TableCell[][];
  nextCursor: string | null;
  columnsOmitted: number;
  cellsTruncated: number;
  schemaScope: 'page';
}
