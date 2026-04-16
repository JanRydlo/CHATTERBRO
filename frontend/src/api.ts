import type { FollowedChannel, KickBridgeStatus } from './types';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });

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

export function startBridge(): Promise<KickBridgeStatus> {
  return request<KickBridgeStatus>('/api/bridge/start', {
    method: 'POST'
  });
}

export function fetchLiveFollowedChannels(): Promise<FollowedChannel[]> {
  return request<FollowedChannel[]>('/api/following/live');
}
