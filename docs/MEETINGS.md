# Meetings

Video meetings for the people of a workspace, on our own [LiveKit](https://livekit.io) server
(Apache-2.0). Sidebar → **Workspace → Meetings**.

## What works today (phase 1)

- **Start a meeting now** (instant) or **Schedule** one with a title, time, length, agenda and invitees.
  Scheduled meetings also create a calendar event (kind `meeting`, location `/meetings/<id>`) so invitees
  see it on the calendar and get a reminder 10 minutes before.
- **Join**: a camera and mic check first, then the call: video grid, mute, camera, screen share, chat, leave.
- **Host controls**: copy link, end for everyone, cancel a meeting that hasn't started.
- **After the call**: when it started, how long it lasted, who attended and who didn't join.

## Who can see and join

The same rules as calendar events, enforced by RLS (`026_meetings.sql`):

| Who | Sees / can join |
|---|---|
| Owner | every meeting in the workspace |
| Everyone else | meetings in their organisation, meetings they host, meetings they're invited to |

Being able to see a meeting is what allows joining it. `POST /meetings/:id/token` returns a LiveKit
token for that one room only. Permissions (`docs/permissions.csv`):

- `meeting.create`: every role.
- `meeting.manage` (end or cancel): the owner, the host, or a manager or vice manager of the meeting's organisation.

## How it fits together

```
browser ──POST /meetings/:id/token──▶ API ──(LiveKit JWT: room orbit-<id>, identity = membership id)
browser ──wss://<domain>/lk──▶ nginx ──▶ meetings container :7880 (LiveKit)
media    ──7881/tcp, 7882/udp──▶ meetings container
LiveKit ──signed webhooks──▶ API POST /livekit/webhook (room_started / finished, participant joined / left)
API ──Twirp DeleteRoom──▶ LiveKit (end for everyone)
```

- The API uses no LiveKit SDK. Tokens and webhook signatures are HS256 JWTs made with
  `jsonwebtoken`; room deletion is a Twirp POST. See `packages/api/src/modules/meetings/livekit.js`.
- A room closes 5 minutes after the last person leaves, and the meeting is then marked ended.

### API

| Method | Path | |
|---|---|---|
| GET | `/meetings` | live and upcoming meetings, plus the last 90 days; `available: false` if LiveKit isn't configured |
| GET | `/meetings/invitees` | people, teams and organisations the caller can invite |
| POST | `/meetings` | `{ title, starts_at, duration_minutes, description, participant_ids, team_ids, org_ids, qlix_enabled }`, or `{ instant: true, … }`; at least one invitee |
| POST | `/meetings/:id/participants` | invite more: `{ participant_ids, team_ids, org_ids }` |
| GET | `/meetings/:id` | meeting with participants and attendance |
| DELETE | `/meetings/:id` | cancel (scheduled only) |
| POST | `/meetings/:id/token` | `{ token, url, room }` for the caller |
| POST | `/meetings/:id/end` | end for everyone |
| POST | `/livekit/webhook` | LiveKit only (signature checked) |

## Configuration

| Variable | Where | Notes |
|---|---|---|
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | API and `meetings` container | The same pair in both. Outside production the API falls back to `devkey` / `secret`. Without a secret in production, Meetings shows "not set up". |
| `LIVEKIT_PUBLIC_URL` | API | What browsers connect to: `wss://<domain>/lk` on a server, `ws://localhost:7880` locally. |
| `LIVEKIT_URL` | API | Server-to-server: `http://meetings:7880` in Docker. |
| `LIVEKIT_NODE_IP`, `LIVEKIT_USE_EXTERNAL_IP` | `meetings` | On a laptop, `127.0.0.1` / `false`. On a server, leave unset / `true` (the public IP is found via STUN). |
| `LIVEKIT_WEBHOOK_URL` | `meetings` | Defaults to `http://portfolio:4001/livekit/webhook`. |

- **Dev:** `scripts/dev.sh` starts the `meetings` container with the dev key pair. Webhooks go to the API on the host.
- **Server:** `scripts/server-setup.sh` generates the secret, sets `LIVEKIT_PUBLIC_URL`, adds the nginx `/lk/` proxy and opens 7881/tcp and 7882/udp.
- **Embedded in Qlix:** when the Qlix console frames Orbit, its iframe needs `allow="camera; microphone; display-capture"` for calls to work inside it.

## Meeting Assistant (phase 2)

Each workspace has a third Qlix agent, **Meeting Assistant**, next to Assistant and Report writer
(`packages/api/src/modules/qlix/provision.js`). New workspaces get it at signup. Workspaces that
existed before get it the first time a meeting needs it (`ensureMissingAgents`), or all at once with
`npm run qlix:provision -w @portfolio-os/api -- --all`.

```
first person joins ──▶ API dispatches the bot (LiveKit AgentDispatch, name orbit-meeting-bot)
bot (services/meeting-bot) ── each person's audio ─▶ Silero VAD ─▶ Qlix whisper-server POST /inference
     ├─▶ API POST /internal/meetings/transcript  (service secret; stored in meeting_transcript_segments)
     └─▶ room text stream lk.transcription        (live captions in the call)
meeting ends ──▶ job meeting_summarize ──▶ agent-runner /run {profile: 'meeting', meeting_id}
     ──▶ Qlix (Meeting Assistant agent) ── tools meeting_context, meeting_transcript ──▶ reply
     ──▶ API parses SUMMARY / DECISIONS / ACTION ITEMS ──▶ meeting_summaries + in-app notifications
```

- **The bot does no reasoning.** It is ears and captions only; every word of the summary comes from Qlix.
- **The run token decides what Qlix can see.** A `meeting` run token carries
  `{ profile: 'meeting', meeting_id }`. Its catalogue holds `meeting_context` and `meeting_transcript`
  plus a few safe reads, and no write tools. Both meeting tools take no arguments, so ADK's
  hardcoded parameter list (`docs/F14-adk-coordination.md`) doesn't matter. The run's membership (the
  host) must also be able to see the meeting under RLS. No ADK changes.
- **One Qlix conversation per meeting** (`meetings.qlix_conversation_id`).
- **Long meetings** are summarised part by part (`MEETING_PART_CHARS`, default 40,000 characters):
  one Qlix turn takes notes on each part, then a final turn writes the summary from the notes.
- **Owners.** Action-item owners are matched to the meeting's people by full name, or by a unique
  first name. An unmatched owner keeps the name as text, with no link to a person.
- **States** (`meetings.summary_status`): `none`, `pending`, `running`, `ready`, `empty` (nothing was
  heard) or `failed` (with `summary_error`, e.g. Qlix not connected). The host or a manager can retry
  with **Try again**, or rewrite with **Rewrite** (`POST /meetings/:id/summary`).

### Speech-to-text

The bot calls Qlix's `whisper-server` (whisper.cpp) at `QLIX_STT_URL`, default `http://127.0.0.1:8178`.

- **Locally**, `scripts/dev.sh` starts one on :8178 with Qlix's model, unless one is already running,
  and runs the bot natively.
- **In Docker or on a server**, the `meetings` container needs a whisper-server it can reach: start it
  with `--host 0.0.0.0`, or run it on the `exora` network.
- **Model.** Qlix's default is `ggml-base.en`: small and English-only. For meetings, a `small` or
  `medium` multilingual model is clearly better (set `QLIX_STT_LANGUAGE` to match). That is a
  whisper-server setting; our code doesn't change.
- **Throughput.** whisper-server decodes one request at a time. The bot queues utterances in order,
  so captions can lag in a busy call, but words are not lost unless the queue (200 utterances) overflows.

### Bot settings (`meetings` container or `services/meeting-bot`)

| Variable | Default | |
|---|---|---|
| `QLIX_STT_URL` | `http://127.0.0.1:8178` | Qlix whisper-server |
| `QLIX_STT_LANGUAGE` | `en` | must suit the model |
| `PORTFOLIOOS_API_URL` | `http://127.0.0.1:4001` | where transcripts go |
| `AGENT_RUNNER_SECRET` | | the API's service secret |
| `MEETING_BOT_AUTOSTART` | `true` | `false` turns off the container's bot (`dev.sh` runs it natively) |
| `MEETING_BOT_ALONE_GRACE` | `20` | seconds the bot stays after the last person leaves |

On the API, `MEETING_BOT=off` stops it dispatching the bot.

## Action items, live questions, and meetings everywhere (phase 3)

- **Action items → tasks.** In the notes, the host, the owner or the meeting org's manager can use
  **Add as task** to create a task, or **Dismiss** an item.
  - **Creating a task:** pick a project, then confirm the task title, assignee (defaults to the matched
    owner) and due date. The task is created as that person through `createTask`, so the project's own
    rules about who may add and assign tasks apply. The item records `task_id`, `decided_by` and `decided_at`.
  - **Route:** `POST /meetings/:id/action-items/:index` with `{ decision: 'accept', project_id, title?,
    assignee_id?, due_on? }` or `{ decision: 'reject' }`. Summaries stay system-written; the decision is
    recorded through `auth.set_meeting_action_item`.
  - **Rewrite** keeps items that were already accepted or dismissed, and adds only new proposals.
- **`@qlix` in the meeting chat.** Anyone in the call can ask, e.g. "@qlix what have we decided so far?".
  - **Who answers:** the bot sends the question to the Meeting Assistant through the agent runner,
    as the person who asked (their membership, so RLS limits what Qlix can see), on the meeting's run
    token. Qlix reads the most recent part of the transcript and can use the usual read tools (KPIs,
    people, earlier meeting notes).
  - **Where the answer goes:** the meeting chat, addressed to the person who asked. Answers took about
    15–30 seconds in testing.
- **The Assistant knows about meetings** on web chat and WhatsApp, through two read tools:
  - `meeting_notes` finds an ended meeting by words from its title and/or its date.
  - `list_meetings` shows what happened when.
  - Visibility is the same as on the Meetings page.
- **WhatsApp digest.** When the notes are ready, each attendee with a WhatsApp number gets a short
  digest: the summary, the decisions and their own action items. Turn it off with `MEETING_WHATSAPP_DIGEST=off`.
- **Calendar.** Scheduled meetings have a **Join video meeting** button in the calendar.

## Who a meeting is with, invites and the bell

- **Every meeting names who it's with**, whether started now or scheduled: people, whole teams (any
  unit: team, department or branch, including the units under it) or whole organisations.
