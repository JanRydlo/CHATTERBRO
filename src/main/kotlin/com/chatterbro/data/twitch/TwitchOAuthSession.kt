package com.chatterbro.data.twitch

import kotlinx.serialization.Serializable
import java.time.Instant
import java.util.Locale

@Serializable
data class TwitchProfile(
    val login: String,
    val displayName: String,
    val userId: Long? = null,
    val avatarUrl: String? = null,
    val channelUrl: String = "https://www.twitch.tv/${login.lowercase(Locale.ROOT)}",
)

@Serializable
data class TwitchOAuthSession(
    val accessToken: String,
    val refreshToken: String,
    val tokenType: String = "bearer",
    val scope: List<String> = emptyList(),
    val expiresAt: String? = null,
    val profile: TwitchProfile,
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

    fun grantedScopes(): List<String> {
        return scope
            .map(String::trim)
            .filter(String::isNotBlank)
            .distinct()
    }

    fun hasScope(requiredScope: String): Boolean {
        return grantedScopes().contains(requiredScope)
    }
}

@Serializable
data class TwitchOAuthPendingAuthorization(
    val state: String,
    val createdAt: String = Instant.now().toString(),
)