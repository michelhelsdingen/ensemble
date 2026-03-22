---
title: API Reference
nav_order: 4
---

# API Reference

Base URL: `http://127.0.0.1:23000` (configurable via `ENSEMBLE_PORT`)

Rate limit: 100 requests per 60 seconds per IP.

---

## Health

### `GET /api/v1/health`

```bash
curl http://localhost:23000/api/v1/health
```

```json
{ "status": "healthy", "version": "1.0.0" }
```

---

## Teams

### `POST /api/ensemble/teams` — Create team

```bash
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "review-team",
    "description": "Review the auth module for security issues",
    "agents": [
      { "program": "codex", "role": "lead", "hostId": "local" },
      { "program": "claude", "role": "worker", "hostId": "local" }
    ],
    "workingDirectory": "/path/to/project",
    "feedMode": "live",
    "useWorktrees": false,
    "templateName": null,
    "staged": false
  }'
```

**Required fields:**
- `name` (string) — team name
- `description` (string) — task for the team
- `agents` (array) — at least one agent with `program` field

**Optional fields:**
- `workingDirectory` (string) — project path for agents
- `feedMode` (`"silent"`, `"summary"`, or `"live"`) — message delivery mode
- `useWorktrees` (boolean) — isolate agents in git worktrees
- `templateName` (string) — use a collab template (`review`, `implement`, `debug`)
- `staged` (boolean) — enable staged plan/execute/verify workflow
- `stagedConfig` (object) — phase timeouts and settings

**Response:** `{ "team": EnsembleTeam }`

Returns `400` for malformed JSON, `429` for rate limit exceeded.

---

### `GET /api/ensemble/teams` — List teams

```bash
curl http://127.0.0.1:23000/api/ensemble/teams
```

**Response:** `{ "teams": EnsembleTeam[] }`

---

### `GET /api/ensemble/teams/:id` — Get team details

```bash
curl http://127.0.0.1:23000/api/ensemble/teams/abc-123
```

**Response:** `{ "team": EnsembleTeam, "messages": EnsembleMessage[] }`

---

### `POST /api/ensemble/teams/:id` — Send message

```bash
curl -X POST http://127.0.0.1:23000/api/ensemble/teams/abc-123 \
  -H "Content-Type: application/json" \
  -d '{
    "from": "user",
    "to": "codex-1",
    "content": "Focus on the auth module"
  }'
```

**Fields:**
- `content` (string, required) — message text
- `to` (string) — recipient agent name; defaults to `"team"` when omitted or empty
- `from` (string) — sender name (default: `"user"`)

**Response:** `{ "message": EnsembleMessage }`

Returns `400` for malformed JSON.

---

### `DELETE /api/ensemble/teams/:id` — Disband team

```bash
curl -X DELETE http://127.0.0.1:23000/api/ensemble/teams/abc-123
```

Stops all agents, generates summary, cleans up. Also available as `POST /api/ensemble/teams/:id/disband`.

**Response:** `{ "team": EnsembleTeam }`

---

## Feed

### `GET /api/ensemble/teams/:id/feed` — Message feed

```bash
# All messages
curl http://localhost:23000/api/ensemble/teams/abc-123/feed

# Incremental (since timestamp)
curl "http://localhost:23000/api/ensemble/teams/abc-123/feed?since=2026-03-20T10:00:00Z"
```

**Query params:**
- `since` (ISO 8601 timestamp) — only return messages after this time

**Response:** `{ "messages": EnsembleMessage[] }`

Use the `since` parameter for efficient polling — avoids re-fetching the entire message history.

---

## Types

### EnsembleTeam

```typescript
{
  id: string
  name: string
  description: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: EnsembleTeamAgent[]
  createdBy: string
  createdAt: string // ISO 8601
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  result?: EnsembleTeamResult
}
```

### EnsembleTeamAgent

```typescript
{
  agentId: string
  program: string
  name: string
  role: string
  hostId: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed'
  worktreePath?: string
  worktreeBranch?: string
}
```

### EnsembleTeamResult

```typescript
{
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number
}
```

### EnsembleMessage

```typescript
{
  id: string
  teamId: string
  from: string
  to: string
  content: string
  type: string
  timestamp: string // ISO 8601
}
```
