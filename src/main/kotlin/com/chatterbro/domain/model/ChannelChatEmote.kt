package com.chatterbro.domain.model

import kotlinx.serialization.Serializable

@Serializable
data class ChannelChatEmoteCatalog(
    val channelSlug: String,
    val channelUserId: Long? = null,
    val emotes: List<ChannelChatEmote> = emptyList(),
    val updatedAt: String,
)

@Serializable
data class ChannelChatEmote(
    val code: String,
    val imageUrl: String,
    val provider: String,
    val animated: Boolean,
    val width: Int? = null,
    val height: Int? = null,
)