import { isBuiltin } from 'node:module'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
  copyFile,
  chmod,
  symlink,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'

export type Manifest = {
  name?: string
  version?: string
  files?: string[]
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}
export const excludedSnapshotNames = new Set(['node_modules', '.git', '.autobuild', '.ab', '.env'])
const dependencyExclusions = new Set(['node_modules'])
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
export async function readManifest(root: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
}
export async function installedPackage(name: string, start: string): Promise<string | undefined> {
  if (!/^(@[^/]+\/)?[^/]+$/.test(name) || name.includes('..'))
    throw new Error(`invalid dependency name ${name}`)
  let current = resolve(start)
  for (;;) {
    try {
      return await realpath(join(current, 'node_modules', name))
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** The effects of writing a snapshot. Reads always come from the real source. */
export interface SnapshotWriter {
  /** Recursive: creates missing ancestors and accepts an existing directory. */
  mkdir(path: string): Promise<unknown>
  chmod(path: string, mode: number): Promise<void>
  copyFile(source: string, target: string): Promise<void>
  symlink(text: string, path: string): Promise<void>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
}
export const filesystemWriter: SnapshotWriter = {
  mkdir: (path) => mkdir(path, { recursive: true }),
  chmod: (path, mode) => chmod(path, mode),
  copyFile: (source, target) => copyFile(source, target),
  symlink: (text, path) => symlink(text, path),
  writeFile: (path, data) => writeFile(path, data),
}

/** Independent bytes, never hardlinks. Package-internal links are normalized;
 * an escaping asset link is rejected rather than silently following a checkout. */
export async function copySnapshotTree(
  source: string,
  target: string,
  boundary = source,
  stack = new Set<string>(),
  exclusions = excludedSnapshotNames,
  writer = filesystemWriter,
): Promise<void> {
  const actual = await realpath(source)
  if (!inside(boundary, actual))
    throw new Error(`snapshot link escapes package: ${source} -> ${actual}`)
  if (stack.has(actual)) throw new Error(`cyclic snapshot asset link: ${source}`)
  const sourceStat = await lstat(source)
  if (sourceStat.isSymbolicLink()) {
    const mapped = resolve(target, relative(source, actual))
    await writer.mkdir(dirname(target))
    await writer.symlink(relative(dirname(target), mapped), target)
    return
  }
  const stat = await lstat(actual)
  if (stat.isDirectory()) {
    await writer.mkdir(target)
    const next = new Set(stack).add(actual)
    for (const name of (await readdir(actual)).sort()) {
      if (exclusions.has(name) || (exclusions.has('.env') && name.startsWith('.env.'))) continue
      await copySnapshotTree(
        join(actual, name),
        join(target, name),
        boundary,
        next,
        exclusions,
        writer,
      )
    }
    await writer.chmod(target, stat.mode & 0o777)
  } else if (stat.isFile()) {
    await writer.mkdir(dirname(target))
    await writer.copyFile(actual, target)
    await writer.chmod(target, stat.mode & 0o777)
  } else throw new Error(`unsupported snapshot asset: ${source}`)
}

/** Large trees are walked with synchronous calls, which cost far less per file
 * than promises; the walk still hands the event loop back every few ms. */
function pacer(): () => Promise<void> | undefined {
  let last = performance.now()
  return () => {
    if (performance.now() - last < 10) return undefined
    return new Promise<void>((done) => setImmediate(done)).then(() => {
      last = performance.now()
    })
  }
}

/** Digest includes names, executable bits, bytes and internal link topology. */
export async function treeDigest(
  root: string,
  exclude = new Set<string>(),
  allowedLink?: string,
): Promise<string> {
  const hash = createHash('sha256')
  const pause = pacer()
  // Depth-first and pre-order with sorted children, exactly as a recursive walk.
  const pending = [root]
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    const rel = relative(root, path)
    const stat = lstatSync(path)
    hash.update(JSON.stringify([rel, stat.mode & 0o111]))
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path)
      if (
        !inside(root, resolve(dirname(path), link)) &&
        resolve(dirname(path), link) !== allowedLink
      )
        throw new Error(`snapshot link escapes runtime: ${path}`)
      const actual = realpathSync(path)
      if (!inside(root, actual) && actual !== allowedLink)
        throw new Error(`snapshot link escapes runtime: ${path}`)
      hash.update(`link:${relative(dirname(path), actual)}`)
    } else if (stat.isDirectory()) {
      hash.update('directory')
      const names = readdirSync(path).sort()
      for (let index = names.length - 1; index >= 0; index--)
        if (!exclude.has(names[index]!)) pending.push(join(path, names[index]!))
    } else if (stat.isFile()) {
      hash.update('file')
      hash.update(readFileSync(path))
    } else throw new Error(`unsupported snapshot file: ${path}`)
    const paused = pause()
    if (paused) await paused
  }
  return hash.digest('hex')
}

