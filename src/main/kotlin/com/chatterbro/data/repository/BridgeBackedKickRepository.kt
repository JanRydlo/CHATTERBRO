package com.chatterbro.data.repository

import com.chatterbro.data.remote.KickRemoteDataSource
import com.chatterbro.domain.model.ChannelChat
import com.chatterbro.domain.model.ChannelChatRequest
import com.chatterbro.domain.model.FollowedChannel
import com.chatterbro.domain.repository.KickRepository

class BridgeBackedKickRepository(
    private val remoteDataSource: KickRemoteDataSource,
) : KickRepository {
    override suspend fun getLiveFollowedChannels(): List<FollowedChannel> {
        return remoteDataSource.getLiveFollowedChannels()
    }

    override suspend fun getChannelChat(request: ChannelChatRequest): ChannelChat {
        return remoteDataSource.getChannelChat(request)
    }
}
