"use client";

import { useMemo, useRef } from "react";
import type { BlockEvent } from "@/lib/types";
import { fmtConf, fmtMon, fmtPrice, fmtSigned, fmtSignedMon } from "@/lib/format";
import styles from "./FlowChart.module.css";

/* geometry — exactly the design's turn-4 flow chart (sim-script fx / fy4) */
const STEP = 12; // px per block
const ANCHOR = 840; // newest block sits here
const WINDOW = 120; // blocks kept on screen
const PAD = 40; // fy4 = PAD + (1-t)*(HEIGHT - 2*PAD)
const HEIGHT = 560;
const SPAN = HEIGHT - 2 * PAD; // 480 -> y runs 40..520
const EASE = 0.08; // scale easing per new block
const MIN_RANGE = 1e-6;
const CELL_Y = 596;

type Kind = "buy" | "sell" | "late" | "hold";

const CELL: Record<Kind, string> = {
  buy: "var(--buy-bar)",
  sell: "var(--sell-bar)",
  late: "var(--late-cell)",
  hold: "var(--hold-cell)",
};

function kindOf(e: BlockEvent): Kind {
  const d = e.decision;
  if (!d) return "hold";
  if (d.late) return "late";
  return d.action === "buy" ? "buy" : d.action === "sell" ? "sell" : "hold";
}

interface Dot {
  block: number;
  x: number;
  y: number;
  color: string;
  label: string | null;
  opacity: number;
}
interface Cell {
  block: number;
  x: number;
  color: string;
}

