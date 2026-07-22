# ComfyUI idle/size-triggered recycle

Owner stamp 2026-07-22. Companion to the cook resource gate (`server/ai/resourceGate.js`,
"Law-6") and the memory leash (`scripts/comfyui-server.sh`, the `systemd-run --user`
transient unit `comfyui-8188` with `MemoryHigh=24G / MemoryMax=28G / MemorySwapMax=0`).

## The problem (Job 3.1): ComfyUI leaks RSS unboundedly

A long-lived ComfyUI process grows its resident set across cooks and does not give it
back. On the owner's box — an 8 GB RTX 4060 shared with the KDE desktop, ComfyUI run
`--novram` so checkpoint weights stream through **system RAM** — that growth is the
freeze class the memory leash was built to contain. The leash caps the damage
(`MemoryMax=28G`, `MemorySwapMax=0`) but a process pinned against `MemoryHigh` spends
its life in reclaim: every cook slows, and eventually a cold `--novram` render can't get
the RAM working-set it needs and times out.

**Recycle is mitigation, not a fix.** It does not stop ComfyUI from leaking; it restarts
the process before the leak reaches the collar. The real fix lives upstream in ComfyUI /
the custom nodes, and is out of scope here. This module exists so the leak never reaches
the point where it starves a cook or the desktop.

## What accumulates (Job 3.2)

Not cheaply attributable from outside the process. `MemoryCurrent` on the cgroup is the
one number we can read without instrumenting ComfyUI, and it does not break down *what*
is resident — model weights held across cooks, VAE/CLIP caches, Python allocator
fragmentation from repeated large tensor allocs, and custom-node caches all land in the
same figure. Rather than guess, we **stop at the boundary we can measure**: total cgroup
RSS crossing a floor. If a future investigation wants the breakdown it must instrument
ComfyUI itself (tracemalloc / `/system_stats` deltas per node) — that is a separate
effort and is deliberately NOT attempted here.

## Trigger: before-each-cook + idle timer (Job 1.3 justification)

Two triggers, by design:

1. **Before-each-cook (primary).** `withCookSlot` in `resourceGate.js` serializes every
   cook through a module-level promise chain — exactly one cook is ever in flight. At the
   *start* of a slot (no cook running yet) we call `maybeRecycleComfyBeforeCook`. This is
   the strongest never-mid-cook guarantee available: structurally there is no cook to
   interrupt, and the recycle *additionally* refuses if `/queue` reports a running job
   (double guard — see Job 1.2). Recycling here also runs *before* `assertCookResources`,
   so the RAM freed by the restart is visible to the resource gate on the same slot.

2. **Idle timer (secondary).** A `setInterval` (default 300 s, `unref`'d so it never holds
   the process open) checks RSS while the server is idle between sessions. Its job is to
   absorb the cold-start cost (below) *between* play sessions instead of in front of a
   player's first cook. It uses the identical decision path and the same
   never-mid-cook `/queue` refusal.

Before-each-cook alone would always pay cold-start on the first cook after the floor is
crossed. The timer alone would risk a long-running server that never cooks (so never
checks) drifting into the collar. Both together: the player rarely eats a cold start, and
an idle server still self-heals.

## Cold-start cost (Job 2) and why we prefer IDLE

A recycle is a full ComfyUI restart: kill-by-port, relaunch under the leash, wait for
`/system_stats` READY, then the next cook is **cold** (checkpoint reloaded from disk).
Observed downtime for the restart itself in Job 4: **~9.0 s** (RSS 8258→600 MB,
downtime 8972 ms). The first cook after a cold start additionally pays a checkpoint reload
(historically ~150 s for a cold `--novram` render on this card, per the novram-contention
note) versus a warm resident checkpoint.

We do **not** move the failure mode. The gate we already have refuses to cook a starving
machine; recycle simply chooses *when* to pay the cold start. Preferring idle (the timer)
and only-at-slot-start (before-each-cook, never mid-cook) means the cost lands in the gap
between sessions or before a cook that was going to run anyway — never as a mid-render
interruption, and never as an extra cook we would not otherwise have done.

## RSS-threshold vs unresponsive (Job 3.3): distinct reasons, distinct counters

A recycle can fire for two structurally different reasons, and conflating them would let
one mask the other:

- **`rss_threshold`** — cgroup `MemoryCurrent` crossed the floor
  (`NOTDND_COMFY_RECYCLE_RSS_MB`, default 20000 MiB ≈ 20 G, below the 24 G `MemoryHigh`).
  The expected, healthy leak-mitigation path. Counted in `rssRecycleCount`.
- **`unresponsive`** — the unit is active but `/queue` is unreachable (ComfyUI wedged /
  hung, RSS possibly low). Counted separately in `unresponsiveRecycleCount`.

They are logged and counted apart so a recycle can never quietly stand in for a different
failure. A climbing `rssRecycleCount` is the leak doing its normal thing; a climbing
`unresponsiveRecycleCount` is a *crash-loop signal* — ComfyUI is dying for some other
reason and the recycle is papering over it. If the two shared a counter, that second,
more serious failure would be invisible.

## Observability (Job 1.4 / 1.5)

Every recycle logs one `[comfy-recycle] START` line (reason, RSS-at-trigger, queue depth)
and one `[comfy-recycle] DONE` line (downtime ms, RSS-after). `comfyRecycleStatus()`
surfaces in `/api/debug/status` under `image.comfyRecycle`:
`enabled`, `rssFloorMb`, `rssRecycleCount`, `unresponsiveRecycleCount`, `lastRecycleAt`,
`lastReason`, `lastRssBeforeMb`, `lastRssAfterMb`, `lastDowntimeMs`,
`lastQueueDepthAtRecycle`, `lastMeasuredRssMb`, `lastMeasuredAt`.

## Config (Law-6, env-tunable)

- `NOTDND_COMFY_RECYCLE` (default `true`) — master enable.
- `NOTDND_COMFY_RECYCLE_RSS_MB` (default `20000`) — the RSS floor, MiB.
- `NOTDND_COMFY_RECYCLE_MONITOR_MS` (default `300000`, floored at 30000) — idle monitor interval.
- `NOTDND_COMFY_RECYCLE_RESTART_TIMEOUT_MS` (default `180000`) — restart-script timeout.
- `NOTDND_COMFYUI_URL` / `INKBORNE_COMFYUI_URL` (default `http://127.0.0.1:8188`) — the port
  is parsed from here to find both `/queue` and the `comfyui-<port>` leash unit.

On any box with no measurable ComfyUI unit (`MemoryCurrent` unreadable → RSS `null`) the
whole module is a no-op: we never restart a process we cannot measure (CI, a non-comfy
host, someone else's ComfyUI).
