package com.chatterbro.data.bridge

import kotlinx.serialization.Serializable
import java.time.Instant

@Serializable
data class KickBridgeSession(
    val token: String,
    val expiresAt: String? = null,
    val profile: KickBridgeProfile,
    val capturedAt: String = Instant.now().toString(),
) {
    fun isExpired(now: Instant = Instant.now()): Boolean {
        val expiration = expiresAt?.let(Instant::parse) ?: return false
        return !expiration.isAfter(now)
    }
}