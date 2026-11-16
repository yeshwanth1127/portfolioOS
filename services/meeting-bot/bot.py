"""Orbit meeting bot: the Qlix Meeting Assistant's ears in a LiveKit room (docs/MEETINGS.md).

The API dispatches this worker (agent name ``orbit-meeting-bot``) into a meeting's room when the
first person joins. It subscribes to everyone's audio, cuts speech into utterances with Silero VAD,
and sends each one to Qlix's whisper.cpp ``whisper-server`` (``POST /inference``). The text goes:

* to the API (``POST /internal/meetings/transcript``), which stores the transcript the Meeting
  Assistant reads when it writes the summary after the call;
* to the room as live captions (text stream topic ``lk.transcription``).

People can also ask "@qlix …" in the meeting chat: the bot passes the question to the workspace's
Qlix Meeting Assistant (through the agent runner, as the person who asked) and posts the answer.
The bot never calls an LLM itself: all reasoning is done by Qlix.

    python bot.py dev      # local, reloads on change
    python bot.py start    # production
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import time
import uuid
import wave

import httpx
from livekit import rtc
from livekit.agents import AgentServer, AutoSubscribe, JobContext, JobProcess, cli
from livekit.agents import vad as agents_vad
from livekit.plugins import silero

log = logging.getLogger("meeting-bot")

BOT_NAME = os.environ.get("MEETING_BOT_NAME", "orbit-meeting-bot")
API_URL = os.environ.get("PORTFOLIOOS_API_URL", "http://127.0.0.1:4001").rstrip("/")
SERVICE_SECRET = os.environ.get("AGENT_RUNNER_SECRET", "dev-runner-secret")
RUNNER_URL = os.environ.get("AGENT_RUNNER_URL", "http://127.0.0.1:3940").rstrip("/")
RUNNER_TIMEOUT = float(os.environ.get("MEETING_QA_TIMEOUT", "120"))
STT_URL = os.environ.get("QLIX_STT_URL", "http://127.0.0.1:8178").rstrip("/")
STT_LANGUAGE = os.environ.get("QLIX_STT_LANGUAGE", "en")
STT_TIMEOUT = float(os.environ.get("QLIX_STT_TIMEOUT", "60"))
# Leave this long after the last person does, so LiveKit can close the room.
ALONE_GRACE_S = float(os.environ.get("MEETING_BOT_ALONE_GRACE", "20"))
SAMPLE_RATE = 16000
MIN_SPEECH_S = 0.4
# "@qlix what did we decide?", "Qlix, …", "@Meeting Assistant …"
ASK = re.compile(r"^\s*@?(qlix|meeting assistant)\b[\s,:.\-]*", re.IGNORECASE)
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def question_message(name: str, question: str) -> str:
    return (
        f'{name} asks you in the meeting chat: "{question}"\n'
        "Answer for the meeting chat in 1 to 3 short sentences of plain text. For what has been said in this "
        "meeting, call portfolio_os with action \"meeting_transcript\" (the most recent part). For workspace data (KPIs, people, earlier "
        "meetings) use the other tools. If the transcript doesn't cover it, say so; never guess."
    )

# whisper.cpp prints these for silence/noise; never store them as speech.
_NOISE = re.compile(
    r"^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|thank you\.?|thanks for watching!?|you|bye\.?|\.+)\s*$",
    re.IGNORECASE,
)


def is_noise(text: str) -> bool:
    t = text.strip()
    return len(t) < 2 or bool(_NOISE.match(t))


def wav_bytes(pcm: bytes, rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


class QlixSTT:
    """Qlix's whisper-server, one request at a time (it decodes serially), in arrival order."""

    def __init__(self, prompt: str) -> None:
        self.prompt = prompt
        self.http = httpx.AsyncClient(timeout=STT_TIMEOUT)

    async def transcribe(self, pcm: bytes) -> str:
        files = {"file": ("speech.wav", wav_bytes(pcm), "audio/wav")}
        data = {
            "response_format": "json",
            "temperature": "0.0",
            "no_timestamps": "true",
            "language": STT_LANGUAGE,
            "prompt": self.prompt,
        }
        r = await self.http.post(f"{STT_URL}/inference", files=files, data=data)
        r.raise_for_status()
        text = (r.json().get("text") or "").strip()
        return "" if is_noise(text) else re.sub(r"\s+", " ", text)

    async def aclose(self) -> None:
        await self.http.aclose()


