// node analyze-prof.mjs <file.cpuprofile> [top]  — self and inclusive time per function, and self time per package
import fs from 'fs'

const [file, topArg] = process.argv.slice(2)
const top = Number(topArg ?? 40)
const prof = JSON.parse(fs.readFileSync(file, 'utf8'))
const nodes = new Map(prof.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

const dt = new Map()
for (let i = 0; i < prof.samples.length; i++) dt.set(prof.samples[i], (dt.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000)
const total = [...dt.values()].reduce((a, b) => a + b, 0)

const short = (url) =>
    url
        .replace(/^file:\/\//, '')
        .replace(/.*\/node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'npm:')
        .replace(/.*\/packages\//, '')
const key = (n) => {
    const cf = n.callFrame
    return `${cf.functionName || '(anon)'} ${short(cf.url)}:${cf.lineNumber + 1}`
}
const pkg = (n) => {
    const url = n.callFrame.url
    if (!url) return n.callFrame.functionName || '(native)'
    const m = url.match(/node_modules\/\.pnpm\/[^/]+\/node_modules\/((@[^/]+\/)?[^/]+)/)
    if (m) return `npm:${m[1]}`
    const p = url.match(/packages\/([^/]+\/dist\/[^/]+(\/[^/]+)?)/)
    if (p) return p[1]
    if (url.startsWith('node:')) return 'node-internal'
    return short(url)
}

const self = new Map()
const incl = new Map()
const byPkg = new Map()
for (const [id, ms] of dt) {
    const n = nodes.get(id)
    self.set(key(n), (self.get(key(n)) ?? 0) + ms)
    byPkg.set(pkg(n), (byPkg.get(pkg(n)) ?? 0) + ms)
    const seen = new Set()
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
        const k = key(nodes.get(cur))
        if (seen.has(k)) continue
        seen.add(k)
        incl.set(k, (incl.get(k) ?? 0) + ms)
    }
}
const print = (title, map, n) => {
    console.log(`\n== ${title} (total ${total.toFixed(0)} ms sampled)`)
    for (const [k, v] of [...map].sort((a, b) => b[1] - a[1]).slice(0, n))
        console.log(`${v.toFixed(1).padStart(9)} ms ${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`)
}
print('self time by package', byPkg, 25)
print('self time by function', self, top)
print('inclusive time by function', incl, top)
