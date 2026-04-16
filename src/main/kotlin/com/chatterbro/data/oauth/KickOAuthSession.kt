package com.chatterbro.data.oauth

import com.chatterbro.data.bridge.KickBridgeProfile
import kotlinx.serialization.Serializable
import java.time.Instant

@Serializable
data class KickOAuthSession(
    val accessToken: String,
    val refreshToken: String,
    val tokenType: String = "Bearer",
    val scope: String? = null,
    val expiresAt: String? = null,
    val profile: KickBridgeProfile,
    val capturedAt: String = Instant.now().toString(),
) {
    fun isExpired(now: Instant = Instant.now()): Boolean {
        val expiration = expiresAt?.let(Instant::parse) ?: return false
        return !expiration.isAfter(now)
    }

    fun shouldRefresh(now: Instant = Instant.now(), skewSeconds: Long = 60): Boolean {
        val expiration = expiresAt?.let(Instant::parse) ?: return false
        return !expiration.minusSeconds(skewSeconds).isAfter(now)
    }
}

@Serializable
data class KickOAuthPendingAuthorization(
    val state: String,
    val codeVerifier: String,
    val createdAt: String = Instant.now().toString(),
)