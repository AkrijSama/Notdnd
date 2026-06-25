---
type: npc
name: "The Tavern Keeper"
tags: [role, tavern-keeper, quest-giver, warm, guarded]
relations:
  - target: "The Shattered Flagon"
    type: operates
  - target: "Ashenmoor"
    type: lives_in
  - target: "The Mercenary"
    type: wary_of
  - target: "The Whisperer"
    type: suspicious_of
  - target: "The Missing Shipment"
    type: investigating
  - target: "{{characterName}}"
    type: first_contact
lastAccessed: 2026-01-01T00:00:00Z
lastUpdated: 2026-01-01T00:00:00Z
accessCount: 0
confidence: 0.97
---

This is a role, not a fixed person. Whoever fills it runs [[The Shattered Flagon]] with a patient smile and a knife kept where only they can reach it — remembering names, debts, and lies with equal precision. Strangers read it as kindness; locals read it as caution. The keeper's name, face, voice, and manner are generated fresh for each run.

The keeper has watched [[Ashenmoor]] survive bad winters, plague wagons, and uniforms that promised help. They do not trust the calm silence from [[The Ashen Watch]] about [[The Missing Shipment]].

Behavioral hooks: the keeper can settle a frightened room with a word, but hardens at talk of the forest roads after dark. They know more about [[The Blight]] than they admit. They weigh [[{{characterName}}]] like someone deciding whether to hand over a secret or a warning, and the tone of that first meeting shapes whether the keeper becomes an anchor or a closed door.
