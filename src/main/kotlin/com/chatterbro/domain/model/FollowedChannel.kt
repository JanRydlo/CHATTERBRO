package com.chatterbro.domain.model

import kotlinx.serialization.Serializable

@Serializable
data class FollowedChannel(
    val channelSlug: String,
    val displayName: String,
    val isLive: Boolean = true,
    val channelUrl: String = "https://kick.com/$channelSlug",
    val chatUrl: String? = channelUrl,
    val thumbnailUrl: String? = null,
)
