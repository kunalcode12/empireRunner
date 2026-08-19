"use client";

/**
 * The leaderboard.
 *
 * ## It says out loud that these are local scores
 *
 * P12 owns the API routes and the server-side replay re-simulation that makes a
 * leaderboard mean anything. Until then `createLocalLeaderboard` returns this
 * device's real runs, and the screen renders a visible notice saying so.
 *
 * The alternative — six invented names with plausible scores — is worse than an
 * empty board in two ways. It lies to the player, and it lies to the next
 * developer, who has no way to tell the fake rows from a working integration.
 *
 * ## The verified column exists now, empty
 *
 * Every row carries a `verified` flag that is false today. It is rendered as a
 * dash rather than hidden, because the whole point of law (a) is that a score can
 * be re-simulated server-side and proved, and the column is where that will show.
 * Building it now means P12 fills a column instead of redesigning a table.
 */

import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { Plate } from "../components/Plate";
import { ScreenShell } from "./ScreenShell";
import { Screen, useUiStore } from "../state/uiStore";
import {
  createLocalLeaderboard,
  type LeaderboardEntry,
  type LeaderboardScope,
} from "../state/leaderboard";

const LIMIT = 20;
const SCOPES: readonly { id: LeaderboardScope; label: string }[] = [
  { id: "global", label: "ALL TIME" },
  { id: "weekly", label: "THIS WEEK" },
];

export function LeaderboardScreen(): React.ReactElement {
  const go = useUiStore((state) => state.go);
  const [scope, setScope] = useState<LeaderboardScope>("global");
  const [rows, setRows] = useState<readonly LeaderboardEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    const source = createLocalLeaderboard();
    void source.top(scope, LIMIT).then((result) => {
      if (live) {
        setRows(result);
      }
    });
    return () => {
      live = false;
    };
  }, [scope]);

  const source = createLocalLeaderboard();

  return (
    <ScreenShell title="Leaderboard" onBack={() => go(Screen.Title)}>
      {!source.isRemote && (
        <Plate className="axis-board-notice">
          <p className="axis-body">
            <strong>Local scores only.</strong> These are your runs on this device. Global ranking
            needs the server that re-simulates each replay to verify it, which is not built yet — so
            nothing here has been checked by anything.
          </p>
        </Plate>
      )}

      <div className="axis-tabs" role="tablist" aria-label="Leaderboard range">
        {SCOPES.map((entry) => (
          <Button
            key={entry.id}
            role="tab"
            selected={scope === entry.id}
            notTabbable={scope !== entry.id}
            onClick={() => setScope(entry.id)}
            className="axis-tab"
          >
            {entry.label}
          </Button>
        ))}
      </div>

      {rows === null ? (
        <p className="axis-body">Loading…</p>
      ) : rows.length === 0 ? (
        <Plate className="axis-board-empty">
          <p className="axis-body">
            No runs yet{scope === "weekly" ? " this week" : ""}. Finish one and it appears here.
          </p>
        </Plate>
      ) : (
        <table className="axis-board">
          <caption className="axis-sr-only">
            {scope === "weekly" ? "This week's" : "All-time"} best runs on this device
          </caption>
          <thead>
            <tr>
              <th scope="col" className="axis-label">
                #
              </th>
              <th scope="col" className="axis-label">
                RUNNER
              </th>
              <th scope="col" className="axis-label axis-board-numcol">
                SCORE
              </th>
              <th scope="col" className="axis-label axis-board-numcol">
                DISTANCE
              </th>
              <th scope="col" className="axis-label">
                VERIFIED
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.rank}-${row.at}`} data-self={row.isSelf ? "1" : "0"}>
                <td className="axis-num">{row.rank}</td>
                <td className="axis-body">{row.name}</td>
                <td className="axis-num axis-board-numcol">{row.score.toLocaleString("en-US")}</td>
                <td className="axis-num axis-board-numcol">
                  {Math.floor(row.distance).toLocaleString("en-US")}m
                </td>
                <td className="axis-num">{row.verified ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ScreenShell>
  );
}
