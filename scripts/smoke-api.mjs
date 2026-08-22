/**
 * End-to-end smoke test against a RUNNING server.
 *
 * The unit suite exercises `submitRun` directly, which is the right place for
 * correctness. This exercises the part that suite cannot see: cookies, JSON
 * envelopes, base64 transport, status codes, and the route wiring itself. A
 * pipeline that is perfect and unreachable is not a backend.
 *
 * Usage:
 *   npx next start -p 3111
 *   node --import ./scripts/lib/ts-register.mjs scripts/smoke-api.mjs
 */

import { createIntent } from "../src/game/sim/intent.ts";
import { createSim } from "../src/game/sim/sim.ts";
import { createRecorder, record, serializeReplay } from "../src/game/sim/replay.ts";

const BASE = process.env["AXIS_SMOKE_BASE"] ?? "http://localhost:3111";
const TICKS = 1800;

/** One shared cookie jar, because the session is the identity. */
let cookie = "";

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...init.headers },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie !== null) {
    cookie = setCookie.split(";")[0];
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function playRun(seed, ticks, shards = 0) {
  const sim = createSim(seed, { shards });
  const recorder = createRecorder(seed);
  const intent = createIntent();
  for (let tick = 0; tick < ticks; tick += 1) {
    if (tick % 20 === 0) {
      intent.lateral = intent.lateral === 1 ? -1 : 1;
    }
    record(recorder, intent);
    sim.tick(intent);
  }
  return serializeReplay(recorder, sim.hash());
}

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) {
    failures += 1;
  }
  console.log(`  [${mark}] ${label}${detail ? `  — ${detail}` : ""}`);
}

console.log("=".repeat(72));
console.log(`AXIS — API smoke test against ${BASE}`);
console.log("=".repeat(72));

// ── Identity ────────────────────────────────────────────────────────────────
const identity = await call("/api/identity");
check("GET /api/identity mints an anonymous player", identity.status === 200 && identity.body.ok);
check("no signup was required", identity.body.player?.hasAccount === false);
const playerId = identity.body.player?.playerId;

// ── A genuine run ───────────────────────────────────────────────────────────
const start = await call("/api/run/start", { method: "POST", body: "{}" });
check("POST /api/run/start issues a signed seed", start.status === 200 && start.body.ok);
check("the session is the same player", start.body.player?.playerId === playerId);

const replay = playRun(start.body.seed, TICKS, start.body.shards);
const submit = await call("/api/run/submit", {
  method: "POST",
  body: JSON.stringify({
    runToken: start.body.runToken,
    replayBlob: Buffer.from(replay).toString("base64"),
    elapsedMs: (TICKS / 60) * 1000,
  }),
});
check(
  "a genuine replay validates",
  submit.status === 200 && submit.body.ok === true,
  submit.body.ok
    ? `score ${submit.body.run.score}, ${submit.body.run.validationMs}ms`
    : JSON.stringify(submit.body),
);
check("the server returned ITS OWN score", typeof submit.body.run?.score === "number");
// A rank, not rank ONE. The store is process-wide and survives between smoke
// runs, so asserting first place would pass only on a freshly started server.
check("ranks came back with the submission", typeof submit.body.ranks?.allTime === "number");

// ── The same token again ────────────────────────────────────────────────────
const replayAgain = await call("/api/run/submit", {
  method: "POST",
  body: JSON.stringify({
    runToken: start.body.runToken,
    replayBlob: Buffer.from(replay).toString("base64"),
    elapsedMs: (TICKS / 60) * 1000,
  }),
});
check(
  "a reused token is refused with 409",
  replayAgain.status === 409,
  `got ${replayAgain.status} ${replayAgain.body.reason ?? ""}`,
);

// ── A forged replay ─────────────────────────────────────────────────────────
const forgeStart = await call("/api/run/start", { method: "POST", body: "{}" });
const forged = playRun(forgeStart.body.seed, TICKS, forgeStart.body.shards);
/*
 * A RANGE of bytes, not one.
 *
 * The first version of this flipped a single input byte and the submission
 * validated — correctly. Not every input change alters the outcome: an intent is
 * a no-op if the player is already in that lane, mid-roll-commit, or airborne,
 * so a one-byte flip can genuinely produce the identical final state. That is
 * the verifier being right, not lenient.
 *
 * A forgery worth testing has to change something the sim acts on, so this
 * rewrites a 200-tick span in the middle of the run.
 */