- **Invites are workspace-wide, for every role.** Anyone can meet anyone in the workspace, whatever their
  role and whichever organisation is picked in the sidebar. `GET /meetings/invitees` reads the definer
  functions `auth.meeting_directory()`, `auth.meeting_units()` and `auth.meeting_orgs()`
  (`030_meeting_directory.sql`). They return only names, titles, organisation and units, never contact
  details. The server expands teams and organisations into people (up to 300). Calendar invites use the
  same check.
- A meeting for exactly one organisation (the owner picking only that organisation) belongs to it, so
  everyone there can see it. Otherwise it belongs to the host's organisation, and people elsewhere see it
  because they're invited.
- **In-app notifications** (job `meeting_notify`, written in the system scope):

  | Kind | When | Link |
  |---|---|---|
  | `meeting_started` | instant meeting, or added to a live one | `/meetings/<id>?join=1` (and a pop-up with **Join**) |
  | `meeting_invited` | scheduled meeting, or added to one | `/meetings/<id>` |
  | `meeting_reminder` | 10 minutes before, to everyone invited and the host (skipped if it already started) | `/meetings/<id>` |
  | `meeting_cancelled` | a scheduled meeting is cancelled | none |
  | `meeting` | the notes are ready | `/meetings/<id>` |

- **The bell** (top bar) lists your notifications (`GET /notifications`, `POST /notifications/read`
  with `{ ids }` or `{ all: true }`), with a **Join** button while a meeting can be joined. It polls every
  20 seconds and when the tab regains focus. `notifications.link` and `notifications.meeting_id` come from
  `029_meeting_invites.sql`. Task and report notifications link to My Work, the project, or Reports.
- **Invite more people later:** the host, owner or org manager uses **Invite people** on the meeting page
  or in the call (`POST /meetings/:id/participants` with the same `participant_ids` / `team_ids` / `org_ids`).
  New people are added to the calendar event too. People already invited are skipped.
- **Links.** **Copy link** copies `<site>/meetings/<id>`. The link opens the meeting for anyone invited
  (and for the meeting's organisation). Anyone else sees "you haven't been invited, ask the host". On the
  Meetings page, **Have a meeting link?** accepts a pasted link, a `/meetings/<id>` path or a bare id.

## Next phase

4. **Voice**: the Meeting Assistant answers out loud (Piper TTS in the `meetings` container, wake word
   "Qlix", with a host toggle so it never talks over people unasked).
