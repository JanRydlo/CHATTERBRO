package com.chatterbro.data.remote

import com.chatterbro.data.bridge.KickBridgeRunner
import com.chatterbro.data.bridge.KickBridgeStatus
import com.chatterbro.data.bridge.KickBridgeStatusStore
import com.chatterbro.data.oauth.KickOAuthService
import com.chatterbro.domain.model.ChannelChat
import com.chatterbro.domain.model.ChannelChatRequest
import com.chatterbro.domain.model.FollowedChannel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class PlaywrightKickBridgeDataSource(
    private val bridgeRunner: KickBridgeRunner,
    private val bridgeStatusStore: KickBridgeStatusStore,
    private val oauthService: KickOAuthService? = null,
) : KickRemoteDataSource {
    override fun getBridgeStatus(): KickBridgeStatus {
        oauthService?.refreshStoredSessionIfNeeded()
        bridgeRunner.reconcileBrowserSessionAvailability()
        val status = bridgeStatusStore.readStatus()
        if (status.hasBrowserSession && status.isAuthenticated) {
            bridgeRunner.prewarmService()
        }

        return status
    }

    override fun startBridgeSession(forceReconnect: Boolean): KickBridgeStatus {
        return bridgeRunner.startLoginBridge(forceReconnect)
    }

    override suspend fun getLiveFollowedChannels(): List<FollowedChannel> {
        return withContext(Dispatchers.IO) {
            bridgeRunner.fetchLiveFollowedChannels()
        }
    }

    override suspend fun getChannelChat(request: ChannelChatRequest): ChannelChat {
        return withContext(Dispatchers.IO) {
            bridgeRunner.fetchChannelChat(request)
        }
    }
}
