INSERT OR IGNORE INTO app_meta(key, value) VALUES ('selected_campaign_id', 'cmp_001');

INSERT OR IGNORE INTO campaigns (
  id, name, setting, status, readiness, session_count, players_json, source_books_json, active_map_id, active_encounter_id, created_at
) VALUES (
  'cmp_001',
  'The Cinder March',
  'Post-dragon frontier',
  'In Progress',
  72,
  6,
  '["Asha","Thorn","Mira"]',
  '["book_core_5e"]',
  'map_001',
  'enc_001',
  strftime('%s','now')
);

INSERT OR IGNORE INTO books (id, title, type, tags_json, chapters_json, created_at) VALUES
('book_core_5e', 'Core Rules SRD', 'Official', '["rules","spells","monsters"]', '["Character Creation","Combat","Magic","Monsters"]', strftime('%s','now')),
('book_dm_guide', 'Dungeon Master Guide', 'Official', '["loot","encounters","worldbuilding"]', '["Campaign Arcs","NPC Design","Treasure Tables"]', strftime('%s','now'));

INSERT OR IGNORE INTO characters (
  id, campaign_id, name, class_name, level, ac, hp, speed, stats_json, proficiencies_json, spells_json, inventory_json, created_at
) VALUES
(
  'char_001',
  'cmp_001',
  'Asha Emberforge',
  'Artificer',
  3,
  15,
  24,
  30,
  '{"str":10,"dex":14,"con":14,"int":17,"wis":12,"cha":11}',
  '["Arcana","Investigation","Thieves'' Tools"]',
  '["Cure Wounds","Faerie Fire","Grease"]',
  '["Repeating Shot Crossbow","Tinker''s Tools","Alchemist''s Fire"]',
  strftime('%s','now')
),
(
  'char_002',
  'cmp_001',
  'Thorn Valewind',
  'Ranger',
  3,
  14,
  28,
  35,
  '{"str":12,"dex":17,"con":13,"int":10,"wis":15,"cha":9}',
  '["Stealth","Survival","Perception"]',
  '["Hunter''s Mark","Goodberry"]',
  '["Longbow","Twin Shortswords","Herbalism Kit"]',
  strftime('%s','now')
);

INSERT OR IGNORE INTO encounters (
  id, campaign_id, name, difficulty, monsters_json, xp_budget, created_at
) VALUES (
  'enc_001',
  'cmp_001',
  'Gatehouse Ambush',
  'Medium',
  '["2x Ash Goblin","1x Ember Hound"]',
  450,
  strftime('%s','now')
);

INSERT OR IGNORE INTO maps (
  id, campaign_id, name, width, height, fog_enabled, dynamic_lighting, created_at
) VALUES (
  'map_001',
  'cmp_001',
  'Ashfall Outpost',
  10,
  10,
  1,
  1,
  strftime('%s','now')
);

INSERT OR IGNORE INTO tokens (id, map_id, label, color, x, y, faction, created_at) VALUES
('tok_party_asha', 'map_001', 'A', '#116466', 1, 1, 'party', strftime('%s','now')),
('tok_party_thorn', 'map_001', 'T', '#2e5aac', 2, 1, 'party', strftime('%s','now')),
('tok_enemy_warden', 'map_001', 'W', '#d95d39', 7, 6, 'enemy', strftime('%s','now'));

INSERT OR IGNORE INTO initiative_turns (id, campaign_id, name, value, created_at) VALUES
('init_001', 'cmp_001', 'Thorn', 18, strftime('%s','now')),
('init_002', 'cmp_001', 'Asha', 15, strftime('%s','now')),
('init_003', 'cmp_001', 'Ash Goblin', 13, strftime('%s','now'));

INSERT OR IGNORE INTO chat_log (id, campaign_id, speaker, text, created_at) VALUES
('chat_001', 'cmp_001', 'GM', 'The ash gate cracks open as drums echo from below.', strftime('%s','now'));

INSERT OR IGNORE INTO gm_settings (
  campaign_id, gm_name, gm_style, safety_profile, primary_rulebook, updated_at
) VALUES (
  'cmp_001',
  'Narrator Prime',
  'Cinematic Tactical',
  'Table-Friendly',
  'Core Rules SRD',
  strftime('%s','now')
);
