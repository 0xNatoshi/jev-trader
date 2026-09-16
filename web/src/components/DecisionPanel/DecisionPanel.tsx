"use client";

import { useEffect, useRef, useState } from "react";
import type { BlockEvent } from "@/lib/types";
import { fmtPct } from "@/lib/format";
import styles from "./DecisionPanel.module.css";

export interface DecisionPanelProps {
  latest: BlockEvent | null;
}

type Chosen = "buy" | "sell" | null;

interface BarRowProps {
  label: string;
  /** css color for the label text */
  labelColor: string;
  /** dims the label to .38 when false */
  active: boolean;
  /** 0..1 — fill width as a fraction of the track */
  value: number;
  /** css background for the fill */
  fill: string;
  /** right-hand percentage text ("62%" or "—") */
  pct: string;
  /** increments on every flip of the chosen side; null = never pulse */
  flip: number | null;
}

function BarRow({
  label,
  labelColor,
  active,
  value,
  fill,
  pct,
  flip,
}: BarRowProps) {
  const pulseClass =
    flip === null ? "" : flip % 2 === 0 ? styles.pulseA : styles.pulseB;

  return (
    <div className={styles.row}>
      <span
        className={`${styles.label} ${pulseClass}`}
        style={{ color: labelColor, opacity: active ? 1 : 0.38 }}
      >
        {label}
      </span>
      <div className={styles.track}>
        <div
          className={styles.fill}
          style={{
            width: `${Math.max(0, Math.min(1, value)) * 100}%`,
            background: fill,
          }}
        />
      </div>
      <span className={styles.pct}>
        <span key={pct} className={styles.pctValue}>
          {pct}
        </span>
      </span>
    </div>
  );
}

export default function DecisionPanel({ latest }: DecisionPanelProps) {
  const decision = latest?.decision ?? null;
  const late = decision ? decision.late : true;
  const chosen: Chosen =
    decision && !decision.late && decision.action !== "hold"
      ? decision.action
      : null;

  const probs = decision?.probabilities ?? { buy: 0, sell: 0, hold: 0 };
  const upIn10 = decision?.upIn10 ?? 0;

  // Bump a counter whenever the chosen side flips, so the newly chosen
  // label can replay its scale pulse.
  const [flip, setFlip] = useState(0);
  const prevChosen = useRef<Chosen | undefined>(undefined);
  useEffect(() => {
    if (prevChosen.current !== undefined && prevChosen.current !== chosen) {
      setFlip((f) => f + 1);
    }
    prevChosen.current = chosen;
  }, [chosen]);

  const decided = decision !== null && !late;
  const pctOf = (p: number) => (decided ? fmtPct(p) : "—");

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <div className={styles.sectionLabel}>STANDING ORDER</div>
        <div className={styles.order}>
          {"> buy or sell MON/USDC on Kuru. every block. no abstaining."}
          <span className={styles.caret}>▌</span>
        </div>
      </section>

      <section className={styles.section}>
        <div className={`${styles.sectionLabel} ${styles.sectionLabelGap}`}>
          ACTION — WHICH SIDE, THIS BLOCK?
        </div>
        <BarRow
          label="buy"
          labelColor="var(--buy-ink)"
          active={chosen === "buy"}
          value={probs.buy}
          fill={chosen === "buy" ? "var(--buy-bar)" : "var(--buy-bar-dim)"}
          pct={pctOf(probs.buy)}
          flip={chosen === "buy" ? flip : null}
        />
        <BarRow
          label="sell"
          labelColor="var(--sell-ink)"
          active={chosen === "sell"}
          value={probs.sell}
          fill={chosen === "sell" ? "var(--sell-bar)" : "var(--sell-bar-dim)"}
          pct={pctOf(probs.sell)}
          flip={chosen === "sell" ? flip : null}
        />
      </section>

      <section className={styles.section}>
        <div className={`${styles.sectionLabel} ${styles.sectionLabelGap}`}>
          HORIZON — HIGHER IN TEN BLOCKS?
        </div>
        <BarRow
          label="up"
          labelColor="var(--muted)"
          active
          value={decided ? upIn10 : 0}
          fill="var(--up-bar)"
          pct={pctOf(upIn10)}
          flip={null}
        />
        <BarRow
          label="down"
          labelColor="var(--muted)"
          active
          value={decided ? 1 - upIn10 : 0}
          fill="var(--down-bar)"
          pct={pctOf(1 - upIn10)}
          flip={null}
        />
      </section>
    </div>
  );
}
