export type BridgeState = 'IDLE' | 'RUNNING' | 'READY' | 'ERROR';

export interface KickProfile {
  username: string;
  userId: number | null;
  avatarUrl: string | null;
  channelUrl: string;
}

export interface KickBridgeStatus {
  state: BridgeState;
  message: string;
  hasToken: boolean;
  isAuthenticated: boolean;
  tokenExpiresAt: string | null;
  profile: KickProfile | null;
  updatedAt: string;
}

export interface FollowedChannel {
  channelSlug: string;
  displayName: string;
  isLive: boolean;
  channelUrl: string;
  chatUrl: string | null;
  thumbnailUrl: string | null;
}
