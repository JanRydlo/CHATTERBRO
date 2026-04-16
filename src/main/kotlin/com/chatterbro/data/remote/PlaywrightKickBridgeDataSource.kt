package com.chatterbro.data.remote

import com.chatterbro.data.bridge.KickBridgeRunner
import com.chatterbro.data.bridge.KickBridgeStatus
import com.chatterbro.data.bridge.KickBridgeStatusStore
import com.chatterbro.domain.model.FollowedChannel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class PlaywrightKickBridgeDataSource(
    private val bridgeRunner: KickBridgeRunner,
    private val bridgeStatusStore: KickBridgeStatusStore,
) : KickRemoteDataSource {
    override fun getBridgeStatus(): KickBridgeStatus {
        return bridgeStatusStore.readStatus()
    }

    override fun startBridgeSession(): KickBridgeStatus {
        return bridgeRunner.startLoginBridge()
    }

    override suspend fun getLiveFollowedChannels(): List<FollowedChannel> {
        return withContext(Dispatchers.IO) {
            bridgeRunner.fetchLiveFollowedChannels()
        }
    }
}
