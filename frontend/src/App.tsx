import { startTransition, useEffect, useState } from 'react';
import { fetchLiveFollowedChannels, getBridgeStatus, startBridge } from './api';
import type { FollowedChannel, KickBridgeStatus } from './types';

const FALLBACK_STATUS: KickBridgeStatus = {
  state: 'IDLE',
  message: 'Kick bridge has not been started yet.',
  hasToken: false,
  isAuthenticated: false,
  tokenExpiresAt: null,
  profile: null,
  updatedAt: new Date(0).toISOString()
};

const BRIDGE_STATE_LABELS: Record<KickBridgeStatus['state'], string> = {
  IDLE: 'Idle',
  RUNNING: 'Running',
  READY: 'Ready',
  ERROR: 'Error'
};

export default function App() {
  const [bridgeStatus, setBridgeStatus] = useState<KickBridgeStatus>(FALLBACK_STATUS);
  const [channels, setChannels] = useState<FollowedChannel[]>([]);
  const [isStartingBridge, setIsStartingBridge] = useState(false);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState('Bridge session is idle. Connect Kick once and the app will keep using the saved session until it expires.');
  const [lastLoadedUsername, setLastLoadedUsername] = useState('');

  useEffect(() => {
    void refreshBridgeStatus();

    const intervalId = window.setInterval(() => {
      void refreshBridgeStatus();
    }, 4000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const isAuthenticated = bridgeStatus.isAuthenticated && Boolean(bridgeStatus.profile);
  const profile = bridgeStatus.profile;
  const liveCountLabel = !lastLoadedUsername
    ? isAuthenticated && profile
      ? `No live followings loaded for ${profile.username} yet.`
      : 'Sign in to load your live followings.'
    : channels.length === 0
      ? `No live followings found for ${lastLoadedUsername}.`
      : `${channels.length} live followings found for ${lastLoadedUsername}.`;
  const sessionExpiryLabel = bridgeStatus.tokenExpiresAt
    ? new Date(bridgeStatus.tokenExpiresAt).toLocaleString()
    : 'No Kick token stored';

  async function refreshBridgeStatus() {
    try {
      const nextStatus = await getBridgeStatus();
      startTransition(() => {
        setBridgeStatus(nextStatus);
      });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Failed to reach the backend bridge status endpoint.';
      setError(message);
    }
  }

  async function handleStartBridge() {
    setIsStartingBridge(true);
    setError(null);

    try {
      const nextStatus = await startBridge();
      startTransition(() => {
        setBridgeStatus(nextStatus);
        setActivity('The Kick login browser was opened. Finish login there. As soon as Kick session data is captured, your profile will appear here.');
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to start the Kick login bridge.');
    } finally {
      setIsStartingBridge(false);
    }
  }

  async function handleLoadChannels() {
    if (!isAuthenticated || !profile) {
      setError('Connect Kick first so the app can use your saved session.');
      return;
    }

    setIsLoadingChannels(true);
    setError(null);

    try {
      const loadedChannels = await fetchLiveFollowedChannels();
      startTransition(() => {
        setChannels(loadedChannels);
        setLastLoadedUsername(profile.username);
        setActivity(
          loadedChannels.length === 0
            ? `Connected as ${profile.username}, but no live followings were found.`
            : `Loaded ${loadedChannels.length} live followings for ${profile.username}.`
        );
      });
      await refreshBridgeStatus();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to load live followings.');
    } finally {
      setIsLoadingChannels(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Chatterbro</p>
          <h1>React dashboard for a browser-backed Kick bridge.</h1>
          <p className="hero-description">
            The UI stays in React. Kotlin runs the local API. Playwright handles the real Kick browser session so the app can survive stricter anti-bot checks.
          </p>
        </div>

        <div className="hero-metrics">
          <div className="metric-card accent-card">
            <span className="metric-label">Kick session</span>
            <strong>{BRIDGE_STATE_LABELS[bridgeStatus.state]}</strong>
            <small>{bridgeStatus.hasToken ? 'Token captured' : 'No token yet'}</small>
          </div>
          <div className="metric-card">
            <span className="metric-label">Active profile</span>
            <strong>{profile?.username || 'Not signed in'}</strong>
            <small>{profile ? 'Kick account is connected' : 'Sign in required'}</small>
          </div>
          <div className="metric-card">
            <span className="metric-label">Token expiry</span>
            <strong>{sessionExpiryLabel}</strong>
            <small>{bridgeStatus.message}</small>
          </div>
        </div>
      </section>

      <section className="content-grid">
        <article className="panel control-panel">
          <div className="panel-header">
            <h2>Session control</h2>
            <span className={`status-pill status-${bridgeStatus.state.toLowerCase()}`}>{BRIDGE_STATE_LABELS[bridgeStatus.state]}</span>
          </div>

          {profile ? (
            <div className="profile-summary">
              <div className="profile-avatar">
                {profile.avatarUrl ? <img src={profile.avatarUrl} alt={profile.username} /> : <span>{profile.username.slice(0, 1).toUpperCase()}</span>}
              </div>
              <div className="profile-copy">
                <strong>{profile.username}</strong>
                <span>Connected Kick profile</span>
              </div>
              <a className="kick-icon-badge" href={profile.channelUrl} target="_blank" rel="noopener noreferrer">
                Kick
              </a>
            </div>
          ) : (
            <div className="message-strip subtle-strip compact-strip">
              <strong>Kick profile</strong>
              <p>No Kick profile is connected yet.</p>
            </div>
          )}

          <div className="action-row">
            {!isAuthenticated ? (
              <button className="primary-button" onClick={handleStartBridge} disabled={isStartingBridge || bridgeStatus.state === 'RUNNING'}>
                {isStartingBridge
                  ? 'Opening Kick login...'
                  : bridgeStatus.state === 'RUNNING'
                    ? 'Waiting for Kick sign-in...'
                    : 'Connect Kick account'}
              </button>
            ) : null}
            <button className="secondary-button" onClick={handleLoadChannels} disabled={isLoadingChannels || !isAuthenticated}>
              {isLoadingChannels ? 'Loading live followings...' : 'Load live followings'}
            </button>
          </div>

          <div className="message-strip">
            <strong>Activity</strong>
            <p>{activity}</p>
          </div>

          <div className="message-strip subtle-strip">
            <strong>Bridge status</strong>
            <p>{bridgeStatus.message}</p>
          </div>

          {isAuthenticated ? (
            <div className="message-strip subtle-strip compact-strip">
              <strong>Session expiry</strong>
              <p>{sessionExpiryLabel}</p>
            </div>
          ) : null}

          {error ? (
            <div className="message-strip error-strip">
              <strong>Backend error</strong>
              <p>{error}</p>
            </div>
          ) : null}
        </article>

        <article className="panel guide-panel">
          <div className="panel-header">
            <h2>Bridge flow</h2>
            <span className="mono-label">saved Kick session</span>
          </div>

          <ol className="step-list">
            <li>Click <strong>Connect Kick account</strong>.</li>
            <li>Finish the Kick login in the browser window opened by the bridge.</li>
            <li>Once your profile appears here, load live followings without another popup.</li>
          </ol>

          <p className="helper-copy">
            Kick blocks raw backend HTTP even with a token, so the app reuses your saved Kick session through a background browser fetch with no visible follow-up login window.
          </p>
        </article>
      </section>

      <section className="panel channel-panel">
        <div className="panel-header">
          <div>
            <h2>Live followings</h2>
            <p className="subtle-copy">{liveCountLabel}</p>
          </div>
          <span className="mono-label">Kick channels</span>
        </div>

        {channels.length === 0 ? (
          <div className="empty-state">
            <p>No live channels are loaded yet.</p>
            <span>Once your Kick session is connected, this panel will list every live followed channel returned by the backend.</span>
          </div>
        ) : (
          <div className="channel-grid">
            {channels.map((channel) => (
              <article className="channel-card" key={channel.channelSlug}>
                <div className="channel-identity">
                  <div className="channel-avatar">
                    {channel.thumbnailUrl ? <img src={channel.thumbnailUrl} alt={channel.displayName} /> : <span>{channel.displayName.slice(0, 1).toUpperCase()}</span>}
                  </div>
                  <div>
                    <h3>{channel.displayName}</h3>
                    <p>{channel.channelSlug}</p>
                  </div>
                </div>

                <div className="channel-actions">
                  <button className="secondary-button" onClick={() => window.open(channel.channelUrl, '_blank', 'noopener,noreferrer')}>
                    Open channel
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => window.open(channel.chatUrl || channel.channelUrl, '_blank', 'noopener,noreferrer')}
                  >
                    Open chat view
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
