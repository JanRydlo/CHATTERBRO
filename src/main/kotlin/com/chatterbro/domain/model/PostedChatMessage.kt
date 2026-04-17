package com.chatterbro.domain.model

import kotlinx.serialization.Serializable

@Serializable
data class PostedChatMessage(
    val isSent: Boolean,
    val messageId: String,
)