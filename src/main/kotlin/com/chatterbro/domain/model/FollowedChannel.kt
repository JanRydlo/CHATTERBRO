package com.chatterbro.domain.model

import kotlinx.serialization.Serializable

@Serializable
data class FollowedChannel(
    val provider: String = "kick",
    val channelSlug: String,
    val displayName: String,
    val isLive: Boolean = true,
    val channelUrl: String = "https://kick.com/$channelSlug",
    val chatUrl: String? = channelUrl,
    val thumbnailUrl: String? = null,
    val broadcasterUserId: Long? = null,
    val channelId: Long? = null,
    val chatroomId: Long? = null,
    val viewerCount: Int? = null,
    val streamTitle: String? = null,
    val categoryName: String? = null,
    val tags: List<String> = emptyList(),
    val subscriberBadgeImageUrlsByMonths: Map<Int, String> = emptyMap(),
)
