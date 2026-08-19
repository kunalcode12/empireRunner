"use client";

/**
 * Settings — audio, motion, display, controls.
 *
 * ## The audio-offset slider tells the truth about what it cannot do
 *
 * TUNING §16.8 is explicit: a negative offset can only give back the 20ms
 * scheduling lead, because sound cannot be scheduled in the past. A player on
 * Bluetooth headphones hearing everything 200ms late **cannot fix it here**, and
 * the doc says the settings screen "must not imply otherwise". So the limitation
 * is printed under the control, in the UI, not just in a markdown file.
 *
 * ## Reduced motion is three-state
 *
 * OS / ON / OFF, and OFF is not the same as OS. A player who has set the system
 * preference for everything else may still want full motion in a game whose
 * central mechanic is the world rotating, and must be able to say so —
 * `feel/reducedMotion.ts` already resolves it that way for the 3D layer, and this
 * is the control that feeds it.
 *
 * ## Volumes are written through to the audio layer
 *
 * `audio/settings.ts` owns persistence and clamps on every read. This screen does
 * not keep a second copy — it writes and lets that module be authoritative,
 * because two stores of the same volume is how a mute that does not stick
 * happens.
 */

import { useEffect } from "react";
import { TUNING } from "@/game/config/tuning";
import { loadSettings, saveSettings, type AudioSettings } from "@/game/audio";
import { Button } from "../components/Button";
import { Plate } from "../components/Plate";
import { StepSlider } from "../components/StepSlider";
import { ScreenShell } from "./ScreenShell";
import { Screen, useUiStore, type MotionPreference } from "../state/uiStore";
import { useMetaStore } from "../state/metaStore";

const MS_PER_SECOND = 1000;

/** Keyboard bindings, from GAME_BIBLE §6.1. Displayed, not yet editable. */
const BINDINGS: readonly { verb: string; keys: string }[] = [
  { verb: "LANE LEFT", keys: "A  ·  ←" },
  { verb: "LANE RIGHT", keys: "D  ·  →" },
  { verb: "JUMP", keys: "SPACE  ·  W  ·  ↑" },
  { verb: "SLIDE", keys: "S  ·  ↓" },
  { verb: "ROLL LEFT", keys: "Q  ·  ," },
  { verb: "ROLL RIGHT", keys: "E  ·  ." },
  { verb: "OVERDRIVE", keys: "SHIFT  ·  F" },
  { verb: "PAUSE", keys: "ESC  ·  P" },
];

const MOTION_CHOICES: readonly { label: string; value: MotionPreference }[] = [
  { label: "OS", value: null },
  { label: "ON", value: true },
  { label: "OFF", value: false },
];

const QUALITY_CHOICES: readonly { label: string; value: string | null }[] = [
  { label: "AUTO", value: null },
  { label: "LOW", value: "low" },
  { label: "MED", value: "medium" },
  { label: "HIGH", value: "high" },
];

