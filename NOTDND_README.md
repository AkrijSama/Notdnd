# NOTDND - AI Game Master with BYOK

A tabletop RPG game master powered by AI with **Bring Your Own Key (BYOK)** support.

## Features

- **BYOK Support**: Users can provide their own API keys for OpenAI, Grok, or Gemini
- **Multi-Provider**: Support for OpenAI, Grok (X.AI), Gemini, and Local AI
- **Privacy-First**: API keys stored in sessionStorage only, never persisted to server
- **Fallback Support**: Self-hosted deployments can configure environment variables as fallback
- **Secure**: API keys never logged by the server

## Architecture

### Client-Side (`src/`)

- **`src/api/client.js`**: API client that attaches `X-AI-Provider` and `X-AI-Key` headers
- **`src/components/Settings.js`**: Settings UI panel for provider selection and key input

### Server-Side (`server/`)

- **`server/index.js`**: Express server with header-based authentication and env var fallback
- **`server/gm/prompting.js`**: AI adapter layer for multiple providers

## Installation

```bash
npm install
```

## Configuration

### Option 1: User BYOK (Recommended)

1. Start the application
2. Click "Settings"
3. Select your AI provider (OpenAI, Grok, Gemini, or Local)
4. Enter your API key
5. Click "Save Settings"

Keys are stored in sessionStorage and sent via headers on each request.

### Option 2: Environment Variables (Self-Hosted)

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Edit `.env`:

```
OPENAI_API_KEY=sk-...
GROK_API_KEY=xai-...
GEMINI_API_KEY=...
```

## Usage

```bash
# Start the server
npm start

# Development mode with auto-reload
npm run dev
```

Navigate to `http://localhost:3000`

## API Endpoints

### `POST /api/ai/generate`

Generate AI content.

**Headers:**
- `X-AI-Provider`: Provider name (openai, grok, gemini, local)
- `X-AI-Key`: API key (optional for local, required for others)

**Body:**
```json
{
  "prompt": "Your prompt here"
}
```

**Response (Success):**
```json
{
  "result": "AI generated content",
  "provider": "openai"
}
```

**Response (402 - No Key):**
```json
{
  "error": "no_key",
  "message": "Please provide an API key in Settings"
}
```

### `POST /api/gm/respond`

Get Game Master response.

**Headers:**
- `X-AI-Provider`: Provider name
- `X-AI-Key`: API key

**Body:**
```json
{
  "context": { "location": "tavern", "characters": [] },
  "userInput": "I enter the tavern"
}
```

## Security Features

1. **No Server Persistence**: Keys never stored in database or files
2. **SessionStorage Only**: Keys cleared when browser tab closes
3. **No Logging**: Server never logs API key values
4. **Header-Based**: Keys transmitted securely via HTTPS headers
5. **Fallback Isolation**: Environment variables only used when no header provided

## Provider Support

| Provider | Requires Key | Model Used |
|----------|-------------|------------|
| OpenAI   | Yes         | GPT-4      |
| Grok     | Yes         | grok-beta  |
| Gemini   | Yes         | gemini-pro |
| Local    | No          | Mock/Local |

## Development

### File Structure

```
.
├── public/
│   ├── index.html       # Main HTML entry point
│   └── styles.css       # Application styles
├── src/
│   ├── api/
│   │   └── client.js    # API client with BYOK headers
│   └── components/
│       └── Settings.js  # Settings UI component
├── server/
│   ├── index.js         # Express server
│   └── gm/
│       └── prompting.js # AI adapter layer
├── package.json
└── .env.example
```

## Testing

### Manual Testing

1. **Test BYOK Flow:**
   - Open Settings
   - Select "OpenAI"
   - Enter API key
   - Save
   - Navigate to Game
   - Submit an action
   - Verify AI response

2. **Test 402 Error:**
   - Open Settings
   - Select "OpenAI"
   - Don't enter key
   - Save
   - Navigate to Game
   - Submit an action
   - Verify 402 error message

3. **Test Local Provider:**
   - Open Settings
   - Select "Local"
   - Save (no key required)
   - Navigate to Game
   - Submit an action
   - Verify mock response

4. **Test Env Var Fallback:**
   - Set `OPENAI_API_KEY` in .env
   - Clear sessionStorage
   - Submit an action
   - Verify it uses env var

## License

MIT
