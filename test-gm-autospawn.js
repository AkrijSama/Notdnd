import assert from 'node:assert/strict';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let passed = 0;
let failed = 0;

function logPass(message) {
  passed += 1;
  console.log(`${PASS} ${message}`);
}

function logFail(message, error) {
  failed += 1;
  console.error(`${FAIL} ${message}`);
  if (error) {
    console.error(error.stack || error.message || error);
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    logPass(name);
  } catch (error) {
    logFail(name, error);
  }
}

const sessionData = new Map();

global.sessionStorage = {
  getItem(key) {
    return sessionData.has(key) ? sessionData.get(key) : null;
  },
  setItem(key, value) {
    sessionData.set(key, String(value));
  },
  removeItem(key) {
    sessionData.delete(key);
  },
  clear() {
    sessionData.clear();
  },
};

function createJsonResponse(json, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    async json() {
      return json;
    },
  };
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
  }

  addEventListener(eventType, handler) {
    this.listeners.set(eventType, handler);
  }

  dispatch(eventType, data) {
    const handler = this.listeners.get(eventType);
    if (handler) {
      handler({ data });
    }
  }

  close() {}
}

global.EventSource = FakeEventSource;

const prompting = await import('./server/gm/prompting.js');
const repository = await import('./server/db/repository.js');
const realtime = await import('./src/realtime/client.js');
const client = await import('./src/api/client.js');

console.log('\n=== GM Auto-Spawn Test Suite ===\n');

await runTest('JSON providers parse narrative plus spawn arrays from structured GM output', async () => {
  const parsed = prompting.extractStructuredGMResponse(
    'openai',
    JSON.stringify({
      narrative: 'A goblin scout drops from the rafters.',
      spawn: [
        {
          type: 'monster',
          name: 'Goblin Scout',
          hp: 7,
          ac: 13,
          stats: { str: 8, dex: 14, con: 10, int: 8, wis: 10, cha: 8 },
          actions: ['Scimitar'],
          disposition: 'hostile',
          tokenColor: '#228b22',
        },
      ],
    })
  );

  assert.equal(parsed.format, 'json');
  assert.equal(parsed.narrative, 'A goblin scout drops from the rafters.');
  assert.equal(parsed.spawn.length, 1);
  assert.equal(parsed.spawn[0].name, 'Goblin Scout');
});

await runTest('Anthropic-style XML spawn blocks are parsed alongside narrative text', async () => {
  const parsed = prompting.extractStructuredGMResponse(
    'anthropic',
    [
      'A guard captain steps from the crowd and raises a hand.',
      '<spawn>[{"type":"npc","name":"Guard Captain","hp":18,"ac":15,"stats":{"str":14,"dex":12,"con":12,"int":11,"wis":13,"cha":12},"actions":["Commanding Strike"],"disposition":"neutral","tokenColor":"#3355aa"}]</spawn>',
    ].join('\n')
  );

  assert.equal(parsed.format, 'xml');
  assert.match(parsed.narrative, /guard captain/i);
  assert.equal(parsed.spawn.length, 1);
  assert.equal(parsed.spawn[0].type, 'npc');
});

await runTest('Spawned entities are inserted into campaign tokens and initiative order', async () => {
  const campaignId = `spawn-${Date.now()}`;
  const tokens = repository.addSpawnsToCampaign(campaignId, [
    {
      type: 'monster',
      name: 'Skeleton Bruiser',
      hp: 22,
      ac: 13,
      stats: { str: 14, dex: 12, con: 15, int: 6, wis: 8, cha: 5 },
      actions: ['Rusty Blade'],
      disposition: 'hostile',
      tokenColor: '#c2c2c2',
    },
  ]);

  const state = repository.getCampaignState(campaignId);

  assert.equal(tokens.length, 1);
  assert.equal(state.tokens.length, 1);
  assert.equal(state.initiative.length, 1);
  assert.equal(state.tokens[0].name, 'Skeleton Bruiser');
  assert.equal(state.initiative[0].tokenId, state.tokens[0].id);
});

await runTest('Queued spawns stay pending until approved, then become campaign tokens', async () => {
  const campaignId = `pending-${Date.now()}`;
  const queued = repository.queueSpawnEntries(campaignId, [
    {
      type: 'npc',
      name: 'Traveling Merchant',
      hp: 12,
      ac: 11,
      stats: { str: 10, dex: 11, con: 10, int: 12, wis: 13, cha: 15 },
      actions: ['Offer wares'],
      disposition: 'friendly',
      tokenColor: '#f0a63b',
    },
  ]);

  const approval = repository.approvePendingSpawns(campaignId, [queued[0].id]);
  const state = repository.getCampaignState(campaignId);

  assert.equal(queued.length, 1);
  assert.equal(approval.tokens.length, 1);
  assert.equal(approval.pendingSpawns.length, 0);
  assert.equal(state.pendingSpawns.length, 0);
  assert.equal(state.tokens[0].name, 'Traveling Merchant');
});

await runTest('Realtime client emits gm:spawn events to subscribers', async () => {
  const realtimeClient = realtime.createRealtimeClient('/api/realtime/stream');
  const received = [];

  realtimeClient.subscribe('gm:spawn', (payload) => {
    received.push(payload);
  });

  realtimeClient.source.dispatch('gm:spawn', JSON.stringify({ id: 'token-1', name: 'Bandit' }));

  assert.equal(received.length, 1);
  assert.equal(received[0].name, 'Bandit');

  realtimeClient.disconnect();
});

await runTest('Forced server GM requests keep the local provider selected explicitly', async () => {
  sessionStorage.clear();
  client.saveSettings({
    provider: 'local',
    localEndpoint: 'http://localhost:11434',
    localModel: 'llama3.2',
    autoSpawnEntities: true,
  });

  let capturedRequest = null;
  global.fetch = async (url, options = {}) => {
    capturedRequest = { url, options };
    return createJsonResponse({
      result: 'A wolf prowls into the torchlight.',
      narrative: 'A wolf prowls into the torchlight.',
      provider: 'local',
      spawn: [],
      pendingSpawns: [],
      autoSpawnEntities: true,
      campaign: {
        id: 'quickstart',
        tokens: [],
        initiative: [],
        chatLog: [],
        pendingSpawns: [],
        settings: { autoSpawnEntities: true },
      },
    });
  };

  await client.getGMResponse(
    { campaignId: 'quickstart', location: 'crypt' },
    'push open the stone door',
    { forceServer: true, autoSpawnEntities: true }
  );

  assert.equal(capturedRequest.url, '/api/gm/respond');
  assert.equal(capturedRequest.options.headers['X-AI-Provider'], 'local');
  assert.equal(capturedRequest.options.headers['X-AI-Key'], undefined);
});

console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