export default function FlowChart({
  events,
  latest,
}: {
  events: BlockEvent[];
  latest: BlockEvent | null;
}) {
  // the x origin is fixed for the life of the component, so that every new
  // block moves fx(latest) 12px further right and the shift 12px further left.
  const originRef = useRef<number | null>(null);
  const scaleRef = useRef<{ lo: number; hi: number; block: number } | null>(null);

  const model = useMemo(() => {
    const win = events.slice(-WINDOW);
    const last = latest ?? win[win.length - 1] ?? null;
    if (!win.length || !last) return null;

    if (originRef.current === null) originRef.current = win[0].block;
    const origin = originRef.current;
    const fx = (block: number) => (block - origin) * STEP;

    // smoothed value scale: ease 8% per NEW block toward the window min/max
    let lo = win[0].mid;
    let hi = win[0].mid;
    for (const e of win) {
      if (e.mid < lo) lo = e.mid;
      if (e.mid > hi) hi = e.mid;
    }
    const prev = scaleRef.current;
    if (prev) {
      if (prev.block === last.block) {
        lo = prev.lo;
        hi = prev.hi;
      } else {
        lo = prev.lo + (lo - prev.lo) * EASE;
        hi = prev.hi + (hi - prev.hi) * EASE;
      }
    }
    if (hi - lo < MIN_RANGE) hi = lo + MIN_RANGE;
    scaleRef.current = { lo, hi, block: last.block };

    const range = hi - lo;
    const fy = (p: number) => PAD + (1 - (p - lo) / range) * SPAN;

    const path = win
      .map((e, i) => `${i ? "L" : "M"}${fx(e.block).toFixed(1)} ${fy(e.mid).toFixed(1)}`)
      .join(" ");

    // fills: a dot each, a price label only on the latest fill and on side flips
    const filled = win.filter((e) => e.fill);
    const dots: Dot[] = filled.map((e, i) => {
      const f = e.fill!;
      const prevSide = i > 0 ? filled[i - 1].fill!.side : null;
      const labelled = i === filled.length - 1 || f.side !== prevSide;
      return {
        block: e.block,
        x: fx(e.block),
        y: fy(f.price),
        color: f.side === "buy" ? "var(--buy)" : "var(--sell)",
        label: labelled ? fmtPrice(f.price) : null,
        opacity: f.confirmed ? 1 : 0.7,
      };
    });

    const cells: Cell[] = win.map((e) => ({
      block: e.block,
      x: fx(e.block) - 4.5,
      color: CELL[kindOf(e)],
    }));

    // static right-edge price scale (outside the sliding group)
    const ticks = [0, 1, 2, 3].map((i) => {
      const y = PAD + ((i + 0.5) * SPAN) / 4;
      return { y, label: fmtPrice(lo + (1 - (y - PAD) / SPAN) * range) };
    });

    return {
      path,
      dots,
      cells,
      ticks,
      shift: ANCHOR - fx(last.block),
      endX: fx(last.block),
      endY: fy(last.mid),
    };
  }, [events, latest]);

  const shown = latest ?? events[events.length - 1] ?? null;
  const d = shown?.decision ?? null;
  const late = d?.late === true;
  const action = late ? "late" : (d?.action ?? "hold");
  const word =
    action === "buy"
      ? "Buying"
      : action === "sell"
        ? "Selling"
        : action === "late"
          ? "Missed the block"
          : "Holding";
  const wordColor =
    action === "buy"
      ? "var(--buy-ink)"
      : action === "sell"
        ? "var(--sell-ink)"
        : action === "late"
          ? "var(--late-ink)"
          : "var(--ink)";
  const conf = d ? Math.max(d.probabilities.buy, d.probabilities.sell, d.probabilities.hold) : 0;
  const subRight = !d || late ? "— ms · conf —" : `${Math.round(d.latencyMs)} ms · conf ${fmtConf(conf)}`;

  const pos = shown?.position;
  const stance =
    !pos || pos.side === "flat"
      ? "flat"
      : `${pos.side} ${fmtMon(pos.size, Number.isInteger(pos.size) ? 0 : 3)}`;
  const t = shown?.totals;
  const pnlMon = t?.pnlMon ?? 0;
  const pnlPct = t?.pnlPct ?? 0;

  return (
    <div className={styles.wrap}>
      <div className={styles.panel}>
        {!model || !shown ? (
          <div className={styles.empty}>waiting for blocks…</div>
        ) : (
          <>
            <svg
              className={styles.svg}
              viewBox="0 0 880 640"
              width="880"
              height="640"
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              {/* static furniture */}
              {model.ticks.map((tk) => (
                <line key={tk.y} className={styles.grid} x1="0" y1={tk.y} x2="880" y2={tk.y} />
              ))}
              <line className={styles.midline} x1="0" y1="290" x2="880" y2="290" />

              {/* the sliding chart */}
              <g className={styles.slide} style={{ transform: `translateX(${model.shift.toFixed(1)}px)` }}>
                <path className={styles.path} d={model.path} />
                {model.dots.map((dot) => (
                  <g key={dot.block} opacity={dot.opacity}>
                    <circle className={styles.dot} cx={dot.x} cy={dot.y} r="3.5" fill={dot.color} />
                    {dot.label ? (
                      <text
                        className={styles.fillLabel}
                        x={dot.x - 22}
                        y={dot.y - 13}
                        fill={dot.color}
                      >
                        {dot.label}
                      </text>
                    ) : null}
                  </g>
                ))}
                {model.cells.map((c) => (
                  <rect key={c.block} x={c.x} y={CELL_Y} width="9" height="30" rx="4" fill={c.color} />
                ))}
                <circle className={styles.halo} cx={model.endX} cy={model.endY} r="4" fill="var(--ink)" />
                <circle cx={model.endX} cy={model.endY} r="4" fill="var(--ink)" />
              </g>

              {/* right-edge price scale */}
              {model.ticks.map((tk) => (
                <text key={`l${tk.y}`} className={styles.scaleLabel} x="872" y={tk.y - 5} textAnchor="end">
                  {tk.label}
                </text>
              ))}
            </svg>

            <div className={styles.fade} />

            <div className={styles.tl}>
              <div className={styles.price} key={shown.mid}>
                {fmtPrice(shown.mid)}
              </div>
              <div className={styles.sub}>MON/USDC · Kuru</div>
            </div>

            <div className={styles.tr}>
              <div className={styles.word} style={{ color: wordColor }}>
                {word}
              </div>
              <div className={styles.subR}>{subRight}</div>
            </div>
          </>
        )}
      </div>

      <div className={styles.stance}>
        <span>
          stance <span className={styles.mono}>{stance}</span>
        </span>
        <span style={{ color: pnlMon >= 0 ? "var(--pnl-pos)" : "var(--pnl-neg)" }}>
          p&amp;l {fmtSignedMon(pnlMon, 3)} ({fmtSigned(pnlPct, 2)}%)
        </span>
        <span className={styles.spacer} />
        <span className={styles.note}>one tile = one trade, every block</span>
      </div>
    </div>
  );
}
