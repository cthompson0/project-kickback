/**
 * Mutation check for the layout suite.
 *
 * Layout tests are unusually easy to write in a way that passes whatever the
 * code does - assert a number is "reasonable" and almost any number is. This
 * script breaks each clamp, bound and gesture rule in turn and asserts that
 * the test which is supposed to defend it actually goes red.
 *
 *   npm run test:layout
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const SUITE = 'tests/extension/layout.test.ts'
const RAIL_SUITE = 'tests/extension/chatRail.test.ts'
const LAYOUT = 'src/ui/layout/layout.ts'
const RAIL = 'src/platforms/twitch/chatRail.ts'

const MUTATIONS = [
  {
    name: 'size: stop enforcing the minimum',
    file: LAYOUT,
    from: '    width: clamp(Math.round(size.width), MIN_WIDTH, widthLimit),\n    height: clamp(Math.round(size.height), MIN_HEIGHT, heightLimit),',
    to: '    width: Math.round(size.width),\n    height: Math.round(size.height),',
    expect: 'refuses to go below the minimum',
  },
  {
    name: 'size: let the panel grow taller than the window',
    file: LAYOUT,
    from: '  const heightLimit = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, viewport.height - EDGE_MARGIN * 2))',
    to: '  const heightLimit = MAX_HEIGHT',
    expect: 'never grows taller than the window',
  },
  {
    name: 'position: let the panel be dragged out of sight',
    file: LAYOUT,
    from: '    x: Math.round(maxX < minX ? minX : clamp(position.x, minX, maxX)),\n    y: Math.round(maxY < minY ? minY : clamp(position.y, minY, maxY)),',
    to: '    x: Math.round(position.x),\n    y: Math.round(position.y),',
    expect: 'cannot be dragged out of reach in any direction',
  },
  {
    name: 'position: let the header go above the top of the window',
    file: LAYOUT,
    from: '  const minY = EDGE_MARGIN',
    to: '  const minY = -99999',
    expect: 'never lets the header go above the top of the window',
  },
  {
    name: 'position: demand more visible width than a launcher has',
    file: LAYOUT,
    from: '  const visibleX = Math.min(MIN_VISIBLE_X, footprint.width)',
    to: '  const visibleX = MIN_VISIBLE_X',
    expect: 'never demands more visible width than the panel has',
  },
  {
    name: 'recovery: only clamp, never fit, after the window changes',
    file: LAYOUT,
    from: '  const maxX = viewport.width - size.width - EDGE_MARGIN\n  const maxY = viewport.height - size.height - EDGE_MARGIN',
    to: '  const maxX = viewport.width - EDGE_MARGIN\n  const maxY = viewport.height - EDGE_MARGIN',
    expect: 'fits the panel back after the window shrinks',
  },
  {
    name: 'default: ignore the chat rail entirely',
    file: LAYOUT,
    from: '  const beside = viewport.width - EDGE_MARGIN - size.width - Math.max(0, placement.reservedRight)',
    to: '  const beside = viewport.width - EDGE_MARGIN - size.width',
    expect: 'steps aside for a Twitch chat rail',
  },
  {
    name: 'default: honour the rail even when it pushes the panel off screen',
    file: LAYOUT,
    from: '  const x = beside >= EDGE_MARGIN ? beside : atEdge',
    to: '  const x = beside',
    expect: 'ignores the rail rather than going off screen on a narrow window',
  },
  {
    name: 'default: trust a huge nav measurement',
    file: LAYOUT,
    from: '  const top = clamp(Math.round(placement.topOffset), EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.height / 3))',
    to: '  const top = Math.round(placement.topOffset)',
    expect: 'refuses to be pushed a long way down by a huge nav measurement',
  },
  {
    name: 'storage: accept whatever was stored',
    file: LAYOUT,
    from: '  if (x === null || y === null || width === null || height === null) return null',
    to: '  if (false) return null',
    expect: 'discards anything that is not a layout',
  },
  {
    name: 'storage: stop checking that values are finite numbers',
    file: LAYOUT,
    from: '  if (typeof value !== \'number\' || !Number.isFinite(value)) return null',
    to: '  if (typeof value !== \'number\') return null',
    expect: 'discards NaN and Infinity rather than positioning by them',
  },
  {
    name: 'storage: ignore the version stamp',
    file: LAYOUT,
    from: '  if (candidate?.v !== STORAGE_VERSION) return null',
    to: '  if (false) return null',
    expect: 'discards anything that is not a layout',
  },
  {
    name: 'drag: accumulate deltas instead of measuring from the start',
    file: LAYOUT,
    from: '    x: start.layout.x + (pointer.x - start.pointer.x),\n    y: start.layout.y + (pointer.y - start.pointer.y),',
    to: '    x: pointer.x,\n    y: pointer.y,',
    expect: 'moves by exactly the distance the pointer moved',
  },
  {
    name: 'drag: ignore the collapsed footprint',
    file: LAYOUT,
    from: '  const size = footprint ?? start.layout',
    to: '  const size = start.layout',
    expect: 'uses the launcher footprint when collapsed',
  },
  {
    name: 'resize: let the left edge drag the right edge with it',
    file: LAYOUT,
    from: '    const right = start.layout.x + start.layout.width\n    x = right - available.width',
    to: '    x = start.layout.x + dx',
    expect: 'holds the right edge still even once the minimum width is reached',
  },
  {
    name: 'resize: let the panel grow through the bottom of the window',
    file: LAYOUT,
    from: '      height: Math.min(height, viewport.height - y - EDGE_MARGIN),',
    to: '      height,',
    expect: 'cannot be dragged out through the bottom of the window',
  },
  {
    name: 'resize: let the panel grow through the right of the window',
    file: LAYOUT,
    from: '      width: edge.includes(\'w\') ? width : Math.min(width, viewport.width - x - EDGE_MARGIN),',
    to: '      width,',
    expect: 'cannot be dragged out through the right of the window',
  },
  {
    name: 'drag handle: let a drag start from a button',
    file: LAYOUT,
    from: "  return element.closest('button, a, input, textarea, select, [data-kb-nodrag]') !== null",
    to: '  return false',
    expect: 'does not start from a button',
  },
  {
    name: 'collapsed: clamp the launcher as if it were panel-sized',
    file: LAYOUT,
    from: '  return clampPosition(layout, { width: LAUNCHER_SIZE, height: LAUNCHER_SIZE }, viewport)',
    to: '  return clampPosition(layout, layout, viewport)',
    expect: 'is always fully visible',
    suite: SUITE,
  },
  {
    name: 'rail: accept a match that does not reach the right edge',
    file: RAIL,
    from: '    if (visibleRight < viewportWidth - 4) continue',
    to: '    if (false) continue',
    expect: 'reports nothing for something that does not reach the right edge',
    suite: RAIL_SUITE,
  },
  {
    name: 'rail: accept a rail with no visible width',
    file: RAIL,
    from: '    if (visible < MIN_PLAUSIBLE_WIDTH) continue',
    to: '    if (false) continue',
    expect: 'reports nothing for a sliver too narrow to be a rail',
    suite: RAIL_SUITE,
  },
  {
    name: 'rail: trust an implausibly wide match',
    file: RAIL,
    from: '    if (visible > viewportWidth * MAX_PLAUSIBLE_FRACTION) continue',
    to: '    if (false) continue',
    expect: 'reports nothing for a box implausibly wide to be a rail',
    suite: RAIL_SUITE,
  },
  {
    name: 'rail: report the full width rather than the visible part',
    file: RAIL,
    from: '    return Math.round(viewportWidth - visibleLeft)',
    to: '    return Math.round(rect.width)',
    expect: 'counts only the part actually on screen',
    suite: RAIL_SUITE,
  },
]

const REPORT = join(tmpdir(), 'kickback-layout-mutation.json')

function runSuite(suite) {
  rmSync(REPORT, { force: true })

  let crashOutput = null
  try {
    execFileSync('npx', ['vitest', 'run', suite, '--reporter=json', `--outputFile=${REPORT}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
  } catch (error) {
    crashOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  if (!existsSync(REPORT)) return { failures: [], crashed: crashOutput ?? 'no report written' }

  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  const failures = []
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') failures.push(assertion.title)
    }
  }
  if (failures.length === 0 && (report.numTotalTests ?? 0) === 0) {
    return { failures: [], crashed: crashOutput ?? 'suite ran no tests' }
  }
  return { failures, crashed: null }
}

let failed = 0

for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8')

  if (!original.includes(mutation.from)) {
    console.log(`SKIPPED  ${mutation.name}`)
    console.log(`         anchor no longer present in ${mutation.file} - update this check`)
    failed += 1
    continue
  }

  writeFileSync(mutation.file, original.replace(mutation.from, () => mutation.to))
  let result
  try {
    result = runSuite(mutation.suite ?? SUITE)
  } finally {
    writeFileSync(mutation.file, original)
  }

  if (result.crashed) {
    console.log(`INCONCLUSIVE ${mutation.name}`)
    console.log(`         the mutated source did not run: ${result.crashed.slice(0, 160)}`)
    failed += 1
    continue
  }

  if (result.failures.some((name) => name.includes(mutation.expect))) {
    console.log(`DETECTED ${mutation.name}`)
    console.log(`         caught by: ${mutation.expect}`)
  } else if (result.failures.length > 0) {
    console.log(`MISATTRIBUTED ${mutation.name}`)
    console.log(`         expected: ${mutation.expect}`)
    console.log(`         actual:   ${result.failures.slice(0, 4).join(', ')}`)
    failed += 1
  } else {
    console.log(`UNDETECTED ${mutation.name}`)
    console.log('         no test noticed - the suite does not defend this')
    failed += 1
  }
}

console.log(
  failed === 0
    ? `\nAll ${MUTATIONS.length} layout mutations detected.`
    : `\n${failed} of ${MUTATIONS.length} mutations were not properly detected.`,
)
process.exit(failed === 0 ? 0 : 1)
