package com.chatterbro.domain.repository

import com.chatterbro.domain.model.ChannelChat
import com.chatterbro.domain.model.ChannelChatRequest
import com.chatterbro.domain.model.FollowedChannel

interface KickRepository {
    suspend fun getLiveFollowedChannels(): List<FollowedChannel>

    suspend fun getChannelChat(request: ChannelChatRequest): ChannelChat
}
