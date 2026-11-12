import { expect, test } from 'bun:test'
import { constants } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { readDistSkills } from '../packages/core/src/cli/init'
import { loadConfig } from '../packages/core/src/config/load'
import { effectiveRuntimeReferences } from '../packages/core/src/config/roles'
import { verifyStages } from '../packages/core/src/config/schema'
import { evaluateVerifyApplicability } from '../packages/core/src/kernel/verify-applicability'

const REPO_ROOT = join(import.meta.dir, '..')

const CLAUDE = { runtime: 'claude', model: 'claude-opus-5-5', account: 'claude' }
const CLAUDE_FALLBACK = { runtime: 'claude', model: 'claude-sonnet-5-5', account: 'claude' }

// Fork configuration (yosefAlsuhaibani/autobuild): builds run in local git
// worktrees on the maintainer's machine, billed to one Claude subscription.
test('fork builds in local worktrees on subscription-billed Claude Code', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.workspace.provider).toBe('git-worktree')
  expect(config.accounts).toEqual({
    claude: { kind: 'claude-subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' },
  })

  // Every role inherits the default: Claude Opus, falling back to Sonnet on
  // the same subscription account.
  expect(Object.keys(config.roles)).toEqual(['default'])
  expect(config.roles.default).toMatchObject(CLAUDE)
  expect(config.roles.default!.alternates).toEqual([CLAUDE_FALLBACK])

  const runtimes = effectiveRuntimeReferences(config).map(({ runtime }) => runtime)
  expect([...new Set(runtimes)]).toEqual(['claude'])
  await access(join(REPO_ROOT, 'scripts/postgres-live.sh'), constants.X_OK)
})

test('the fork keeps this repository pipeline on its own GitHub issues and a local store', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))

  expect(config.commands).toMatchObject({
    setup: 'bun install',
    lint: './scripts/verify-bun.sh bun run check',
    typecheck: './scripts/verify-bun.sh bun run typecheck',
    test: './scripts/verify-bun.sh bun run test',
  })
  expect(config.commands.build).toBe('./scripts/verify-bun.sh bun run check:build')
  const testIntegration = config.commands['test-integration']
  expect(testIntegration).toBe(
    "./scripts/postgres-live.sh ensure-running && AB_POSTGRES_TEST_URL='postgres://postgres:postgres@127.0.0.1:5432/postgres' ./scripts/verify-bun.sh bun run test:integration",
  )
  await access(join(REPO_ROOT, 'scripts/verify-bun.sh'), constants.X_OK)
  expect(config.verify.steps).toEqual([
    'lint',
    'types',
    'unit',
    'build',
    'integration',
    'ui-tui',
    'ui-app',
    'ui-website',
    'docs',
  ])
  expect(config.verify.stepConfigs.lint).toEqual({ kind: 'check', command: 'lint', always: true })
  expect(config.verify.stepConfigs.build).toEqual({
    kind: 'check',
    command: 'build',
    always: true,
  })
  expect(verifyStages(config.verify)).toEqual([
    ['lint', 'types'],
    ['unit', 'build', 'integration'],
    ['ui-tui'],
    ['ui-app', 'ui-website', 'docs'],
  ])
  // Integration holds every IO test, including those that check skills, docs
  // and configuration, so it applies to every build exactly as unit does.
  expect(config.verify.stepConfigs.unit).toEqual({ kind: 'check', command: 'test' })
  expect(config.verify.stepConfigs.integration).toEqual({
    kind: 'check',
    command: 'test-integration',
  })
  expect(config.verify.stepConfigs['ui-tui']).toMatchObject({
    kind: 'agent',
    skill: 'verify-ui-tui',
    paths: expect.arrayContaining(['packages/core/src/cli/dashboard/**']),
  })
  expect(config.verify.stepConfigs['ui-app']).toMatchObject({
    kind: 'agent',
    skill: 'verify-ui-app',
    paths: expect.arrayContaining(['packages/hosted-store-service/app/**']),
  })
  expect(config.verify.stepConfigs['ui-website']).toEqual({
    kind: 'agent',
    skill: 'verify-ui-website',
    paths: [
      'packages/website/**',
      'docs/**',
      'design/website/**',
      'tools/website-capture*',
      '.agents/skills/verify-ui-website/SKILL.md',
    ],
  })
  expect(config.finalize.steps).toEqual(['changelog'])
  expect(config.finalize.stepConfigs.changelog).toEqual({
    kind: 'agent',
    skill: 'finalize-changelog',
  })
  expect(config.tickets).toMatchObject({
    source: 'github',
    readyState: 'ready',
    createState: 'triage',
    triageState: 'triage',
    proposalState: 'triage',
  })
  expect(config.store).toBeUndefined()
})