const HEADER_BYTES = 20;
const TAMPER_FROM = HEADER_BYTES + 400;
const TAMPER_TO = TAMPER_FROM + 200;
for (let i = TAMPER_FROM; i < TAMPER_TO; i += 1) {
  forged[i] = forged[i] ^ 0b11;
}
const forgery = await call("/api/run/submit", {
  method: "POST",
  body: JSON.stringify({
    runToken: forgeStart.body.runToken,
    replayBlob: Buffer.from(forged).toString("base64"),
    elapsedMs: (TICKS / 60) * 1000,
  }),
});
check(
  "a tampered replay is refused with 422",
  forgery.status === 422,
  `got ${forgery.status} ${forgery.body.reason ?? ""}`,
);

// ── A farmed seed ───────────────────────────────────────────────────────────
const farmStart = await call("/api/run/start", { method: "POST", body: "{}" });
const farmed = playRun(0xc0ffee, TICKS, 0);
const farming = await call("/api/run/submit", {
  method: "POST",
  body: JSON.stringify({
    runToken: farmStart.body.runToken,
    replayBlob: Buffer.from(farmed).toString("base64"),
    elapsedMs: (TICKS / 60) * 1000,
  }),
});
check(
  "a replay of a self-chosen seed is refused",
  farming.status === 422,
  `got ${farming.status} ${farming.body.reason ?? ""}`,
);

// ── Leaderboards ────────────────────────────────────────────────────────────
for (const scope of ["all-time", "weekly", "daily", "friends"]) {
  const board = await call(`/api/leaderboard?scope=${scope}`);
  check(
    `GET /api/leaderboard?scope=${scope}`,
    board.status === 200 && board.body.ok,
    `${board.body.board?.total ?? 0} entries`,
  );
}
const badScope = await call("/api/leaderboard?scope=monthly");
check("an unknown scope is refused", badScope.status === 400);

const rank = await call("/api/leaderboard/rank");
check(
  "GET /api/leaderboard/rank",
  rank.status === 200 && typeof rank.body.ranks?.allTime === "number",
);

// ── Cloud save ──────────────────────────────────────────────────────────────
const first = await call("/api/save", {
  method: "PUT",
  body: JSON.stringify({
    version: 3,
    updatedAt: 2000,
    currencies: { bits: 8000 },
    payload: { a: 1 },
  }),
});
check("PUT /api/save stores a save", first.status === 200 && first.body.ok);

const stale = await call("/api/save", {
  method: "PUT",
  body: JSON.stringify({
    version: 3,
    updatedAt: 1000,
    currencies: { bits: 12 },
    payload: { a: 2 },
  }),
});
check(
  "a stale sync CANNOT reduce a balance",
  stale.body.save?.currencies?.bits === 8000,
  `bits ${stale.body.save?.currencies?.bits}`,
);
check("the protection is reported", (stale.body.protectedCurrencies ?? []).includes("bits"));

const badSave = await call("/api/save", {
  method: "PUT",
  body: JSON.stringify({ version: 3, updatedAt: 1, currencies: { bits: null }, payload: {} }),
});
check("a malformed save is refused", badSave.status === 400);

// ── Telemetry ───────────────────────────────────────────────────────────────
const withoutConsent = await call("/api/telemetry", {
  method: "POST",
  body: JSON.stringify({ events: [{ kind: "run-end", values: { distance: 100 } }] }),
});
check("telemetry without consent is refused", withoutConsent.status === 403);

await call("/api/identity", { method: "PATCH", body: JSON.stringify({ telemetryConsent: true }) });
const withConsent = await call("/api/telemetry", {
  method: "POST",
  body: JSON.stringify({
    events: [
      { kind: "run-end", values: { distance: 100, flow: 40, email: "a@b.c" } },
      { kind: "not-a-real-kind", values: {} },
    ],
  }),
});
check(
  "telemetry with consent is accepted",
  withConsent.status === 200 && withConsent.body.accepted === 1,
);
check("an unknown event kind is dropped", withConsent.body.dropped === 1);

// ── Friends ─────────────────────────────────────────────────────────────────
const friends = await call("/api/identity/friends");
check(
  "GET /api/identity/friends returns a share code",
  friends.status === 200 && typeof friends.body.friendCode === "string",
);

console.log("=".repeat(72));
console.log(failures === 0 ? "  ALL CHECKS PASSED" : `  ${failures} CHECK(S) FAILED`);
console.log("=".repeat(72));
process.exitCode = failures === 0 ? 0 : 1;