/** One entry of a code tree; `path` is root-relative, `''` for the root. */
export type CodeEntry =
  | { path: string; kind: 'directory' }
  | { path: string; kind: 'file'; executable: number; sha256: string }
  | { path: string; kind: 'link'; target: string }

function comparePaths(a: string, b: string): number {
  const left = a ? a.split('/') : []
  const right = b ? b.split('/') : []
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
  return left.length - right.length
}

/** Order-independent identity of a code tree. Directory modes are excluded:
 * parents created on demand take the umask, and they are not packaged content. */
export function codeIdentityDigest(entries: Iterable<CodeEntry>): string {
  const hash = createHash('sha256').update('autobuild-runtime-code-v1')
  for (const entry of [...entries].sort((a, b) => comparePaths(a.path, b.path)))
    hash.update(
      `${JSON.stringify(
        entry.kind === 'file'
          ? [entry.path, entry.kind, entry.executable, entry.sha256]
          : entry.kind === 'link'
            ? [entry.path, entry.kind, entry.target]
            : [entry.path, entry.kind],
      )}\n`,
    )
  return hash.digest('hex')
}

/** Entries of the materialized tree at `start` (root-relative), recording link
 * text rather than following it. Names in `excludeAtRoot` are skipped only
 * directly under the root, where a runtime keeps its dependency layer. */
export async function codeEntries(
  root: string,
  start = '',
  excludeAtRoot: ReadonlySet<string> = new Set(),
): Promise<CodeEntry[]> {
  const entries: CodeEntry[] = []
  const pause = pacer()
  const pending = [start]
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    const absolute = join(root, path)
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) entries.push({ path, kind: 'link', target: readlinkSync(absolute) })
    else if (stat.isDirectory()) {
      entries.push({ path, kind: 'directory' })
      for (const name of readdirSync(absolute))
        if (path || !excludeAtRoot.has(name)) pending.push(path ? `${path}/${name}` : name)
    } else if (stat.isFile())
      entries.push({
        path,
        kind: 'file',
        executable: stat.mode & 0o111,
        sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      })
    else throw new Error(`unsupported snapshot file: ${absolute}`)
    const paused = pause()
    if (paused) await paused
  }
  return entries
}

export async function codeIdentity(
  root: string,
  excludeAtRoot?: ReadonlySet<string>,
): Promise<string> {
  return codeIdentityDigest(await codeEntries(root, '', excludeAtRoot))
}

type ModelNode =
  | { kind: 'directory' }
  | { kind: 'file'; executable: number; sha256: string }
  | { kind: 'link'; target: string }

/** Records what a snapshot writer would produce under `root`, mirroring the
 * filesystem's effects (including link following) without writing anything. */
export class SnapshotModel implements SnapshotWriter {
  private readonly nodes = new Map<string, ModelNode>()
  constructor(private readonly root: string) {}

