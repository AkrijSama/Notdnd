export function createSeedState() {
  return {
    stateVersion: 1,
    campaignVersions: {
      cmp_001: 1
    },
    selectedCampaignId: "cmp_001",
    userPrefsByUser: {},
    campaignMembersByCampaign: {
      cmp_001: []
    },
    users: [],
    sessions: [],
    journalsByCampaign: {
      cmp_001: [
        {
          id: "jrnl_001",
          campaignId: "cmp_001",
          title: "Session 6 Prep",
          body: "Party enters the ash gate. Ambush trigger near the northern wall.",
          tags: ["prep", "session-6"],
          visibility: "gm",
          authorUserId: null,
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000)
        }
      ]
    },
    revealedCellsByMap: {
      map_001: {
        "1,1": true,
        "2,1": true,
        "3,1": true,
        "1,2": true
      }
    },
    recentRollsByCampaign: {
      cmp_001: []
    },
    campaignPackagesByCampaign: {
      cmp_001: {
        campaignId: "cmp_001",
        chapters: [
          {
            id: "chapter_001",
            title: "Ash Gate Pressure",
            summary: "The party must hold the outpost while the ash gate begins to fail.",
            keywords: ["ash", "gate", "pressure"]
          }
        ],
        scenes: [
          {
            id: "scene_001",
            name: "Ashfall Outpost",
            chapterTitle: "Ash Gate Pressure",
            locationName: "Ashfall Outpost",
            objective: "Stabilize the gate before cultists reach the inner wall.",
            summary: "A defensive opening scene with urgency and visible consequences.",
            mapId: "map_001",
            encounterId: "enc_001",
            keywords: ["outpost", "gate", "defense"]
          }
        ],
        npcs: [
          {
            id: "npc_001",
            name: "Warden Elra",
            role: "guide",
            summary: "Quest giver and field commander for the outpost.",
            keywords: ["warden", "elra", "guide"]
          }
        ],
        items: [
          {
            id: "item_001",
            name: "Gatehouse Seal",
            kind: "plot-device",
            summary: "A failing seal that can close the breach if restored.",
            keywords: ["seal", "gate", "plot"]
          }
        ],
        spells: [
          {
            id: "spell_001",
            name: "Healing Word",
            summary: "Common emergency support spell in the opening defense."
          }
        ],
        rules: [
          {
            id: "rule_001",
            name: "Ash Visibility",
            summary: "Heavy ash reduces sight lines and raises tension.",
            keywords: ["ash", "visibility", "hazard"]
          }
        ],
        starterOptions: [
          {
            id: "starter_001",
            className: "Ranger",
            hook: "Tie the ranger to the perimeter scouts.",
            spell: "Hunter's Mark",
            keywords: ["ranger", "scout"]
          }
        ]
      }
    },
    campaigns: [
      {
        id: "cmp_001",
        name: "The Cinder March",
        setting: "Post-dragon frontier",
        status: "In Progress",
        readiness: 72,
        sessionCount: 6,
        players: ["Asha", "Thorn", "Mira"],
        sourceBooks: ["book_core_5e"],
        activeMapId: "map_001",
        activeEncounterId: "enc_001",
        createdAt: Math.floor(Date.now() / 1000)
      }
    ],
    books: [
      {
        id: "book_core_5e",
        title: "Core Rules SRD",
        type: "Official",
        tags: ["rules", "spells", "monsters"],
        chapters: ["Character Creation", "Combat", "Magic", "Monsters"],
        createdAt: Math.floor(Date.now() / 1000)
      },
      {
        id: "book_dm_guide",
        title: "Dungeon Master Guide",
        type: "Official",
        tags: ["loot", "encounters", "worldbuilding"],
        chapters: ["Campaign Arcs", "NPC Design", "Treasure Tables"],
        createdAt: Math.floor(Date.now() / 1000)
      }
    ],
    characters: [
      {
        id: "char_001",
        campaignId: "cmp_001",
        name: "Asha Emberforge",
        className: "Artificer",
        level: 3,
        ac: 15,
        hp: 24,
        speed: 30,
        stats: { str: 10, dex: 14, con: 14, int: 17, wis: 12, cha: 11 },
        proficiencies: ["Arcana", "Investigation", "Thieves' Tools"],
        spells: ["Cure Wounds", "Faerie Fire", "Grease"],
        inventory: ["Repeating Shot Crossbow", "Tinker's Tools", "Alchemist's Fire"],
        createdAt: Math.floor(Date.now() / 1000)
      },
      {
        id: "char_002",
        campaignId: "cmp_001",
        name: "Thorn Valewind",
        className: "Ranger",
        level: 3,
        ac: 14,
        hp: 28,
        speed: 35,
        stats: { str: 12, dex: 17, con: 13, int: 10, wis: 15, cha: 9 },
        proficiencies: ["Stealth", "Survival", "Perception"],
        spells: ["Hunter's Mark", "Goodberry"],
        inventory: ["Longbow", "Twin Shortswords", "Herbalism Kit"],
        createdAt: Math.floor(Date.now() / 1000)
      }
    ],
    encounters: [
      {
        id: "enc_001",
        campaignId: "cmp_001",
        name: "Gatehouse Ambush",
        difficulty: "Medium",
        monsters: ["2x Ash Goblin", "1x Ember Hound"],
        xpBudget: 450,
        createdAt: Math.floor(Date.now() / 1000)
      }
    ],
    maps: [
      {
        id: "map_001",
        campaignId: "cmp_001",
        name: "Ashfall Outpost",
        width: 10,
        height: 10,
        fogEnabled: true,
        dynamicLighting: true,
        imageUrl: "ASSET_MAP_PLACEHOLDER_1",
        createdAt: Math.floor(Date.now() / 1000)
      }
    ],
    tokensByMap: {
      map_001: [
        { id: "tok_party_asha", label: "A", color: "#116466", x: 1, y: 1, faction: "party" },
        { id: "tok_party_thorn", label: "T", color: "#2e5aac", x: 2, y: 1, faction: "party" },
        { id: "tok_enemy_warden", label: "W", color: "#d95d39", x: 7, y: 6, faction: "enemy" }
      ]
    },
    initiative: [
      { id: "init_001", campaignId: "cmp_001", name: "Thorn", value: 18, createdAt: Math.floor(Date.now() / 1000) },
      { id: "init_002", campaignId: "cmp_001", name: "Asha", value: 15, createdAt: Math.floor(Date.now() / 1000) },
      { id: "init_003", campaignId: "cmp_001", name: "Ash Goblin", value: 13, createdAt: Math.floor(Date.now() / 1000) }
    ],
    chatLog: [
      {
        id: "chat_001",
        campaignId: "cmp_001",
        speaker: "GM",
        text: "The ash gate cracks open as drums echo from below.",
        createdAt: Math.floor(Date.now() / 1000)
      }
    ],
    aiJobs: [],
    gmSettingsByCampaign: {
      cmp_001: {
        gmName: "Narrator Prime",
        gmStyle: "Cinematic Tactical",
        safetyProfile: "Table-Friendly",
        primaryRulebook: "Core Rules SRD",
        gmMode: "human",
        agentProvider: "local",
        agentModel: "local-gm-v1",
        updatedAt: Math.floor(Date.now() / 1000)
      }
    }
  };
}