test('the ui-website step covers site source, design references and evidence tooling', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))
  const step = config.verify.stepConfigs['ui-website']
  if (!step || !('paths' in step) || !step.paths) throw new Error('ui-website step has no paths')
  const rule = { kind: 'paths' as const, step: 'ui-website', paths: step.paths }
  for (const path of [
    'packages/website/src/page.ts',
    'docs/overview.md',
    'docs/architecture.md',
    'packages/website/docs/start.md',
    'design/website/reference.html',
    'tools/website-capture.ts',
    'tools/website-capture.integration.test.ts',
    'tools/website-capture.md',
    '.agents/skills/verify-ui-website/SKILL.md',
  ]) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(true)
  }
  for (const path of ['autobuild.toml']) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(false)
  }
})

test('verify-ui-website is an unprefixed repo-local skill with a Claude symlink', async () => {
  const link = join(REPO_ROOT, '.claude/skills/verify-ui-website')
  expect(await realpath(link)).toBe(
    await realpath(join(REPO_ROOT, '.agents/skills/verify-ui-website')),
  )
  const skill = await readFile(join(link, 'SKILL.md'), 'utf8')
  expect(skill).toMatch(/^name: verify-ui-website$/m)
})

test('docs gate covers product surfaces and excludes repository configuration', async () => {
  const config = await loadConfig(join(REPO_ROOT, 'autobuild.toml'))
  const step = config.verify.stepConfigs.docs!
  const paths = [
    'packages/core/src/**',
    'packages/hosted-dispatcher/src/**',
    'packages/hosted-store-service/src/**',
    'packages/hosted-store-service/app/**',
    'packages/postgres-store/src/**',
    'packages/vercel-sandbox/src/**',
    'packages/website/**',
    'bin/**',
    'skills/**',
    'templates/**',
    'SPEC.md',
    'README.md',
    'docs/**',
  ]
  expect(step).toEqual({ kind: 'agent', skill: 'verify-docs', paths })
  const rule = { kind: 'paths' as const, step: 'docs', paths }
  for (const path of paths.map((path) => path.replace('**', 'example.ts'))) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(true)
    // Deleted paths and both rename sides use the same changed-path evidence.
    expect(evaluateVerifyApplicability(rule, [path, 'tools/renamed.ts']).applies).toBe(true)
    expect(evaluateVerifyApplicability(rule, ['tools/old.ts', path]).applies).toBe(true)
  }
  for (const path of [
    'tools/check.ts',
    'autobuild.toml',
    'AGENTS.md',
    '.agents/skills/verify-docs/SKILL.md',
    '.claude/skills/verify-docs',
    'packages/web-dashboard-capture/src/index.ts',
  ]) {
    expect(evaluateVerifyApplicability(rule, [path]).applies).toBe(false)
  }
  const link = join(REPO_ROOT, '.claude/skills/verify-docs')
  expect(await realpath(link)).toBe(await realpath(join(REPO_ROOT, '.agents/skills/verify-docs')))
  const skill = await readFile(join(link, 'SKILL.md'), 'utf8')
  expect(skill).toMatch(/^name: verify-docs$/m)
  expect(skill).toMatch(/^disable-model-invocation: true$/m)
  for (const instruction of [
    'ab context',
    'commitRange.base',
    'commitRange.head',
    'git diff <base>..<head>',
    'ab verdict pass --notes .ab/docs-verify-report.md',
    'ab verdict fail --report .ab/docs-verify-report.md',
  ])
    expect(skill).toContain(instruction)
  expect(
    (await readDistSkills(REPO_ROOT)).some((skill) => skill.installName === 'verify-docs'),
  ).toBe(false)
})