  private components(path: string): string[] {
    if (!inside(this.root, path)) throw new Error(`snapshot model path escapes root: ${path}`)
    const rel = relative(this.root, path)
    return rel ? rel.split('/') : []
  }
  /** The model key a path names, following model links like path resolution. */
  private locate(path: string, followLast: boolean): string {
    let pending = this.components(path)
    let current: string[] = []
    for (let hops = 0; pending.length; ) {
      const [name, ...rest] = pending as [string, ...string[]]
      const node = this.nodes.get([...current, name].join('/'))
      if (node?.kind === 'link' && (rest.length || followLast)) {
        if (++hops > 40) throw new Error(`snapshot model link loop: ${path}`)
        pending = [...this.components(resolve(this.root, ...current, node.target)), ...rest]
        current = []
        continue
      }
      if (node && node.kind !== 'directory' && rest.length)
        throw new Error(`snapshot model path crosses a non-directory: ${path}`)
      current.push(name)
      pending = rest
    }
    return current.join('/')
  }
  private parentDirectory(key: string, path: string): void {
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : key ? '' : undefined
    if (parent !== undefined && this.nodes.get(parent)?.kind !== 'directory')
      throw new Error(`snapshot model parent is not a directory: ${path}`)
  }
  async mkdir(path: string): Promise<void> {
    const key = this.locate(path, true)
    if (!this.nodes.has(key) && this.nodes.get(this.locate(path, false))?.kind === 'link')
      throw new Error(`snapshot model path exists: ${path}`)
    const parts = key ? key.split('/') : []
    for (let length = 0; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join('/')
      const node = this.nodes.get(prefix)
      if (!node) this.nodes.set(prefix, { kind: 'directory' })
      else if (node.kind !== 'directory')
        throw new Error(`snapshot model path is not a directory: ${path}`)
    }
  }
  async chmod(path: string, mode: number): Promise<void> {
    const node = this.nodes.get(this.locate(path, true))
    if (!node) throw new Error(`snapshot model path is missing: ${path}`)
    if (node.kind === 'file') node.executable = mode & 0o111
  }
  async copyFile(source: string, target: string): Promise<void> {
    const key = this.locate(target, true)
    this.parentDirectory(key, target)
    if (this.nodes.get(key)?.kind === 'directory')
      throw new Error(`snapshot model target is a directory: ${target}`)
    this.nodes.set(key, {
      kind: 'file',
      executable: lstatSync(source).mode & 0o111,
      sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    })
  }
  async symlink(text: string, path: string): Promise<void> {
    const key = this.locate(path, false)
    this.parentDirectory(key, path)
    if (this.nodes.has(key)) throw new Error(`snapshot model path exists: ${path}`)
    this.nodes.set(key, { kind: 'link', target: text })
  }
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const key = this.locate(path, true)
    this.parentDirectory(key, path)
    const existing = this.nodes.get(key)
    if (existing?.kind === 'directory')
      throw new Error(`snapshot model target is a directory: ${path}`)
    this.nodes.set(key, {
      kind: 'file',
      executable: existing?.kind === 'file' ? existing.executable : 0,
      sha256: createHash('sha256').update(data).digest('hex'),
    })
  }
  /** Identity of the modeled tree, comparable with `codeIdentity` of a written one. */
  identity(): string {
    return codeIdentityDigest([...this.nodes].map(([path, node]) => ({ path, ...node })))
  }
}

