// ---------------------------------------------------------------------------
// MOMENTUM EVENT TEMPLATES — server-authored complications the world commits
// on its own initiative (see server/solo/momentum.js for the engine).
//
// Doctrine (same as searchDetails / questOffers): these are AUTHORED TRUTH the
// server INSTANTIATES. Every template's build() returns the committed-state
// payload the event stands on — an NPC to place in the cast, an objectState to
// flip on the location, or a real quest to instantiate. The event EXISTS in
// state before a word is narrated; the GM narrates the committed record and
// never mints its own. A template with no committable payload is a bug.
//
// Selection is server-side and seeded-deterministic (no Math.random): the
// engine passes a seed derived from the run's worldSeed + turn counter. An
// LLM MAY be given the shortlist to RANK (rankFn slot) but can never add to it.
// ---------------------------------------------------------------------------

function isStr(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toneOf(run) {
  const tone = run?.world?.tone;
  return isStr(tone) ? tone.trim() : "grim uncertainty";
}

function worldNameOf(run) {
  const name = run?.world?.name;
  return isStr(name) ? name.trim() : "this land";
}

function locationOf(run) {
  return run?.locations?.[run?.currentLocationId] || {};
}

function locName(run) {
  const loc = locationOf(run);
  return isStr(loc.name) ? loc.name : "this place";
}

// A connected location to point hooks at — prefers somewhere NOT yet visited so
// pressure pushes OUTWARD; falls back to any exit. Null when the graph is bare.
function onwardLocation(run) {
  const loc = locationOf(run);
  const ids = Array.isArray(loc.connectedLocationIds) ? loc.connectedLocationIds : [];
  const candidates = ids.map((id) => run.locations?.[id]).filter(Boolean);
  const unvisited = candidates.find((l) => l?.state?.visited !== true);
  return unvisited || candidates[0] || null;
}

// Standard NPC record for an arrival — everything validateSoloRun requires.
function buildArrivalNpc(run, { npcId, displayName, role, beatLabel, beatText }) {
  return {
    npcId,
    displayName,
    role,
    currentLocationId: run.currentLocationId,
    known: true,
    status: "present",
    memoryFactIds: [],
    ageClass: "adult", // momentum arrivals (couriers, watchers, refugees) are adults
    tags: ["momentum"],
    flags: { momentumArrival: true },
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: [],
    // origin is enum-validated (procedural|user|hybrid); momentum arrivals ARE
    // procedurally generated — the momentum marker lives in tags/flags.
    origin: "procedural",
    dialogueBeats: [
      {
        beatId: `${npcId}_beat`,
        label: beatLabel,
        text: beatText,
        revealed: false,
        repeatable: true,
        linkedQuestIds: [],
        contentTags: []
      }
    ]
  };
}

// Standard hook-quest record (mirrors createMainQuest's shape; isMain:false,
// authoredBy "momentum" so it reads as world pressure, flags.playerAccepted
// unset — chips still prefer what the player explicitly took on).
function buildHookQuest({ questId, title, description, stages, reward = null }) {
  return {
    questId,
    status: "active",
    isMain: false,
    authoredBy: "momentum",
    title,
    description,
    stages,
    stage: 0,
    objective: stages[0].objective,
    completion: stages[0].completion,
    ...(reward ? { reward } : {}),
    relatedEntityIds: [],
    memoryFactIds: [],
    flags: { momentumHook: true }
  };
}

// ---------------------------------------------------------------------------
// THE POOL. locationKinds match against location.tags (loose overlap); "any"
// matches everywhere. Each build(run, ctx) returns:
//   { title, brief, decision, npc? , objectState?, quest? }
// brief = one grounded sentence for the GM; decision = the choice it poses.
// ---------------------------------------------------------------------------
export const MOMENTUM_TEMPLATES = [
  // ── ARRIVALS — a real person enters the cast ──────────────────────────────
  {
    templateId: "arrival_courier",
    kind: "arrival",
    locationKinds: ["any"],
    build(run) {
      const onward = onwardLocation(run);
      const destName = onward ? onward.name : "the far side of " + worldNameOf(run);
      const npc = buildArrivalNpc(run, {
        npcId: "npc_momentum_courier",
        displayName: "A winded courier",
        role: "courier",
        beatLabel: "A message that can't wait",
        beatText:
          `"You there, I can't go further on this leg. A message has to reach ${destName}, and the one who sent it pays on proof of delivery. ` +
          `Take it or don't, but decide fast."`
      });
      // The courier carries a REAL offer: accepting instantiates a tracked
      // delivery hook through the existing questFlow machinery.
      if (onward) {
        npc.questOffer = {
          accepted: false,
          destinationId: onward.locationId,
          offerText: npc.dialogueBeats[0].text,
          acceptedText: `You took the courier's message, carry word to ${destName}.`,
          quest: buildHookQuest({
            questId: "quest_momentum_message",
            title: `Word for ${destName}`,
            description: `A spent courier pressed a sealed message on you at ${locName(run)}. It has to reach ${destName}.`,
            stages: [
              {
                objective: `Carry the courier's message to ${destName}.`,
                completion: { kind: "reach_location", targetId: onward.locationId }
              }
            ],
            reward: { xp: 60 }
          })
        };
      }
      return {
        title: "A courier stumbles in",
        brief: `A winded courier has just arrived at ${locName(run)}, spent and urgent, carrying a message that must reach ${destName}.`,
        decision: "Take the courier's job, question them, or turn away.",
        npc
      };
    }
  },
  {
    templateId: "arrival_watcher",
    kind: "arrival",
    locationKinds: ["any"],
    build(run) {
      return {
        title: "You are being watched",
        brief: `A figure who has been shadowing the player finally steps into view at ${locName(run)}, unhurried, deliberate, making no secret of it now.`,
        decision: "Confront the watcher, hail them, or move on and let them follow.",
        npc: buildArrivalNpc(run, {
          npcId: "npc_momentum_watcher",
          displayName: "A patient watcher",
          role: "stranger",
          beatLabel: "Why they follow",
          beatText:
            `"Don't stop on my account. I've watched you since the road. Word travels about strangers in ${worldNameOf(run)}, I wanted to see if the word was true."`
        })
      };
    }
  },
  {
    templateId: "arrival_scavenger",
    kind: "arrival",
    locationKinds: ["ruins", "wild", "forest", "destination", "gatehouse", "placeholder"],
    build(run) {
      return {
        title: "A rival picks the same ground",
        brief: `A scavenger has arrived at ${locName(run)} with tools and intent, treating the ground, and anything in it, as already theirs.`,
        decision: "Stake your claim, bargain a split, or let them work.",
        npc: buildArrivalNpc(run, {
          npcId: "npc_momentum_scavenger",
          displayName: "A wiry scavenger",
          role: "scavenger",
          beatLabel: "First claim",
          beatText: `"Everything under this ${toneOf(run)} sky gets picked over sooner or later. I was here first, unless you mean to argue it."`
        })
      };
    }
  },
  {
    templateId: "arrival_refugee",
    kind: "arrival",
    locationKinds: ["market", "tavern", "crossing", "watch", "settlement", "curfew"],
    build(run) {
      const onward = onwardLocation(run);
      return {
        title: "Someone flees in",
        brief: `A traveler staggers into ${locName(run)}, hurt and scared, fleeing something on the road${onward ? ` toward ${onward.name}` : ""}.`,
        decision: "Help them, press them for what they fled, or keep your distance.",
        npc: buildArrivalNpc(run, {
          npcId: "npc_momentum_refugee",
          displayName: "A shaken traveler",
          role: "refugee",
          beatLabel: "What they fled",
          beatText: `"Turn back if you value your neck. The road behind me isn't empty anymore, and it took the others first."`
        })
      };
    }
  },

  // ── HAZARDS — the environment itself changes (objectState, tracked) ───────
  {
    templateId: "hazard_collapse",
    kind: "hazard",
    locationKinds: ["ruins", "destination", "gatehouse", "placeholder"],
    build(run) {
      return {
        title: "Something gives way",
        brief: `With a grinding crack, old masonry at ${locName(run)} finally gives, the east wall is coming down, and the dust is still settling.`,
        decision: "Salvage what the collapse exposed, get clear, or dig into what it revealed.",
        objectState: {
          locationId: run.currentLocationId,
          key: "the-east-wall",
          state: "collapsed",
          label: "the east wall",
          retryEffect: "blocked",
          reason: "brought down by age and strain"
        }
      };
    }
  },
  {
    templateId: "hazard_fire",
    kind: "hazard",
    locationKinds: ["market", "tavern", "crossing", "watch", "settlement", "curfew"],
    build(run) {
      return {
        title: "Smoke, then flame",
        brief: `A fire has broken out in an outbuilding at ${locName(run)}, smoke first, now open flame, and people are starting to shout.`,
        decision: "Help fight the fire, use the chaos, or stay out of it.",
        objectState: {
          locationId: run.currentLocationId,
          key: "the-outbuilding",
          state: "burning",
          label: "the outbuilding",
          retryEffect: "harder",
          reason: "flame spreading through dry timber"
        },
        // item 4b: a SPREADING fire is a deadline — commit the clock so "spreading"
        // is real, and the blaze goes loose on expiry.
        deadline: {
          minutes: 20,
          consequenceBrief: `The fire at ${locName(run)} has spread past the outbuilding, the blaze is loose now.`,
          consequenceDecision: "Flee the spreading fire, or throw yourself at containing it."
        }
      };
    }
  },
  {
    templateId: "hazard_storm",
    kind: "hazard",
    locationKinds: ["any"],
    build(run) {
      return {
        title: "The weather turns",
        brief: `The sky over ${locName(run)} has turned fast and mean, a hard storm is minutes away and the light is failing.`,
        decision: "Find or make shelter, push on into it, or use the cover it gives.",
        objectState: {
          locationId: run.currentLocationId,
          key: "the-sky",
          state: "storm-breaking",
          label: "the sky",
          retryEffect: "harder",
          reason: "wind and stinging rain closing in"
        },
        // item 4b: "minutes away" is a REAL deadline — commit a thread clock so the
        // urgency is honest (deadlineAudit), and the storm actually breaks on expiry.
        deadline: {
          minutes: 30,
          consequenceBrief: `The storm has broken over ${locName(run)}, driving rain and failing light are on the player now.`,
          consequenceDecision: "Weather it where you are, or press on through the storm."
        }
      };
    }
  },
  {
    templateId: "hazard_tracks",
    kind: "hazard",
    locationKinds: ["wild", "forest", "ruins", "destination", "placeholder"],
    build(run) {
      return {
        title: "Fresh tracks, too fresh",
        brief: `Fresh tracks cross ${locName(run)}, large, recent, and headed the same way the player is. Whatever made them is close.`,
        decision: "Follow the tracks, prepare an ambush of your own, or change course.",
        objectState: {
          locationId: run.currentLocationId,
          key: "the-fresh-tracks",
          state: "discovered",
          label: "fresh tracks",
          retryEffect: null,
          reason: "something large passed through very recently"
        }
      };
    }
  },

  // ── HOOKS — time pressure instantiated as a REAL tracked quest ─────────────
  {
    templateId: "hook_hunted",
    kind: "hook",
    locationKinds: ["any"],
    build(run) {
      const onward = onwardLocation(run);
      if (!onward) return null; // graph too bare, engine will pick another template
      return {
        title: "Something is on your trail",
        brief: `It is no longer a feeling: something is tracking the player through ${worldNameOf(run)}, and staying still is now a choice with a cost.`,
        decision: `Move, ${onward.name} would break the trail, or turn and face what follows.`,
        quest: buildHookQuest({
          questId: "quest_momentum_hunted",
          title: "Shake what follows",
          description: `Something has the player's trail. Keep moving, reaching ${onward.name} would break it.`,
          stages: [
            {
              objective: `Break the trail, reach ${onward.name} before what follows closes in.`,
              completion: { kind: "reach_location", targetId: onward.locationId }
            }
          ],
          reward: { xp: 60 }
        })
      };
    }
  },
  {
    templateId: "hook_smoke",
    kind: "hook",
    locationKinds: ["any"],
    build(run) {
      const onward = onwardLocation(run);
      if (!onward) return null;
      return {
        title: "Smoke on the horizon",
        brief: `A column of smoke has risen in the direction of ${onward.name}, thick, black, and recent. Something is burning, or someone is signaling.`,
        decision: `Investigate the smoke at ${onward.name}, or note it and stay your course.`,
        quest: buildHookQuest({
          questId: "quest_momentum_smoke",
          title: "The smoke column",
          description: `Black smoke rose in the direction of ${onward.name}. Fires like that mean people, in trouble, or making it.`,
          stages: [
            {
              objective: `Find the source of the smoke near ${onward.name}.`,
              completion: { kind: "reach_location", targetId: onward.locationId }
            }
          ],
          reward: { xp: 60 }
        })
      };
    }
  },
  {
    templateId: "hook_cache",
    kind: "hook",
    locationKinds: ["ruins", "wild", "forest", "destination", "placeholder"],
    build(run) {
      return {
        title: "A fresh cache-mark",
        brief: `Scratched into stone at ${locName(run)}: a cache-mark, the kind travelers leave over buried stores, and this one is fresh.`,
        decision: "Dig for the cache (a real attempt, it may be trapped or contested), or leave it be.",
        quest: buildHookQuest({
          questId: "quest_momentum_cache",
          title: "The fresh cache-mark",
          description: `A fresh cache-mark at ${locName(run)} promises buried stores to whoever digs first.`,
          stages: [
            {
              objective: "Dig out the marked cache, a real attempt, and a botch may cost you.",
              // Bound check (quests.js checkRollBinds): only a cache-directed
              // attempt AT this location resolves this stage.
              completion: {
                kind: "check",
                locationId: run.currentLocationId,
                subjectKeywords: ["cache", "mark", "dig", "stash", "buried"]
              }
            }
          ],
          reward: {
            xp: 80,
            item: {
              itemId: "momentum_cache_stores",
              name: "Cached stores",
              description: "Traveler's stores dug out from a marked cache, cordage, dried food, a stoppered flask.",
              qty: 1,
              usable: false,
              consumable: false,
              tags: ["momentum", "loot"]
            }
          }
        })
      };
    }
  },
  {
    templateId: "hook_tollman",
    kind: "hook",
    locationKinds: ["crossing", "market", "watch", "settlement", "curfew", "tavern"],
    build(run) {
      const onward = onwardLocation(run);
      if (!onward) return null;
      return {
        title: "The road is being closed",
        brief: `Word moves through ${locName(run)}: the way toward ${onward.name} is being closed off, anyone meaning to pass had better do it soon.`,
        decision: `Beat the closure, make for ${onward.name} now, or stay and see who is closing it, and why.`,
        quest: buildHookQuest({
          questId: "quest_momentum_closure",
          title: "Beat the closure",
          description: `The way toward ${onward.name} is being shut. Pass now, or find out who wants it shut.`,
          stages: [
            {
              objective: `Get through to ${onward.name} before the way is closed.`,
              completion: { kind: "reach_location", targetId: onward.locationId }
            }
          ],
          reward: { xp: 60 }
        }),
        // item 4b: "do it soon / before the way is closed" is a deadline — commit the
        // clock so the closure is a real window, shut on expiry.
        deadline: {
          minutes: 60,
          consequenceBrief: `The way toward ${onward.name} has been closed, the window to pass ahead of the shutdown is gone.`,
          consequenceDecision: "Find another route, or find out who closed it and why."
        }
      };
    }
  }
];

/**
 * The candidate shortlist for a run: templates whose locationKinds match the
 * current location's tags ("any" matches everywhere), that have not fired yet
 * this run, and whose committed payload would not collide with existing state
 * (npc/quest id already present). Falls back to unfired "any" templates when
 * tag-matching leaves nothing.
 * @param {object} run
 * @param {string[]} firedTemplateIds
 * @returns {object[]} template list (possibly empty)
 */
export function momentumCandidates(run, firedTemplateIds = []) {
  const tags = (locationOf(run).tags || []).map((t) => String(t).toLowerCase());
  const fired = new Set(firedTemplateIds);
  const collides = (template) => {
    // Pre-instantiation collision guard: an arrival whose npcId, or a hook whose
    // questId, already exists in state can't fire again.
    try {
      const built = template.build(run);
      if (!built) return true;
      if (built.npc && run.npcs?.[built.npc.npcId]) return true;
      if (built.quest && run.quests?.[built.quest.questId]) return true;
      return false;
    } catch {
      return true;
    }
  };
  const matches = (template) =>
    template.locationKinds.includes("any") || template.locationKinds.some((kind) => tags.includes(kind));
  const pool = MOMENTUM_TEMPLATES.filter((t) => !fired.has(t.templateId) && !collides(t));
  const tagged = pool.filter(matches);
  return tagged.length > 0 ? tagged : pool.filter((t) => t.locationKinds.includes("any"));
}