class Uploader:
    """Sends finished segments to the API in small batches."""

    def __init__(self, room: str) -> None:
        self.room = room
        self.pending: list[dict] = []
        self.http = httpx.AsyncClient(timeout=15)
        self.lock = asyncio.Lock()

    def add(self, segment: dict) -> None:
        self.pending.append(segment)

    async def flush(self) -> None:
        async with self.lock:
            while self.pending:
                batch, self.pending = self.pending[:50], self.pending[50:]
                try:
                    r = await self.http.post(
                        f"{API_URL}/internal/meetings/transcript",
                        headers={"x-service-secret": SERVICE_SECRET},
                        json={"room": self.room, "segments": batch},
                    )
                    r.raise_for_status()
                except Exception as e:  # keep them for the next flush
                    log.warning("transcript upload failed (%s); will retry", e)
                    self.pending = batch + self.pending
                    return

    async def run(self, every: float = 4.0) -> None:
        while True:
            await asyncio.sleep(every)
            await self.flush()

    async def aclose(self) -> None:
        await self.flush()
        await self.http.aclose()


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load(min_silence_duration=0.6, sample_rate=SAMPLE_RATE)


server = AgentServer(setup_fnc=prewarm)


def is_person(p: rtc.RemoteParticipant) -> bool:
    return p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT


