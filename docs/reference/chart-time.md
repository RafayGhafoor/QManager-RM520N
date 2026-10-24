# Chart time axis

> **Applies to:** Both — this is a rendering rule, not a device fact
> **Spec:** [`docs/specs/cell-history.md`](../specs/cell-history.md) · **Triggers below**

> One conversion from an archive timestamp to a `Date`, and the two places a
> trend chart gets a timestamp wrong.

---

## The defect this exists to prevent

Two independent paths hand a chart a value that is **not** epoch seconds, and each
produced a chart whose axis and hover read `Invalid Date`:

| Path | What arrives | What the obvious code does |
| --- | --- | --- |
| A `scale="time"` **axis** | recharts measures the domain in **milliseconds** and generates its ticks as `Date` objects | `new Date(ts * 1000)` on a `Date` → `NaN` → every tick labels itself "Invalid Date" |
| A tooltip's **`labelFormatter`** | for a numeric x-axis the shared `ChartTooltipContent` passes the **series name** (`"RSRP · dBm"`), not the x value | formatting that string as a date → `Invalid Date` on every hover |

Both were live: the Detailed Metrics chart since it shipped, the Cell History
chart from its first build. The symptom is a page of dashes where the time
belongs, which reads as "no data" rather than as a bug.

## The two rules

1. **`toMs()` is the only conversion.** `lib/chart-time.ts` accepts a `Date`,
   epoch seconds, epoch milliseconds or a numeric string, and decides
   seconds-vs-milliseconds by **magnitude**: below `1e12` is seconds. Every real
   timestamp on this device is `> 1e9` s and `< 1e12` ms, so neither unit can
   cross that line in this century and there is no wrong guess to make. Anything
   unparseable returns `null`, and every formatter renders `—` — never the string
   `Invalid Date`.
2. **An axis gets explicit ticks.** `axisTicks(startMs, endMs, count)` returns
   `count + 1` evenly spaced millisecond values, passed as `ticks={…}`. That
   fixes the formatter's input type **here** instead of trusting the chart
   library's own time-tick generation. `latency-monitoring/history-card.tsx:243`
   has always shipped this shape and has never printed an invalid tick.

## Why not just multiply in each chart

Because the call site cannot know what it was handed. The axis gives a `Date`,
the datum gives seconds, the tooltip gives a string. A per-chart
`ts * 1000` is correct in exactly one of those three cases and silently wrong in
the others — which is what shipped. One module that takes `unknown` removes the
question, and `bunx tsc` cannot tell you that your multiplication was wrong.

## The tooltip

`components/ui/chart-tooltip-time.tsx` does **not** use `labelFormatter` at all.
It reads the timestamp out of the hovered **datum** (`payload[0].payload`), which
is the plotted row and therefore always carries `ts` in the archive's unit, then
lists one row per series in that series' own stroke colour. It is deliberately a
UI primitive with no translation namespace: the em dash is the language-neutral
default and a caller that wants a sentence passes one.

## What a chart must therefore do

```tsx
const data = points.map((p) => ({ ...p, ms: toMs(p.ts) ?? NaN }));
const ticks = axisTicks(firstMs, lastMs);

<XAxis dataKey="ms" type="number" scale="time"
       domain={["dataMin", "dataMax"]} ticks={ticks}
       tickFormatter={(v) => formatAxisTick(v, longSpan)} />
<ChartTooltip content={<ChartTooltipTime unit={unit} />} />
```

Related rule, do not undo it: `connectNulls={false}` and `isAnimationActive={false}`
on a 30 s-retargeting series ([`latency-monitor.md`](./latency-monitor.md):65,
[`motion-preference.md`](./motion-preference.md)). A break is a missing reading,
never a zero.

## Verifying a change here

```bash
bunx tsc --noEmit && bun run build
```

Then render the tooltip and the tick maths with a fixed payload — this needs no
browser and no device, and it is what caught the second defect:

```tsx
// a /tmp harness, never in the repo (AGENTS.md rail 8)
renderToStaticMarkup(<ChartTooltipTime active payload={[{ name: "RSRP · dBm",
  value: -66, color: "var(--chart-nr)", payload: { ts: 1792801418 } }]} unit=" dBm" />)
// expect: "Oct 24, 05:23  RSRP · dBm  -66 dBm" — never "Invalid"
```

`toMs` must be exercised with all four shapes: epoch seconds, epoch
milliseconds, a `Date`, and `null`.
