import Link from "next/link";

/**
 * Landing shell.
 *
 * No canvas here — the game mounts at /play behind `dynamic(..., { ssr: false })`.
 * docs/ARCHITECTURE.md §6: Next.js is a shell, not the engine. This page is
 * statically prerendered and pulls in no three.js, which is what keeps the
 * marketing route's first-load JS near nothing.
 *
 * "Black" is the key-line black `#0b0b0c`, which is the darkest colour in every
 * theme's palette and therefore exactly at the GAME_BIBLE §11.3 limit rather
 * than below it.
 *
 * **Retokenised at P14** — it read `--axis-fg` and `--axis-muted`, which the
 * token pass renamed to the role names the rest of the interface uses.
 */
export default function Home() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center gap-6 px-6">
      <h1 className="axis-wordmark" style={{ fontSize: "clamp(4rem, 22vw, 16rem)" }}>
        AXIS
      </h1>

      <p
        className="axis-label max-w-xl text-center"
        style={{ letterSpacing: "0.28em", fontFamily: "var(--axis-font-mono)" }}
      >
        Four faces &middot; Twelve positions &middot; One wrong roll
      </p>

      <Link href="/play" className="axis-button" data-variant="primary" data-block="0">
        PLAY
      </Link>
    </main>
  );
}
