package com.chatterbro.data.bridge

import kotlinx.serialization.Serializable

@Serializable
data class KickBridgeProfile(
    val username: String,
    val userId: Long? = null,
    val avatarUrl: String? = null,
    val channelUrl: String = "https://kick.com/$username",
)