export interface DependencyGraph {
  roots: Record<string, number>
  packages: Array<{
    source: string
    manifest: Manifest
    edges: Record<string, number>
    digest: string
  }>
  fingerprint: string
}
export async function scanDependencies(
  root: string,
  options: { dev?: boolean; coreRoot?: string; manifest?: Manifest } = {},
): Promise<DependencyGraph> {
  const packages: DependencyGraph['packages'] = []
  const ids = new Map<string, number>()
  async function edges(
    source: string,
    manifest: Manifest,
    dev = false,
  ): Promise<Record<string, number>> {
    const result: Record<string, number> = {}
    const names = {
      ...(dev ? manifest.devDependencies : {}),
      ...manifest.peerDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }
    for (const name of Object.keys(names).sort()) {
      if (name === '@defrex/autobuild' && options.coreRoot) continue
      const found = await installedPackage(name, source)
      if (!found) {
        if (
          Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
          manifest.peerDependenciesMeta?.[name]?.optional ||
          (dev &&
            !Object.hasOwn(manifest.dependencies ?? {}, name) &&
            !Object.hasOwn(manifest.peerDependencies ?? {}, name))
        )
          continue
        throw new Error(
          `missing installed dependency ${name} required by ${source}; repair the Autobuild installation before dispatch`,
        )
      }
      let id = ids.get(found)
      if (id === undefined) {
        id = packages.length
        ids.set(found, id)
        const entry = {
          source: found,
          manifest: await readManifest(found),
          edges: {},
          digest: await treeDigest(found, dependencyExclusions),
        }
        packages.push(entry)
        entry.edges = await edges(found, entry.manifest)
      }
      result[name] = id
    }
    return result
  }
  const roots = await edges(root, options.manifest ?? (await readManifest(root)), options.dev)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ roots, packages: packages.map(({ source: _, ...rest }) => rest) }))
    .digest('hex')
  return { roots, packages, fingerprint }
}
export async function copyDependencies(
  graph: DependencyGraph,
  target: string,
  coreRoot?: string,
): Promise<void> {
  await mkdir(join(target, 'node_modules'), { recursive: true })
  const packagePath = (id: number) => join(target, 'node_modules', '.ab-packages', String(id))
  async function links(root: string, edges: Record<string, number>) {
    for (const [name, id] of Object.entries(edges)) {
      const link = join(root, 'node_modules', name)
      await mkdir(dirname(link), { recursive: true })
      await symlink(relative(dirname(link), packagePath(id)), link)
    }
    if (coreRoot) {
      const link = join(root, 'node_modules', '@defrex', 'autobuild')
      await mkdir(dirname(link), { recursive: true })
      await symlink(relative(dirname(link), coreRoot), link)
    }
  }
  for (const [id, entry] of graph.packages.entries()) {
    await copySnapshotTree(
      entry.source,
      packagePath(id),
      entry.source,
      new Set(),
      dependencyExclusions,
    )
    if ((await treeDigest(packagePath(id), dependencyExclusions)) !== entry.digest)
      throw new Error(`installed dependency changed while copying: ${entry.source}; retry dispatch`)
  }
  for (const [id, entry] of graph.packages.entries()) await links(packagePath(id), entry.edges)
  await links(target, graph.roots)
}

/** Standalone plugins have no manifest. Discover their literal native module
 * edges without evaluating consumer code or installing packages. Computed core
 * imports are covered by the canonical core link at every package boundary. */
export async function standalonePluginManifest(
  entry: string,
  boundary: string,
  files = new Set<string>(),
): Promise<Manifest> {
  const dependencies: Record<string, string> = {}
  const visited = new Set<string>()
  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return
    visited.add(file)
    const actual = await realpath(file)
    if (!inside(boundary, actual))
      throw new Error(`standalone plugin link escapes its directory: ${file}`)
    files.add(file)
    const extension = file.split('.').at(-1)
    if (!['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(extension ?? '')) return
    const loader =
      extension === 'tsx' || extension === 'jsx'
        ? extension
        : extension === 'ts' || extension === 'mts' || extension === 'cts'
          ? 'ts'
          : 'js'
    const source = await readFile(file, 'utf8')
    // Literal package-relative assets retain their import.meta.url location.
    for (const match of source.matchAll(
      /new\s+URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
    )) {
      const asset = resolve(dirname(file), match[1]!)
      if (!inside(boundary, asset))
        throw new Error(`standalone plugin asset escapes its directory: ${asset}`)
      await visit(asset)
    }
    const imports = new Bun.Transpiler({ loader }).scanImports(source)
    for (const imported of imports) {
      const path = imported.path
      if (
        isBuiltin(path) ||
        path.startsWith('node:') ||
        path.startsWith('bun:') ||
        isAbsolute(path)
      )
        continue
      if (!path.startsWith('.')) {
        const parts = path.split('/')
        const name = path.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
        dependencies[name] = '*'
        continue
      }
      const base = resolve(dirname(file), path)
      if (!inside(boundary, base))
        throw new Error(`standalone plugin import escapes its directory: ${file}: ${path}`)
      let resolved: string
      try {
        // Relative-only resolution stays offline and follows Bun's native
        // extension substitutions and directory entry rules without loading code.
        resolved = Bun.resolveSync(path, dirname(file))
      } catch (cause) {
        throw new Error(`cannot resolve standalone plugin import: ${file}: ${path}`, { cause })
      }
      await visit(resolved)
    }
  }
  await visit(entry)
  return { name: 'autobuild-standalone-plugin', dependencies }
}
