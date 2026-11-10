declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): { run(...values: unknown[]): { changes: number; lastInsertRowid: number | bigint }; get(...values: unknown[]): Record<string, unknown> | undefined; all(...values: unknown[]): Record<string, unknown>[] };
    close(): void;
  }
}
