// node callers.mjs <profile> <functionName> — inclusive time of a function grouped by its first caller outside lodash/preload
import fs from 'fs'
const [file, fname] = process.argv.slice(2)
const prof = JSON.parse(fs.readFileSync(file, 'utf8'))
const nodes = new Map(prof.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const dt = new Map()
prof.samples.forEach((s, i) => dt.set(s, (dt.get(s) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000))
const by = new Map()
for (const [id, ms] of dt) {
    const chain = []
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) chain.push(nodes.get(cur))
    const i = chain.findLastIndex((n) => n.callFrame.functionName === fname)
    if (i < 0) continue
    let j = i + 1
    while (j < chain.length && /lodash|preload/.test(chain[j].callFrame.url)) j++
    const c = chain[j]
    const k = `${c.callFrame.functionName || '(anon)'} ${c.callFrame.url.replace(/.*packages\//, '')}:${c.callFrame.lineNumber + 1}`
    by.set(k, (by.get(k) ?? 0) + ms)
}
for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(v.toFixed(1).padStart(8), k)
