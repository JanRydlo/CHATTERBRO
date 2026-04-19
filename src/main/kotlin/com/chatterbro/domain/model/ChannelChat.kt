package com.chatterbro.domain.model

import kotlinx.serialization.Serializable

@Serializable
data class ChannelChat(
	val channelSlug: String,
	val channelId: Long? = null,
	val channelUserId: Long? = null,
	val chatroomId: Long? = null,
	val displayName: String,
	val channelUrl: String,
	val avatarUrl: String? = null,
	val cursor: String? = null,
	val messages: List<ChannelChatMessage> = emptyList(),
	val pinnedMessage: ChannelChatMessage? = null,
	val subscriberBadgeImageUrlsByMonths: Map<Int, String> = emptyMap(),
	val updatedAt: String,
)

@Serializable
data class ChannelChatMessage(
	val id: String,
	val content: String,
	val type: String,
	val createdAt: String? = null,
	val threadParentId: String? = null,
	val sender: ChannelChatSender,
)

@Serializable
data class ChannelChatSender(
	val id: Long? = null,
	val username: String,
	val slug: String,
	val color: String? = null,
	val badges: List<ChannelChatBadge> = emptyList(),
)

@Serializable
data class ChannelChatBadge(
	val type: String,
	val text: String,
	val count: Int? = null,
	val imageUrl: String? = null,
)
