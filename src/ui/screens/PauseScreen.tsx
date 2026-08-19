"use client";

/**
 * Pause.
 *
 * GAME_BIBLE §12: tab blur and window unfocus auto-pause, and that is explicitly
 * "not a failure state". The blur listener lives in `play/page.tsx` beside the
 * loop it pauses; this is what the player sees when it fires.
 *
 * ## RESUME is focused, and Escape resumes
 *
 * The overwhelmingly common reason this screen is open is that the player tabbed
 * away and came back. Making them hunt for a button after an interruption they
 * did not choose is the wrong default, so both the focus ring and the Escape key
 * point at the one action they almost certainly want.
 *
 * ## Quitting is a real decision, so it says what it costs
 *
 * A quit ends the run and settles it — the Bits are kept, the distance counts
 * toward missions. That is worth stating, because "quit" in most games means
 * "throw this away" and here it does not.
 */

import { Button } from "../components/Button";
import { Plate } from "../components/Plate";
import { ScreenShell } from "./ScreenShell";
import { Screen, useUiStore } from "../state/uiStore";

export interface PauseScreenProps {
  readonly onResume: () => void;
  readonly onQuit: () => void;
}

export function PauseScreen({ onResume, onQuit }: PauseScreenProps): React.ReactElement {
  const go = useUiStore((state) => state.go);

  return (
    // `bare`, so no header is rendered.
    //
    // An overlay over a live run has no business drawing a BACK chevron and a
    // title bar across the middle of the tunnel — which is exactly what the
    // first version did, because an overlay screen centres its content and the
    // header centred with it. The plate carries the actions; Escape still
    // resumes, through the handler ScreenShell installs regardless of `bare`.
    <ScreenShell title="Paused" overlay bare onBack={onResume} className="axis-pause">
      <Plate className="axis-pause-plate">
        <h2 className="axis-settings-heading">PAUSED</h2>
        <p className="axis-body">
          The run is held exactly where you left it. Nothing has advanced — the accumulated time is
          dropped rather than simulated, so the world does not lurch forward when you return.
        </p>

        <div className="axis-pause-actions">
          <Button variant="primary" block autoFocus onClick={onResume}>
            RESUME
          </Button>
          <Button block onClick={() => go(Screen.Settings)}>
            SETTINGS
          </Button>
          <Button block onClick={onQuit}>
            END RUN
          </Button>
        </div>

        <p className="axis-body axis-pause-note">
          Ending the run keeps everything you earned — Bits, Shards and mission progress all settle
          exactly as they would on a crash.
        </p>
      </Plate>
    </ScreenShell>
  );
}
