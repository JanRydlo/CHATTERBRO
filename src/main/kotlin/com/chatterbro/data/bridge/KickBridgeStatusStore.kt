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
        val now = Instant.now()
        val oauthSession = readOAuthSession()
        val browserSession = readBrowserSession()
        val storedStatus = readStoredStatus()
        val validOAuthSession = oauthSession?.takeIf { !it.isExpired(now) }
        val validBrowserSession = browserSession?.takeIf { !it.isExpired(now) }
        val hasValidBrowserSession = validBrowserSession != null

        val activeSession = when {
            validOAuthSession != null -> ActiveSession(
                expiresAt = validOAuthSession.expiresAt,
                profile = validOAuthSession.profile,
                authMode = KickAuthMode.OAUTH,
                grantedScopes = validOAuthSession.grantedScopes(),
            )

            validBrowserSession != null -> ActiveSession(
                expiresAt = validBrowserSession.expiresAt,
                profile = validBrowserSession.profile,
                authMode = KickAuthMode.BROWSER_SESSION,
                grantedScopes = emptyList(),
            )

            else -> null
        }

        if (storedStatus?.state == BridgeState.RUNNING || storedStatus?.state == BridgeState.ERROR) {
            if (storedStatus.state == BridgeState.RUNNING && activeSession == null && !hasValidBrowserSession) {
                val resetStatus = defaultStatus()
                writeStatus(resetStatus)
                return resetStatus
            }

            return storedStatus.copy(
                hasToken = activeSession != null,
                isAuthenticated = activeSession != null,
                tokenExpiresAt = activeSession?.expiresAt,
                profile = activeSession?.profile,
                oauthEnabled = oauthEnabled,
                hasBrowserSession = hasValidBrowserSession,
                authMode = activeSession?.authMode ?: KickAuthMode.NONE,
                grantedScopes = activeSession?.grantedScopes.orEmpty(),
            )
        }

        if (activeSession != null) {
            return KickBridgeStatus(
                state = BridgeState.READY,
                message = when {
                    storedStatus?.state == BridgeState.READY && storedStatus.message.isNotBlank() -> storedStatus.message
                    activeSession.authMode == KickAuthMode.OAUTH && hasValidBrowserSession ->
                        "Connected as ${activeSession.profile.username} via Kick OAuth. Browser sync is ready for live chat."

                    activeSession.authMode == KickAuthMode.OAUTH ->
                        "Connected as ${activeSession.profile.username} via Kick OAuth."

                    else ->
                        "Connected as ${activeSession.profile.username} via Kick browser session."
                },
                hasToken = true,
                isAuthenticated = true,
                tokenExpiresAt = activeSession.expiresAt,
                profile = activeSession.profile,
                oauthEnabled = oauthEnabled,
                hasBrowserSession = hasValidBrowserSession,
                authMode = activeSession.authMode,
                grantedScopes = activeSession.grantedScopes,
            )
        }

        if (oauthSession?.isExpired(now) == true) {
            return KickBridgeStatus(
                state = BridgeState.IDLE,
                message = "Kick OAuth token expired. Connect again.",
                hasToken = false,
                isAuthenticated = false,
                oauthEnabled = oauthEnabled,
                hasBrowserSession = hasValidBrowserSession,
            )
        }

        if (browserSession?.isExpired(now) == true) {
            return KickBridgeStatus(
                state = BridgeState.IDLE,
                message = if (oauthEnabled) {
                    "Kick browser sync expired. Reconnect it to restore live chat."
                } else {
                    "Kick browser session expired. Connect again."
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
                "Kick OAuth is not configured. Set KICK_CLIENT_ID, KICK_CLIENT_SECRET, and KICK_REDIRECT_URI."
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
        val grantedScopes: List<String>,
    )
}
