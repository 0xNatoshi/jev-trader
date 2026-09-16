"use client";

import type { BlockEvent } from "@/lib/types";
import { fmtInt, fmtMon, fmtUsd } from "@/lib/format";
import styles from "./Footer.module.css";

const DASH = "—";

const LINKS: Array<{ label: string; href: string }> = [
  { label: "TypeSafe", href: "https://typesafe.ai" },
  { label: "Monad", href: "https://monad.xyz" },
  { label: "Kuru", href: "https://kuru.io" },
];

export default function Footer({ latest }: { latest: BlockEvent | null }) {
  const totals = latest?.totals ?? null;
  const pnlMon = totals?.pnlMon ?? null;
  const pnl =
    pnlMon == null ? DASH : `${pnlMon >= 0 ? "+" : ""}${pnlMon.toFixed(3)} MON`;
  const pnlClass =
    pnlMon == null ? undefined : pnlMon >= 0 ? styles.pnlPos : styles.pnlNeg;

  return (
    <footer className={styles.footer}>
      <span>blocks {totals ? fmtInt(totals.blocks) : DASH}</span>
      <span>trades {totals ? fmtInt(totals.trades) : DASH}</span>
      <span>jev {totals ? fmtUsd(totals.jevUsd) : DASH}</span>
      <span>gas {totals ? fmtMon(totals.gasMon) : DASH}</span>
      <span className={pnlClass}>p&amp;l {pnl}</span>
      <span className={styles.spacer} />
      <span>experimental · tiny bankroll · not advice</span>
      <span className={styles.links}>
        {LINKS.map((link) => (
          <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
            {link.label}
          </a>
        ))}
      </span>
    </footer>
  );
}
