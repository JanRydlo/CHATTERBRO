package com.chatterbro.domain.usecase

import com.chatterbro.domain.model.FollowedChannel
import com.chatterbro.domain.repository.KickRepository

class LoadLiveFollowedChannelsUseCase(
    private val kickRepository: KickRepository,
) {
    suspend operator fun invoke(): List<FollowedChannel> {
        return kickRepository
            .getLiveFollowedChannels()
            .filter(FollowedChannel::isLive)
    }
}
