package com.chatterbro.domain.model

data class ChannelChatRequest(
    val channelSlug: String,
    val channelId: Long? = null,
    val channelUserId: Long? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val fast: Boolean = false,
)
