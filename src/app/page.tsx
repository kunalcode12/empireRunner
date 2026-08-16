/**
 * Landing shell.
 *
 * No canvas here — the game mounts at /play behind dynamic(..., { ssr: false })
 * from P05 onward. docs/ARCHITECTURE.md §6: Next.js is a shell, not the engine.
 *
 * "Black" is the Kiln palette's key-line black (#0b0b0c), not #000000.
 * GAME_BIBLE §11.3 bans backgrounds darker than the active theme's darkest colour.
 */
export default function Home() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center gap-6 px-6">
      <h1
        className="text-[clamp(4rem,22vw,16rem)] leading-none font-black tracking-[0.08em] uppercase"
        style={{ fontFamily: "var(--axis-font-display)", color: "var(--axis-fg)" }}
      >
        AXIS
      </h1>

      <p
        className="max-w-xl text-center text-sm tracking-[0.28em] uppercase"
        style={{ fontFamily: "var(--axis-font-mono)", color: "var(--axis-muted)" }}
      >
        Four faces &middot; Twelve positions &middot; One wrong roll
      </p>

      <span
        aria-hidden="true"
        className="mt-2 block h-[var(--axis-keyline-width)] w-24"
        style={{ background: "var(--axis-accent)" }}
      />
    </main>
  );
}
