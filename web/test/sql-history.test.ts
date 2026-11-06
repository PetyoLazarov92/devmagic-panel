import { describe, expect, it } from 'vitest';
import { addHistory, clearHistory, readHistory, SQL_HISTORY_MAX, toCsv } from '../src/lib/sql-history';

function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

describe('SQL history', () => {
  it('keeps the newest 30 per database, without copies', () => {
    const store = memory();
    for (let i = 0; i < 35; i++) addHistory('shop_com', `SELECT ${i}`, store);
    addHistory('shop_com', ' SELECT 3 ', store);
    const list = readHistory('shop_com', store);
    expect(list).toHaveLength(SQL_HISTORY_MAX);
    expect(list[0]).toBe('SELECT 3');
    expect(list.filter((s) => s === 'SELECT 3')).toHaveLength(1);
    expect(readHistory('reports', store)).toEqual([]);
    clearHistory('shop_com', store);
    expect(readHistory('shop_com', store)).toEqual([]);
  });

  it('works without storage, and with storage that refuses', () => {
    expect(addHistory('shop_com', 'SELECT 1', null)).toEqual(['SELECT 1']);
    const refusing = { getItem: () => 'not json', setItem: () => { throw new Error('full'); }, removeItem: () => undefined };
    expect(addHistory('shop_com', 'SELECT 1', refusing)).toEqual(['SELECT 1']);
  });
});

describe('CSV', () => {
  it('quotes what needs it and writes NULL as an empty field, an empty text as ""', () => {
    expect(toCsv(['id', 'v'], [['1', 'a,b'], ['2', 'say "hi"'], ['3', null], ['4', ''], ['5', 'line\nbreak']])).toBe('id,v\r\n1,"a,b"\r\n2,"say ""hi"""\r\n3,\r\n4,""\r\n5,"line\nbreak"\r\n');
  });
});
