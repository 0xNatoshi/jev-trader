"use client";

import { useEffect, useRef, useState } from "react";
import type { BlockEvent } from "@/lib/types";
import { fmtInt, fmtPrice, shortTx, txUrl } from "@/lib/format";
import styles from "./Feed.module.css";

/** Must match `.row { height }` in Feed.module.css. */
const ROW_H = 26;
/** Hard ceiling, so a very tall viewport does not render an absurd list. */
const MAX_ROWS = 40;

type Kind = "buy" | "sell" | "late";

function kindOf(event: BlockEvent): Kind {
  const d = event.decision;
  if (!d || d.late) return "late";
  if (d.action === "buy") return "buy";
  if (d.action === "sell") return "sell";
  return "late";
}

function fmtSize(size: number): string {
  return size.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const KIND_CLASS: Record<Kind, string> = {
  buy: styles.kindBuy,
  sell: styles.kindSell,
  late: styles.kindLate,
};

const WORD: Record<Kind, string> = { buy: "BUY", sell: "SELL", late: "LATE" };

export default function Feed({ events }: { events: BlockEvent[] }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // How many whole 26px rows fit in the box the layout gives us. The list
  // itself clips, so a wrong guess is never a half-drawn row, only a hidden one.
  const [capacity, setCapacity] = useState(MAX_ROWS);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const measure = () => {
      const fits = Math.max(1, Math.min(MAX_ROWS, Math.floor(el.clientHeight / ROW_H)));
      setCapacity((prev) => (prev === fits ? prev : fits));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = events.slice(-capacity).reverse();

  return (
    <section className={styles.feed}>
      <div className={styles.label}>FEED</div>
      <div className={styles.list} ref={listRef}>
        {rows.length === 0 ? (
          <div className={styles.empty}>no blocks yet</div>
        ) : (
          rows.map((event, i) => {
            const kind = kindOf(event);
            const decision = event.decision;
            const fill = event.fill;
            const isTrade = kind !== "late";
            const kindClass = KIND_CLASS[kind];

            const conf =
              kind === "late" || !decision
                ? ""
                : "conf " +
                  Math.max(
                    decision.probabilities.buy,
                    decision.probabilities.sell,
                    decision.probabilities.hold,
                  ).toFixed(2);

            const lat = kind === "late" || !decision ? "" : `${decision.latencyMs}ms`;

            let detail = "";
            let detailMuted = false;
            if (isTrade) {
              if (fill && fill.size > 0) {
                detail = `${fmtSize(fill.size)} @ ${fmtPrice(fill.price)}`;
              } else {
                detail = "no fill";
                detailMuted = true;
              }
            }

            const rowClass = [styles.row, kindClass, i === 0 ? styles.newest : ""]
              .filter(Boolean)
              .join(" ");

            return (
              <div key={event.block} className={rowClass}>
                <span className={`${styles.cell} ${styles.block}`}>{fmtInt(event.block)}</span>
                <span className={`${styles.cell} ${styles.word}`}>{WORD[kind]}</span>
                <span className={`${styles.cell} ${styles.conf}`}>{conf}</span>
                <span className={`${styles.cell} ${styles.lat}`}>{lat}</span>
                <span
                  className={`${styles.cell} ${styles.detail}${detailMuted ? ` ${styles.muted}` : ""}`}
                >
                  {detail}
                </span>
                <span className={`${styles.cell} ${styles.tx}`}>
                  {fill && fill.simulated ? (
                    <span className={styles.muted}>sim</span>
                  ) : fill && fill.txHash ? (
                    <a
                      className={fill.confirmed ? undefined : styles.pending}
                      title={fill.confirmed ? undefined : "pending"}
                      href={txUrl(fill.txHash)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortTx(fill.txHash)}
                    </a>
                  ) : null}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