export function SettingsScreen(): React.ReactElement {
  const go = useUiStore((state) => state.go);
  const settings = useUiStore((state) => state.settings);
  const update = useUiStore((state) => state.updateSettings);
  const repairs = useMetaStore((state) => state.repairs);

  // The audio layer is authoritative for its own values, so they are pulled in
  // on mount rather than assumed to match the UI store's defaults.
  useEffect(() => {
    const audio = loadSettings();
    update({
      masterVolume: audio.masterGain,
      musicVolume: audio.musicGain,
      sfxVolume: audio.sfxGain,
      uiVolume: audio.uiGain,
      muted: audio.muted,
      audioOffset: audio.latencyOffset,
    });
    // Deliberately mount-only: re-running on every settings change would fight
    // the player's own edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setAudio(patch: Partial<AudioSettings>): void {
    // Read-modify-write against the audio layer rather than against the UI
    // store, so `sanitiseSettings` clamps the value on the way in and this
    // screen never becomes a second, unclamped source of truth.
    const next: AudioSettings = { ...loadSettings(), ...patch };
    saveSettings(next);
    update({
      masterVolume: next.masterGain,
      musicVolume: next.musicGain,
      sfxVolume: next.sfxGain,
      uiVolume: next.uiGain,
      muted: next.muted,
      audioOffset: next.latencyOffset,
    });
  }

  return (
    <ScreenShell title="Settings" onBack={() => go(Screen.Title)}>
      <Plate as="section" className="axis-settings-group" ariaLabel="Audio">
        <h2 className="axis-settings-heading">AUDIO</h2>

        <StepSlider
          label="MASTER"
          value={settings.masterVolume}
          onChange={(value) => setAudio({ masterGain: value })}
          format={(value) => value.toFixed(2)}
        />
        <StepSlider
          label="MUSIC"
          value={settings.musicVolume}
          onChange={(value) => setAudio({ musicGain: value })}
          format={(value) => value.toFixed(2)}
        />
        <StepSlider
          label="SFX"
          value={settings.sfxVolume}
          onChange={(value) => setAudio({ sfxGain: value })}
          format={(value) => value.toFixed(2)}
        />
        <StepSlider
          label="UI"
          value={settings.uiVolume}
          onChange={(value) => setAudio({ uiGain: value })}
          format={(value) => value.toFixed(2)}
        />

        <StepSlider
          label="AUDIO OFFSET"
          value={settings.audioOffset}
          min={TUNING.audio.latencyOffsetMin}
          max={TUNING.audio.latencyOffsetMax}
          bipolar
          onChange={(value) => setAudio({ latencyOffset: value })}
          format={(value) => `${Math.round(value * MS_PER_SECOND)}ms`}
          hint={
            "A negative offset only gives back the 20ms scheduling lead — sound cannot be " +
            "scheduled in the past, so this cannot correct Bluetooth latency. Positive values " +
            "delay audio to match a display that is itself buffered."
          }
        />

        <Row label="MUTE">
          <Button
            selected={settings.muted}
            onClick={() => setAudio({ muted: !settings.muted })}
            ariaLabel={settings.muted ? "Unmute" : "Mute"}
          >
            {settings.muted ? "MUTED" : "ON"}
          </Button>
        </Row>
      </Plate>

      <Plate as="section" className="axis-settings-group" ariaLabel="Motion and display">
        <h2 className="axis-settings-heading">MOTION &amp; DISPLAY</h2>

        <Row label="REDUCED MOTION" hint="OS follows your system preference.">
          <div role="radiogroup" aria-label="Reduced motion" className="axis-settings-choices">
            {MOTION_CHOICES.map((choice) => (
              <Button
                key={String(choice.value)}
                role="radio"
                selected={settings.reducedMotion === choice.value}
                onClick={() => update({ reducedMotion: choice.value })}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </Row>

        <Row
          label="COLOURBLIND-SAFE"
          hint="Adds a halftone pattern channel so no state is signalled by colour alone."
        >
          <Button
            selected={settings.colorblindSafe}
            onClick={() => update({ colorblindSafe: !settings.colorblindSafe })}
          >
            {settings.colorblindSafe ? "ON" : "OFF"}
          </Button>
        </Row>

        <Row label="QUALITY" hint="AUTO picks a tier from the device. Takes effect next run.">
          <div role="radiogroup" aria-label="Quality" className="axis-settings-choices">
            {QUALITY_CHOICES.map((choice) => (
              <Button
                key={String(choice.value)}
                role="radio"
                selected={settings.quality === choice.value}
                onClick={() => update({ quality: choice.value })}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </Row>
      </Plate>

      <Plate as="section" className="axis-settings-group" ariaLabel="Controls">
        <h2 className="axis-settings-heading">CONTROLS</h2>
        <dl className="axis-bindings">
          {BINDINGS.map((binding) => (
            <div key={binding.verb} className="axis-binding">
              <dt className="axis-label">{binding.verb}</dt>
              <dd className="axis-num axis-binding-keys">{binding.keys}</dd>
            </div>
          ))}
        </dl>
        {/* Honest rather than a dead button. GAME_BIBLE §6.1 says bindings are
            remappable and persisted; the input layer reads a fixed table today,
            so a REBIND control here would be a lie with a click target. */}
        <p className="axis-body axis-settings-note">
          Rebinding is not wired yet. The bindings above are the shipped defaults from the design
          document, and touch and gamepad use their own mappings.
        </p>
      </Plate>

      {repairs.length > 0 && (
        <Plate as="section" className="axis-settings-group" ariaLabel="Save file">
          <h2 className="axis-settings-heading">SAVE</h2>
          <p className="axis-body">
            Your save was repaired on load. Nothing was lost beyond the fields listed, and the game
            recovered rather than refusing to start.
          </p>
          <ul className="axis-settings-repairs">
            {repairs.map((repair) => (
              <li key={repair} className="axis-body">
                {repair}
              </li>
            ))}
          </ul>
        </Plate>
      )}
    </ScreenShell>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="axis-settings-row">
      <div className="axis-settings-rowtext">
        <p className="axis-label">{label}</p>
        {hint !== undefined && <p className="axis-body axis-settings-hint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
