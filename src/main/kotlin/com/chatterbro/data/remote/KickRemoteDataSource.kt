package com.chatterbro.data.remote

import com.chatterbro.data.bridge.KickBridgeStatus
import com.chatterbro.domain.model.FollowedChannel

interface KickRemoteDataSource {
    fun getBridgeStatus(): KickBridgeStatus

    fun startBridgeSession(): KickBridgeStatus

    suspend fun getLiveFollowedChannels(): List<FollowedChannel>
}
