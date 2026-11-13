import { expect, test } from 'bun:test'
import { type CodeEntry, codeIdentityDigest } from './dispatch-runtime-dependencies'

test('code identity is independent of entry order and sensitive to every recorded fact', () => {
  const entries: CodeEntry[] = [
    { path: '', kind: 'directory' },
    { path: 'a', kind: 'directory' },
    { path: 'a/b', kind: 'file', executable: 0, sha256: '1'.repeat(64) },
    { path: 'a.b', kind: 'file', executable: 0, sha256: '2'.repeat(64) },
    { path: 'a/link', kind: 'link', target: 'b' },
  ]
  const identity = codeIdentityDigest(entries)
  expect(codeIdentityDigest([...entries].reverse())).toBe(identity)
  expect(
    codeIdentityDigest([entries[3]!, entries[1]!, entries[4]!, entries[0]!, entries[2]!]),
  ).toBe(identity)
  const changed = (index: number, entry: CodeEntry) =>
    codeIdentityDigest(entries.map((current, at) => (at === index ? entry : current)))
  expect(changed(2, { path: 'a/c', kind: 'file', executable: 0, sha256: '1'.repeat(64) })).not.toBe(
    identity,
  )
  expect(
    changed(2, { path: 'a/b', kind: 'file', executable: 0o111, sha256: '1'.repeat(64) }),
  ).not.toBe(identity)
  expect(changed(2, { path: 'a/b', kind: 'file', executable: 0, sha256: '3'.repeat(64) })).not.toBe(
    identity,
  )
  expect(changed(4, { path: 'a/link', kind: 'link', target: 'c' })).not.toBe(identity)
  expect(changed(4, { path: 'a/link', kind: 'directory' })).not.toBe(identity)
  // Swapping which of `a/b` and `a.b` holds which bytes is a different tree.
  expect(
    codeIdentityDigest([
      entries[0]!,
      entries[1]!,
      { ...entries[2]!, path: 'a.b' } as CodeEntry,
      { ...entries[3]!, path: 'a/b' } as CodeEntry,
      entries[4]!,
    ]),
  ).not.toBe(identity)
})
