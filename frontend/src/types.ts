export type BridgeState = 'IDLE' | 'RUNNING' | 'READY' | 'ERROR';
export type KickAuthMode = 'NONE' | 'OAUTH' | 'BROWSER_SESSION';

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
  oauthEnabled: boolean;
  hasBrowserSession: boolean;
  authMode: KickAuthMode;
  grantedScopes: string[];
  updatedAt: string;
}

export interface FollowedChannel {
  channelSlug: string;
  displayName: string;
  isLive: boolean;
  channelUrl: string;
  chatUrl: string | null;
  thumbnailUrl: string | null;
  broadcasterUserId: number | null;
  channelId: number | null;
  viewerCount: number | null;
  streamTitle: string | null;
  categoryName: string | null;
  tags: string[];
}

export interface PostedChatMessage {
  isSent: boolean;
  messageId: string;
}

export interface ChannelChatBadge {
  type: string;
  text: string;
  count: number | null;
  imageUrl: string | null;
}

export interface ChannelChatSender {
  id: number | null;
  username: string;
  slug: string;
  color: string | null;
  badges: ChannelChatBadge[];
}

export interface ChannelChatMessage {
  id: string;
  content: string;
  type: string;
  createdAt: string | null;
  threadParentId: string | null;
  sender: ChannelChatSender;
}

export interface ChannelChat {
  channelSlug: string;
  channelId: number | null;
  channelUserId: number | null;
  chatroomId: number | null;
  displayName: string;
  channelUrl: string;
  avatarUrl: string | null;
  cursor: string | null;
  messages: ChannelChatMessage[];
  pinnedMessage: ChannelChatMessage | null;
  updatedAt: string;
}

export interface ChannelChatEmote {
  code: string;
  imageUrl: string;
  provider: string;
  animated: boolean;
  width: number | null;
  height: number | null;
}

export interface ChannelChatEmoteCatalog {
  channelSlug: string;
  channelUserId: number | null;
  emotes: ChannelChatEmote[];
  updatedAt: string;
}
