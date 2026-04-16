package com.chatterbro.data.bridge

import com.chatterbro.data.oauth.KickOAuthSession
import kotlinx.serialization.json.Json
import java.time.Instant
import kotlin.io.path.exists
import kotlin.io.path.readText
import kotlin.io.path.writeText

class KickBridgeStatusStore(
    private val paths: KickBridgePaths,
    private val oauthEnabled: Boolean,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
    }

    init {
        paths.ensureDirectories()
    }

    fun readStatus(): KickBridgeStatus {
        val oauthSession = readOAuthSession()
        val browserSession = readBrowserSession()
        val activeSession = when {
            oauthSession != null && !oauthSession.isExpired() -> ActiveSession(
                expiresAt = oauthSession.expiresAt,
                profile = oauthSession.profile,
                authMode = KickAuthMode.OAUTH,
            )
            browserSession != null && !browserSession.isExpired() -> ActiveSession(
                expiresAt = browserSession.expiresAt,
                profile = browserSession.profile,
                authMode = KickAuthMode.BROWSER_SESSION,
            )
            else -> null
        }
        val hasValidBrowserSession = browserSession != null && !browserSession.isExpired()
        val storedStatus = readStoredStatus()

        if (storedStatus != null && (storedStatus.state == BridgeState.RUNNING || storedStatus.state == BridgeState.ERROR)) {
            return storedStatus.copy(
                hasToken = activeSession != null,
                isAuthenticated = activeSession != null,
                tokenExpiresAt = activeSession?.expiresAt,
                profile = activeSession?.profile,
                oauthEnabled = oauthEnabled,
                hasBrowserSession = hasValidBrowserSession,
                authMode = activeSession?.authMode ?: KickAuthMode.NONE,
            )
        }

        if (activeSession != null) {
            return KickBridgeStatus(
                state = BridgeState.READY,
                message = storedStatus?.message?.takeIf {
                    storedStatus.state == BridgeState.READY && it.isNotBlank()
                } ?: if (activeSession.authMode == KickAuthMode.OAUTH && !hasValidBrowserSession) {
                    "Connected as ${activeSession.profile.username} via Kick OAuth. Followings and chat still need a one-time website session sync."
                } else {
                    "Connected as ${activeSession.profile.username}."
                },
                hasToken = true,
                isAuthenticated = true,
                tokenExpiresAt = activeSession.expiresAt,
                profile = activeSession.profile,
                oauthEnabled = oauthEnabled,
                hasBrowserSession = hasValidBrowserSession,
                authMode = activeSession.authMode,
            )
        }

        if (oauthSession?.isExpired(Instant.now()) == true) {
            return KickBridgeStatus(
                state = BridgeState.IDLE,
                message = "Kick OAuth token expired. Connect again.",
                hasToken = false,
                isAuthenticated = false,
                oauthEnabled = oauthEnabled,
                hasBrowserSession = hasValidBrowserSession,
            )
        }

        if (browserSession?.isExpired(Instant.now()) == true) {
            return KickBridgeStatus(
                state = BridgeState.IDLE,
                message = if (oauthEnabled) {
                    "Kick website session expired. Followings and chat need a new browser sync."
                } else {
                    "Kick token expired. Sign in again."
                },
                hasToken = false,
                isAuthenticated = false,
                oauthEnabled = oauthEnabled,
                hasBrowserSession = false,
            )
        }

        return defaultStatus()
    }

    fun writeStatus(status: KickBridgeStatus) {
        paths.ensureDirectories()
        paths.statusFile.writeText(json.encodeToString(status))
    }

    private fun readStoredStatus(): KickBridgeStatus? {
        return if (paths.statusFile.exists()) {
            json.decodeFromString<KickBridgeStatus>(paths.statusFile.readText())
        } else {
            null
        }
    }

    fun hasValidBrowserSession(now: Instant = Instant.now()): Boolean {
        return readBrowserSession()?.isExpired(now) == false
    }

    private fun readBrowserSession(): KickBridgeSession? {
        return if (paths.sessionFile.exists()) {
            json.decodeFromString<KickBridgeSession>(paths.sessionFile.readText())
        } else {
            null
        }
    }

    private fun readOAuthSession(): KickOAuthSession? {
        return if (paths.oauthSessionFile.exists()) {
            json.decodeFromString<KickOAuthSession>(paths.oauthSessionFile.readText())
        } else {
            null
        }
    }

    private fun defaultStatus(): KickBridgeStatus {
        return KickBridgeStatus(
            state = BridgeState.IDLE,
            message = if (oauthEnabled) {
                "Kick OAuth has not been started yet."
            } else {
                "Kick bridge has not been started yet."
            },
            hasToken = false,
            isAuthenticated = false,
            oauthEnabled = oauthEnabled,
            hasBrowserSession = false,
        )
    }

    private data class ActiveSession(
        val expiresAt: String?,
        val profile: KickBridgeProfile,
        val authMode: KickAuthMode,
    )
}
