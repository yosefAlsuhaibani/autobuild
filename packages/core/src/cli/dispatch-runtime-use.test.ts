import { expect, test } from 'bun:test'
import { withMemoEntry } from './dispatch-runtime-use'

test('a memo entry moves to the front, replaces its key and the list stays bounded', () => {
  const entry = (key: string, value = key) => ({ key: key.repeat(64), value })
  const entries = [entry('a'), entry('b'), entry('c')]
  expect(withMemoEntry(entries, entry('c', 'new'), 3)).toEqual([
    entry('c', 'new'),
    entry('a'),
    entry('b'),
  ])
  expect(withMemoEntry(entries, entry('d'), 3)).toEqual([entry('d'), entry('a'), entry('b')])
  expect(withMemoEntry([], entry('a'), 1)).toEqual([entry('a')])
  expect(entries).toEqual([entry('a'), entry('b'), entry('c')])
})
