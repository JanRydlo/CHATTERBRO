import type { ChannelChat, ChannelChatEmoteCatalog, FollowedChannel, KickBridgeStatus, PostedChatMessage } from './types';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function getBackendOrigin() {
  return API_BASE_URL || window.location.origin;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {})
      }
    });
  } catch {
    throw new Error(
      `Cannot reach the Chatterbro backend at ${getBackendOrigin()}. If you just changed the app, stop the old server on port 8080 and start the current backend again.`
    );
  }

  if (!response.ok) {
    const fallbackMessage = `Request failed with status ${response.status}`;

    try {
      const errorPayload = (await response.json()) as { message?: string };
      throw new Error(errorPayload.message || fallbackMessage);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(fallbackMessage);
    }
  }

  return (await response.json()) as T;
}

export function getBridgeStatus(): Promise<KickBridgeStatus> {
  return request<KickBridgeStatus>('/api/bridge/status');
}

export function startBridge(forceReconnect = false): Promise<KickBridgeStatus> {
  const query = forceReconnect ? '?forceReconnect=true' : '';

  return request<KickBridgeStatus>(`/api/bridge/start${query}`, {
    method: 'POST'
  });
}

export function fetchLiveFollowedChannels(): Promise<FollowedChannel[]> {
  return request<FollowedChannel[]>('/api/following/live');
}

export function fetchTrackedLiveChannels(channelSlugs: string[]): Promise<FollowedChannel[]> {
  const query = new URLSearchParams();
  for (const channelSlug of channelSlugs) {
    query.append('slug', channelSlug);
  }

  return request<FollowedChannel[]>(`/api/channels/live?${query.toString()}`);
}

export function fetchTrackedChannels(channelSlugs: string[]): Promise<FollowedChannel[]> {
  const query = new URLSearchParams();
  for (const channelSlug of channelSlugs) {
    query.append('slug', channelSlug);
  }

  return request<FollowedChannel[]>(`/api/channels/tracked?${query.toString()}`);
}

export function fetchRecentChannelSlugs(): Promise<string[]> {
  return request<string[]>('/api/channels/recent');
}

export function fetchChannelChat({
  channelSlug,
  channelId,
  channelUserId,
  displayName,
  avatarUrl,
  fast = false,
}: {
  channelSlug: string;
  channelId?: number | null;
  channelUserId?: number | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  fast?: boolean;
}): Promise<ChannelChat> {
  const query = new URLSearchParams();

  if (channelId !== undefined && channelId !== null) {
    query.set('channelId', String(channelId));
  }

  if (channelUserId !== undefined && channelUserId !== null) {
    query.set('channelUserId', String(channelUserId));
  }

  if (displayName) {
    query.set('displayName', displayName);
  }

  if (avatarUrl) {
    query.set('avatarUrl', avatarUrl);
  }

  if (fast) {
    query.set('fast', 'true');
  }

  const queryString = query.toString();
  return request<ChannelChat>(`/api/chat/${channelSlug}${queryString ? `?${queryString}` : ''}`);
}

export function sendChannelChatMessage(
  channelSlug: string,
  payload: {
    content: string;
    broadcasterUserId?: number | null;
    replyToMessageId?: string | null;
  }
): Promise<PostedChatMessage> {
  return request<PostedChatMessage>(`/api/chat/${channelSlug}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function fetchGlobalChatEmotes(): Promise<ChannelChatEmoteCatalog> {
  return request<ChannelChatEmoteCatalog>('/api/chat/emotes/global');
}

export function fetchChannelChatEmotes(channelSlug: string, channelUserId: number | null): Promise<ChannelChatEmoteCatalog> {
  const query = new URLSearchParams();
  if (channelUserId !== null) {
    query.set('channelUserId', String(channelUserId));
  }

  const queryString = query.toString();
  return request<ChannelChatEmoteCatalog>(`/api/chat/${channelSlug}/emotes${queryString ? `?${queryString}` : ''}`);
}

export function getOAuthLoginUrl(): string {
  return `${API_BASE_URL}/api/auth/login`;
}
