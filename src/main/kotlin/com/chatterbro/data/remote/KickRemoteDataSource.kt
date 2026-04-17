package com.chatterbro.data.remote

import com.chatterbro.data.bridge.KickBridgeStatus
import com.chatterbro.domain.model.ChannelChat
import com.chatterbro.domain.model.FollowedChannel

interface KickRemoteDataSource {
    fun getBridgeStatus(): KickBridgeStatus

    fun startBridgeSession(forceReconnect: Boolean = false): KickBridgeStatus

    suspend fun getLiveFollowedChannels(): List<FollowedChannel>

    suspend fun getChannelChat(channelSlug: String): ChannelChat
}
