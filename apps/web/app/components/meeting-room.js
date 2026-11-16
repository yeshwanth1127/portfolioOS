'use client';

import '@livekit/components-styles';
import {
  CarouselLayout,
  Chat,
  ConnectionStateToast,
  ControlBar,
  FocusLayout,
  FocusLayoutContainer,
  GridLayout,
  LayoutContextProvider,
  LiveKitRoom,
  ParticipantTile,
  PreJoin,
  RoomAudioRenderer,
  isTrackReference,
  useCreateLayoutContext,
  useParticipants,
  usePinnedTracks,
  useTracks,
  useTranscriptions,
} from '@livekit/components-react';
import { RoomEvent, Track } from 'livekit-client';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The call itself (browser only — loaded with next/dynamic, ssr: false):
 * a pre-join check of camera and mic, then the LiveKit room with grid, controls, screen share
 * and chat. `getToken` asks our API for a join token only once the person clicks Join.
 */
export default function MeetingRoom({ userName, getToken, onLeave, onError, assistantOn }) {
  const [conn, setConn] = useState(null);
  const [joining, setJoining] = useState(false);

  async function join(choices) {
    setJoining(true);
    try {
      const { token, url } = await getToken();
      setConn({ token, url, choices });
    } catch (e) {
      onError?.(e.message);
    } finally {
      setJoining(false);
    }
  }

  if (!conn) {
    return (
      <div className="mt-prejoin" data-lk-theme="default">
        <PreJoin
          defaults={{ username: userName, videoEnabled: true, audioEnabled: true }}
          joinLabel={joining ? 'Joining…' : 'Join meeting'}
          userLabel="Your name"
          persistUserChoices
          onSubmit={join}
          onError={(e) => onError?.(e?.message ?? 'Could not reach your camera or microphone.')}
        />
      </div>
    );
  }

  const { choices } = conn;
  return (
    <LiveKitRoom
      className="mt-room"
      data-lk-theme="default"
      serverUrl={conn.url}
      token={conn.token}
      connect
      video={choices.videoEnabled ? { deviceId: choices.videoDeviceId || undefined } : false}
      audio={choices.audioEnabled ? { deviceId: choices.audioDeviceId || undefined } : false}
      onDisconnected={() => onLeave?.()}
      onError={(e) => onError?.(e?.message ?? 'The call ran into a problem.')}
    >
      <Conference assistantOn={assistantOn} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

/**
 * LiveKit's stock conference layout, except the Meeting Assistant (an agent participant) gets
 * no video tile: it shows as a small "listening" pill, and what it hears appears as captions.
 */
function Conference({ assistantOn }) {
  const [widget, setWidget] = useState({ showChat: false, unreadMessages: 0 });
  const layout = useCreateLayoutContext();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );
  const people = useMemo(() => tracks.filter((t) => !t.participant.isAgent), [tracks]);
  const participants = useParticipants();
  const assistantHere = participants.some((p) => p.isAgent);

  // Pin a screen share automatically (as the stock layout does).
  const screenShares = people.filter(isTrackReference).filter((t) => t.publication.source === Track.Source.ScreenShare);
  const focus = usePinnedTracks(layout)?.[0];
  const lastShare = useRef(null);
  useEffect(() => {
    const subscribed = screenShares.find((t) => t.publication.isSubscribed);
    if (subscribed && !lastShare.current) {
      layout.pin.dispatch?.({ msg: 'set_pin', trackReference: subscribed });
      lastShare.current = subscribed;
    } else if (lastShare.current && !screenShares.some((t) => t.publication.trackSid === lastShare.current.publication.trackSid)) {
      layout.pin.dispatch?.({ msg: 'clear_pin' });
      lastShare.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenShares.map((t) => `${t.publication.trackSid}_${t.publication.isSubscribed}`).join()]);
  const others = people.filter((t) => !(focus && t.participant.identity === focus.participant.identity && t.source === focus.source));

  return (
    <div className="lk-video-conference">
      <LayoutContextProvider value={layout} onWidgetChange={setWidget}>
        <div className="lk-video-conference-inner">
          {focus ? (
            <div className="lk-focus-layout-wrapper">
              <FocusLayoutContainer>
                <CarouselLayout tracks={others}>
                  <ParticipantTile />
                </CarouselLayout>
                <FocusLayout trackRef={focus} />
              </FocusLayoutContainer>
            </div>
          ) : (
            <div className="lk-grid-layout-wrapper">
              <GridLayout tracks={people}>
                <ParticipantTile />
              </GridLayout>
            </div>
          )}
          <div className="mt-overlay">
            {assistantOn ? <AssistantPill here={assistantHere} /> : null}
            <Captions />
          </div>
          <ControlBar controls={{ chat: true, settings: false }} />
        </div>
        <Chat style={{ display: widget.showChat ? 'grid' : 'none' }} />
      </LayoutContextProvider>
      <ConnectionStateToast />
    </div>
  );
}

function AssistantPill({ here }) {
  return (
    <div className={`mt-pill${here ? ' is-on' : ''}`} role="status">
      <span className="mt-pill-dot" aria-hidden />
      {here ? (
        <>
          Meeting Assistant is listening <span className="mt-pill-hint">· ask “@qlix …” in chat</span>
        </>
      ) : (
        'Meeting Assistant is joining…'
      )}
    </div>
  );
}

/** The last few things said, from the Meeting Assistant's live transcription. */
function Captions() {
  const [hidden, setHidden] = useState(false);
  const items = useTranscriptions();
  const recent = items.slice(-3);
  if (!recent.length) return null;
  return (
    <div className="mt-captions" aria-live="polite">
      <button type="button" className="mt-captions-toggle" onClick={() => setHidden((h) => !h)}>
        {hidden ? 'Show captions' : 'Hide'}
      </button>
      {hidden
        ? null
        : recent.map((t) => (
            <p key={t.streamInfo.id}>
              <b>{t.streamInfo.attributes?.['orbit.speaker_name'] ?? t.participantInfo.identity}:</b> {t.text}
            </p>
          ))}
    </div>
  );
}
