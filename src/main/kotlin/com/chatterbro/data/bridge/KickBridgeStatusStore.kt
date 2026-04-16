package com.chatterbro.data.bridge

import kotlinx.serialization.json.Json
import java.time.Instant
import kotlin.io.path.exists
import kotlin.io.path.readText
import kotlin.io.path.writeText

class KickBridgeStatusStore(
    private val paths: KickBridgePaths,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
    }

    init {
        paths.ensureDirectories()
    }

    fun readStatus(): KickBridgeStatus {
        val session = readSession()

        if (session != null && !session.isExpired()) {
            val storedStatus = readStoredStatus()

            return KickBridgeStatus(
                state = BridgeState.READY,
                message = storedStatus?.message?.takeIf {
                    storedStatus.state == BridgeState.READY && it.isNotBlank()
                } ?: "Connected as ${session.profile.username}.",
                hasToken = true,
                isAuthenticated = true,
                tokenExpiresAt = session.expiresAt,
                profile = session.profile,
            )
        }

        val storedStatus = readStoredStatus()
        if (storedStatus != null && (storedStatus.state == BridgeState.RUNNING || storedStatus.state == BridgeState.ERROR)) {
            return storedStatus.copy(
                hasToken = false,
                isAuthenticated = false,
                tokenExpiresAt = null,
                profile = null,
            )
        }

        if (session?.isExpired(Instant.now()) == true) {
            return KickBridgeStatus(
                state = BridgeState.IDLE,
                message = "Kick token expired. Sign in again.",
                hasToken = false,
                isAuthenticated = false,
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

    private fun readSession(): KickBridgeSession? {
        return if (paths.sessionFile.exists()) {
            json.decodeFromString<KickBridgeSession>(paths.sessionFile.readText())
        } else {
            null
        }
    }

    private fun defaultStatus(): KickBridgeStatus {
        return KickBridgeStatus(
            state = BridgeState.IDLE,
            message = "Kick bridge has not been started yet.",
            hasToken = false,
            isAuthenticated = false,
        )
    }
}
