package com.chatterbro.api.dto

import kotlinx.serialization.Serializable

@Serializable
data class SendChannelChatMessageRequest(
    val content: String,
    val broadcasterUserId: Long? = null,
    val replyToMessageId: String? = null,
)