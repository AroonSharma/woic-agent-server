// @ts-nocheck
import { Room, RoomEvent, RemoteParticipant, RemoteTrackPublication, createLocalAudioTrack, RoomConnectOptions, Participant, RemoteTrack, LocalTrackPublication, LocalParticipant } from 'livekit-client';

export type ConnectParams = {
  wsUrl: string;
  token: string;
  audioElement: HTMLAudioElement;
};

export async function connectToLiveKit({ wsUrl, token, audioElement }: ConnectParams): Promise<Room> {
  const room = new Room();

  // Route remote audio to provided element
  room.on(RoomEvent.TrackSubscribed, (_: RemoteTrack, pub: RemoteTrackPublication, __: RemoteParticipant) => {
    if (pub.track && pub.track.kind === 'audio') {
      pub.track.attach(audioElement);
    }
  });

  room.on(RoomEvent.TrackUnsubscribed, (_: RemoteTrack, pub: RemoteTrackPublication) => {
    if (pub.track && pub.track.kind === 'audio') {
      pub.track.detach();
    }
  });

  await room.connect(wsUrl, token, { autoSubscribe: true } as RoomConnectOptions);
  return room;
}

export async function publishMicrophone(room: Room): Promise<LocalTrackPublication | undefined> {
  const track = await createLocalAudioTrack({});
  const pub = await room.localParticipant.publishTrack(track);
  return pub;
}

export function disconnectRoom(room: Room | null) {
  try {
    room?.disconnect();
  } catch {} // Cleanup operation - empty catch is intentional
}
