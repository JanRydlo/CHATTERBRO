package com.chatterbro.domain.usecase

import com.chatterbro.domain.model.ChannelChat
import com.chatterbro.domain.repository.KickRepository

class LoadChannelChatUseCase(
    private val kickRepository: KickRepository,
) {
    suspend operator fun invoke(channelSlug: String): ChannelChat {
        return kickRepository.getChannelChat(channelSlug)
    }
}