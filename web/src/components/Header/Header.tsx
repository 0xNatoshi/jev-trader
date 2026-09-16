"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockEvent, ConnectionState, Meta } from "@/lib/types";
import { fmtInt, shortAddr } from "@/lib/format";
import styles from "./Header.module.css";

export interface HeaderProps {
  meta: Meta | null;
  latest: BlockEvent | null;
  connection: ConnectionState;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  live: "Live",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
};

export default function Header({ meta, latest, connection }: HeaderProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const wallet = meta?.wallet ?? null;

  const onCopy = useCallback(() => {
    if (!wallet) return;
    try {
      void navigator.clipboard?.writeText(wallet)?.catch(() => {});
    } catch {
      /* clipboard unavailable — still flash "copied" so the click feels alive */
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  }, [wallet]);

  const model = meta?.model ?? null;
  const isJev = (model ?? "").toLowerCase().startsWith("jev");
  const isLive = connection === "live";

  return (
    <div className={styles.header}>
      <span className={styles.brand}>‖ Jev Trader</span>

      <span key={latest?.block ?? "no-block"} className={styles.block}>
        block {latest ? fmtInt(latest.block) : "—"}
      </span>

      <span className={styles.spacer} />

      <button
        type="button"
        className={styles.wallet}
        onClick={onCopy}
        disabled={!wallet}
        title={wallet ?? "no wallet — dry run"}
        aria-label={wallet ? `Copy wallet address ${wallet}` : "Dry run"}
      >
        {copied ? "copied" : wallet ? shortAddr(wallet) : "dry run"}
      </button>

      {model ? (
        <span
          className={styles.badge}
          style={{
            background: isJev
              ? "var(--badge-jev-bg)"
              : "var(--badge-standin-bg)",
            color: isJev ? "var(--badge-jev-fg)" : "var(--badge-standin-fg)",
          }}
        >
          {model}
        </span>
      ) : null}

      <span className={styles.live}>
        <span
          className={styles.dot}
          style={{ background: isLive ? "var(--live-dot)" : "#F2C063" }}
        />
        {CONNECTION_LABEL[connection]}
      </span>
    </div>
  );
}