@server.rtc_session(agent_name=BOT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    meta = json.loads(ctx.job.metadata or "{}")
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    room = ctx.room
    log.info("joined %s (meeting %s)", room.name, meta.get("meeting_id"))
    try:
        await room.local_participant.set_name("Meeting Assistant")
    except Exception:  # older servers: the name is cosmetic
        pass

    t0 = time.monotonic()
    names = ", ".join(p.name or p.identity for p in room.remote_participants.values() if is_person(p))
    stt = QlixSTT(prompt=f"A work meeting. People: {names}." if names else "A work meeting.")
    uploader = Uploader(room.name)
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    tasks: set[asyncio.Task] = set()
    vad: agents_vad.VAD = ctx.proc.userdata["vad"]

    def spawn(coro) -> None:
        t = asyncio.create_task(coro)
        tasks.add(t)
        t.add_done_callback(tasks.discard)

    async def listen(track: rtc.Track, who: rtc.RemoteParticipant) -> None:
        audio = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1)
        speech = vad.stream()

        async def feed() -> None:
            async for ev in audio:
                speech.push_frame(ev.frame)
            speech.end_input()

        spawn(feed())
        async for ev in speech:
            if ev.type != agents_vad.VADEventType.END_OF_SPEECH or not ev.frames:
                continue
            frame = rtc.combine_audio_frames(ev.frames)
            seconds = frame.samples_per_channel / frame.sample_rate
            if seconds < MIN_SPEECH_S:
                continue
            end_ms = int((time.monotonic() - t0) * 1000)
            start_ms = max(0, end_ms - int(seconds * 1000))
            try:
                queue.put_nowait((who, track.sid, bytes(frame.data), start_ms, end_ms))
            except asyncio.QueueFull:
                log.warning("speech-to-text is behind; dropping an utterance from %s", who.identity)

    async def transcribe_loop() -> None:
        while True:
            who, track_sid, pcm, start_ms, end_ms = await queue.get()
            try:
                text = await stt.transcribe(pcm)
            except Exception as e:
                log.warning("speech-to-text failed: %s", e)
                continue
            if not text:
                continue
            name = who.name or who.identity
            uploader.add({"identity": who.identity, "name": name, "started_ms": start_ms, "ended_ms": end_ms, "text": text})
            try:
                await room.local_participant.send_text(
                    text,
                    topic="lk.transcription",
                    attributes={
                        "lk.transcribed_track_id": track_sid,
                        "lk.segment_id": uuid.uuid4().hex,
                        "lk.transcription_final": "true",
                        "orbit.speaker_identity": who.identity,
                        "orbit.speaker_name": name,
                    },
                )
            except Exception as e:
                log.debug("caption not sent: %s", e)

    @room.on("track_subscribed")
    def on_track(track: rtc.Track, _pub: rtc.RemoteTrackPublication, who: rtc.RemoteParticipant) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO and is_person(who):
            spawn(listen(track, who))

    # Tracks that were already subscribed before the handler was attached.
    for who in room.remote_participants.values():
        for pub in who.track_publications.values():
            if pub.track and pub.track.kind == rtc.TrackKind.KIND_AUDIO and is_person(who):
                spawn(listen(pub.track, who))

    # "@qlix …" questions in the chat, answered by the Meeting Assistant as the person who asked.
    meeting_id = meta.get("meeting_id")
    runner = httpx.AsyncClient(timeout=RUNNER_TIMEOUT)
    asking: set[str] = set()

    async def say_in_chat(text: str) -> None:
        try:
            await room.local_participant.send_text(text, topic="lk.chat")
        except Exception as e:
            log.warning("chat reply not sent: %s", e)

    async def answer(identity: str, name: str, question: str) -> None:
        first = name.split()[0] if name else "there"
        if identity in asking:
            await say_in_chat(f"{first}, I'm still on your last question.")
            return
        asking.add(identity)
        try:
            await uploader.flush()  # so the answer can see the last few seconds
            r = await runner.post(
                f"{RUNNER_URL}/run",
                headers={"x-service-secret": SERVICE_SECRET},
                json={
                    "membership_id": identity,
                    "agent_id": "portfolio-meeting-agent",
                    "message": question_message(name, question),
                    "history": [],
                    "channel": "meeting",
                    "profile": "meeting",
                    "meeting_id": meeting_id,
                },
            )
            data = r.json() if r.content else {}
            if r.status_code == 200 and (data.get("reply") or "").strip():
                text = data["reply"].strip()
            else:
                text = data.get("error") if isinstance(data.get("error"), str) else "I couldn't answer that just now."
        except Exception as e:
            log.warning("question failed: %s", e)
            text = "I couldn't reach Qlix just now. Please try again in a moment."
        finally:
            asking.discard(identity)
        await say_in_chat(f"@{first} {text}")

    def on_chat(reader: rtc.TextStreamReader, sender: str) -> None:
        async def handle() -> None:
            text = await reader.read_all()
            m = ASK.match(text or "")
            who = room.remote_participants.get(sender)
            if not m or not who or not is_person(who) or not UUID.match(sender) or not meeting_id:
                return
            question = text[m.end():].strip()
            name = who.name or "there"
            if not question:
                await say_in_chat(f"@{name.split()[0]} Ask me anything about this meeting, e.g. \"@qlix what have we decided so far?\"")
                return
            await answer(sender, name, question[:1000])

        spawn(handle())

    room.register_text_stream_handler("lk.chat", on_chat)

    spawn(transcribe_loop())
    spawn(uploader.run())

    async def cleanup() -> None:
        # Let the queue drain briefly so the last words make it into the transcript.
        for _ in range(40):
            if queue.empty():
                break
            await asyncio.sleep(0.25)
        await uploader.aclose()
        await stt.aclose()
        await runner.aclose()

    ctx.add_shutdown_callback(cleanup)

    # Stay while people are here; leave once everyone has gone so the room can close.
    alone_since: float | None = None
    while room.isconnected():
        people = [p for p in room.remote_participants.values() if is_person(p)]
        if people:
            alone_since = None
        elif alone_since is None:
            alone_since = time.monotonic()
        elif time.monotonic() - alone_since > ALONE_GRACE_S:
            log.info("everyone left %s; leaving", room.name)
            break
        await asyncio.sleep(2)
    ctx.shutdown(reason="meeting over")


if __name__ == "__main__":
    cli.run_app(server)
