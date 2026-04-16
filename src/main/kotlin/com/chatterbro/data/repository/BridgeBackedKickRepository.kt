package com.chatterbro.data.repository

import com.chatterbro.data.remote.KickRemoteDataSource
import com.chatterbro.domain.model.FollowedChannel
import com.chatterbro.domain.repository.KickRepository

class BridgeBackedKickRepository(
    private val remoteDataSource: KickRemoteDataSource,
) : KickRepository {
    override suspend fun getLiveFollowedChannels(): List<FollowedChannel> {
        return remoteDataSource.getLiveFollowedChannels()
    }
}
