package com.chatterbro.data.bridge

import kotlinx.serialization.Serializable
import java.time.Instant

@Serializable
data class KickBridgeStatus(
    val state: BridgeState,
    val message: String,
    val hasToken: Boolean,
    val isAuthenticated: Boolean,
    val tokenExpiresAt: String? = null,
    val profile: KickBridgeProfile? = null,
    val updatedAt: String = Instant.now().toString(),
)
