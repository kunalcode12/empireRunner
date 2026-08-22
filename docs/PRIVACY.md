# AXIS — privacy note

**What this document is.** A description of exactly what AXIS sends to its server, why, and
what it does not send. It describes the code in [`src/server/`](../src/server/), and where the
two disagree the code is wrong — a privacy note that does not match the implementation is a
promise being broken in writing.

The claims below are enforced by [`tests/server/telemetry.test.ts`](../tests/server/telemetry.test.ts),
not by good intentions.

---

## 1. You do not need an account

The first run is not gated behind a signup. Opening the game creates an **anonymous device
identity**: an opaque random id in a cookie, tied to nothing. No email, no phone number, no
social login, no device fingerprint.

You can play, submit runs, and appear on the leaderboard without ever telling us who you are.

If you later choose to create a real account, your existing identity is **linked** rather than
replaced — your leaderboard places and your save carry over, because the id they point at never
changes.

---

## 2. What is stored about a run

When you finish a run and it is submitted, the server keeps:

| Field | Why |
|---|---|
| Your anonymous player id | To attribute the run to a leaderboard row |
| The score and distance | **Computed by the server**, by re-running your inputs. Your device does not report a score |
| The seed the server issued | To re-verify the run later if it is disputed |
| The tick count | Run length, and part of the anti-cheat |
| The time the server received it | To decide which daily and weekly board it counts toward |
| Your display name | Whatever you chose. The default is generated ("Runner 4F2A") |

**The replay itself — your input log — is used for verification and is not retained after the
verdict.** It is a list of which direction you pressed on each 1/60th of a second. It contains
nothing about you.

### Why the server re-runs your inputs

Any leaderboard that accepts a score reported by the player is topped within a day by someone
typing a large number into their browser console. The only defence that works is for the server
to re-run the game itself from your inputs and compute the score independently. That is what
happens, and it is why the game sends inputs rather than a score.

---

## 3. Telemetry — off unless you turn it on

Anonymous gameplay telemetry is **opt-in**. Nothing is sent unless you have explicitly turned
it on, and the server refuses events from a player who has not
([`server/telemetry.ts`](../src/server/telemetry.ts)).

If you do turn it on, these are the only things sent:

| Event | Fields |
|---|---|
| Run ended | distance, which obstacle type killed you, Flow at death, score, run length in ticks, which theme |
| Overdrive used | distance, Flow, how long it lasted |
| Fracture attempted | distance, whether you survived, which verb was required, how many you had used |
| Session started | *(nothing but the timestamp)* |
| Session ended | how long the session was, how many runs |

It is used for one thing: balancing the game. "Where do players actually die", "is Fracture too
hard", "does anyone use Overdrive".

### No personal data is possible, not merely forbidden

**Every field above is a number, from a fixed list.** There is nowhere in a telemetry event to
put a string. That means there is nowhere to put an email address, a name, a device
fingerprint, a URL, or a file path — not because we agreed not to, but because the shape of the
data does not permit it. Anything not on the list is discarded at the boundary before it is
stored.

Timestamps are the **server's**, not your device's. Your clock is not read, because clock skew
is surprisingly identifying.

You can turn telemetry off again at any time, and nothing further is collected.

---

## 4. Cloud save

If you sync your progress, the server stores your currencies, upgrades, inventory, missions and
lifetime statistics — the same things already in your local save file. It is game state and
nothing else.

One rule is worth stating because it protects you rather than us: **a sync can never reduce a
balance.** If two devices disagree about how many Bits you have, the higher number wins. You
cannot lose progress by opening the game on an old phone.

---

## 5. IP addresses

Your IP address is used **transiently** for rate limiting — to stop one machine flooding the
submission endpoint. It is held in memory, in a bucket that is discarded once it is idle, and
it is **not written to the leaderboard, the run record, or telemetry**.

---

## 6. What is never collected

- Email addresses, phone numbers, real names
- Contact lists — the friends feature works through a short code you choose to share
- Advertising identifiers, cross-site tracking, third-party analytics
- Device fingerprints
- Anything you type, apart from a display name you deliberately set

There are no third-party analytics or advertising SDKs in this game. The dependency list is in
[`docs/ARCHITECTURE.md` §4](./ARCHITECTURE.md) and every entry has one documented purpose.

---

## 7. Deleting your data

Clearing your browser's site data removes the anonymous identity, and the server has no way to
associate you with it afterwards — that is a consequence of never having asked who you are.

Leaderboard rows outlive that, because a leaderboard with disappearing entries is not a
leaderboard. They carry a player id and a display name, and nothing else about you.

---

## 8. Where this is implemented

| Concern | File |
|---|---|
| Anonymous identity, the account upgrade path | [`src/server/identity.ts`](../src/server/identity.ts) |
| Telemetry allowlist and consent gate | [`src/server/telemetry.ts`](../src/server/telemetry.ts) |
| Cloud save, and the monotonic-currency rule | [`src/server/save.ts`](../src/server/save.ts) |
| Rate limiting, and what is done with an address | [`src/server/ratelimit.ts`](../src/server/ratelimit.ts) |
| What a stored run contains | [`src/server/store/types.ts`](../src/server/store/types.ts) |

*Last reviewed: 2026-08-20 (P12).*
